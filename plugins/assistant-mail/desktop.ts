import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AgendaEditError } from "./agenda-store.js";
import { smtpChannel } from "./proposal-contract.js";
import { EventEmitter } from "node:events";
import { renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { KeychainMailCredentials, type MailCredentials } from "./credentials.js";
import { MailReceiver, type MailState } from "./receiver.js";
import { AssistantMailStore, type AssistantBinding, type MailAnalysis, type MailProcessingStatus } from "./store.js";
import { DEFAULT_MAIL_POLL_INTERVAL, isMailPollInterval, type BridgeMailAttachmentRef, type MailPollInterval } from "../../packages/protocol/src/assistant-mail.js";
import { attachmentText, MAIL_TEXT_MAX_BYTES, supportsAttachmentText } from "./attachment-text.js";
import { MailAttachmentError, parseMail } from "./mime.js";
export { MailAttachmentError, MailBodyParseError } from "./mime.js";

export interface MailAccount {
  host: string;
  port: number;
  user: string;
}

const savedSmtpChannel = smtpChannel.extend({ version: z.uuid() });
type SavedSmtpChannel = z.output<typeof savedSmtpChannel>;
type SavedAccount = MailAccount & { enabled: boolean; pollIntervalSeconds: MailPollInterval; smtp?: SavedSmtpChannel };
export type MailAccountStatus = Omit<SavedAccount, "smtp"> & { accountKey: string; state: MailState; errorCode?: string;
  smtp?: Omit<SavedSmtpChannel, "version"> };
export type MailAccountFailure = { accountKey: string; errorCode: string };

function parseAccount(value: MailAccount): MailAccount {
  if (typeof value.host !== "string" || !value.host.trim() || /\s/.test(value.host.trim()) ||
      typeof value.user !== "string" || !value.user.trim() || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error("Invalid IMAP account");
  }
  return { host: value.host.trim().toLowerCase(), port: value.port, user: value.user.trim() };
}

function accountKey(account: MailAccount): string {
  return createHash("sha256").update(JSON.stringify([account.host, account.port, account.user])).digest("hex");
}

/** One instance belongs to the background service. Clients borrow this business API, never its connections. */
export class AssistantMailService extends EventEmitter {
  private readonly store: AssistantMailStore;
  private readonly attachmentCMapUrl: string | undefined;
  private readonly credentials: MailCredentials;
  private readonly createClient: (options: ImapFlowOptions) => ImapFlow;
  private readonly accounts = new Map<string, { config: SavedAccount; receiver: MailReceiver }>();
  private readonly removingAccounts = new Map<string, MailReceiver>();
  private readonly accountMutations = new Map<string, Promise<void>>();
  private accountConfigError?: "mail_account_config_unavailable";
  private closed = false;
  private readonly mimeBackfillAbort = new AbortController();
  private mimeBackfill?: Promise<void>;

  constructor(options: {
    userDataPath: string;
    attachmentCMapUrl?: string;
    credentials?: MailCredentials;
    createClient?: (options: ImapFlowOptions) => ImapFlow;
  }) {
    super();
    this.attachmentCMapUrl = options.attachmentCMapUrl;
    this.store = new AssistantMailStore(options.userDataPath);
    this.credentials = options.credentials ?? new KeychainMailCredentials();
    this.createClient = options.createClient ?? ((config) => new ImapFlow(config));
  }

  async initialize(extendStore?: (database: import("node:sqlite").DatabaseSync) => void, startReceivers = true): Promise<void> {
    await this.store.initialize(extendStore);
    this.mimeBackfill = this.store.backfillMimeProjections(this.mimeBackfillAbort.signal)
      .then(updated => { if (updated) this.emit("changed", true); })
      .catch(error => { this.emit("error", error); });
    let configs: SavedAccount[];
    try {
      let saved: string | undefined;
      for (const name of ["accounts.json", "account.json"]) {
        saved = await readFile(join(this.store.directory, name), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (saved !== undefined) break;
      }
      if (saved === undefined) return;
      const value = JSON.parse(saved) as SavedAccount | SavedAccount[];
      configs = (Array.isArray(value) ? value : [value]).map(config => {
        if (typeof config?.enabled !== "boolean") throw new Error("Invalid saved IMAP account");
        const interval = config.pollIntervalSeconds;
        if (interval !== undefined && !isMailPollInterval(interval)) throw new Error("Invalid saved polling interval");
        return { ...parseAccount(config), enabled: config.enabled, pollIntervalSeconds: interval === undefined ? DEFAULT_MAIL_POLL_INTERVAL : interval,
          ...(config.smtp ? { smtp: savedSmtpChannel.parse(config.smtp) } : {}) };
      });
    } catch {
      this.accountConfigError = "mail_account_config_unavailable";
      return;
    }
    for (const config of configs) this.addAccount(accountKey(config), config);
    if (startReceivers) this.startReceivers();
  }

  startReceivers(): void {
    for (const { config, receiver } of this.accounts.values()) if (config.enabled) receiver.start();
  }

  status(): {
    state: MailState; credentialsSupported: boolean; accounts: MailAccountStatus[];
    account?: SavedAccount; accountKey?: string; errorCode?: string;
    accountConfigError?: "mail_account_config_unavailable";
    history: { available: boolean; loading: boolean; failed: boolean };
  } {
    const receivers = Array.from(this.accounts.values()).filter(({ config }) => config.enabled && !this.closed).map(({ receiver }) => receiver);
    const accounts = Array.from(this.accounts, ([key, { config: { smtp, ...config }, receiver }]): MailAccountStatus => ({
      ...config, accountKey: key,
      ...(smtp ? { smtp: { host: smtp.host, port: smtp.port, security: smtp.security, user: smtp.user, from: smtp.from } } : {}),
      state: this.closed ? "closed" : config.enabled ? receiver.state : "disabled",
      ...(config.enabled && !this.closed && receiver.errorCode ? { errorCode: receiver.errorCode } : {}),
    }));
    const current = accounts.find(account => account.state === "connected" || account.state === "polling") ?? accounts.find(account => account.enabled) ?? accounts[0];
    return {
      state: this.closed ? "closed" : this.accountConfigError ? "error" : current?.state ?? "disabled",
      credentialsSupported: this.credentials.supported, accounts,
      history: { available: receivers.some(receiver => receiver.hasOlderMail), loading: receivers.some(receiver => receiver.historyLoading),
        failed: receivers.some(receiver => receiver.historyFailed) },
      ...(this.accountConfigError ? { accountConfigError: this.accountConfigError } : {}),
      ...(current ? { account: { ...this.accounts.get(current.accountKey)!.config }, accountKey: current.accountKey } : {}),
      ...(current?.errorCode ? { errorCode: current.errorCode } : {}),
    };
  }

  diagnosticsGauges(): { configured: boolean; unreadCount: number } {
    return { configured: this.accounts.size > 0, unreadCount: this.store.unreadCount() };
  }

  async enable(input: { host: string; port?: number; user: string; password: string }): Promise<void> {
    if (!this.credentials.supported) throw new Error("mail_credentials_unsupported");
    const config: SavedAccount = { ...parseAccount({ host: input.host, port: input.port ?? 993, user: input.user }), enabled: true,
      pollIntervalSeconds: DEFAULT_MAIL_POLL_INTERVAL };
    const key = accountKey(config);
    await this.mutateAccount(key, async () => {
      const existing = this.accounts.get(key);
      if (existing) {
        await this.savePassword(key, input.password);
        if (existing.config.enabled) await this.restartReceiver(key);
        else await this.updateEnabled(key, true);
        return;
      }
      this.saveAccounts([...Array.from(this.accounts.values(), account => account.config), config]);
      const account = this.addAccount(key, config);
      try {
        await this.savePassword(key, input.password);
      } catch (error) {
        try {
          this.saveAccounts(Array.from(this.accounts.values()).filter(entry => entry !== account).map(entry => entry.config));
          this.accounts.delete(key);
        } finally {
          this.emit("changed");
        }
        throw error;
      }
      account.receiver.start();
    });
  }

  replacePassword(accountKey: string, password: string): Promise<void> {
    return this.mutateAccount(accountKey, async () => {
      this.requireAccount(accountKey);
      await this.savePassword(accountKey, password);
      await this.restartReceiver(accountKey);
    });
  }

  setSmtp(accountKey: string, input: z.output<typeof smtpChannel> & { credential: string } | null): Promise<void> {
    return this.mutateAccount(accountKey, async () => {
      if (!this.credentials.supported) throw new Error("mail_credentials_unsupported");
      const { config } = this.requireAccount(accountKey);
      const previous = config.smtp;
      let next: SavedSmtpChannel | undefined;
      if (input) {
        const { credential, ...fields } = input;
        if (previous && previous.host === fields.host && previous.port === fields.port && previous.security === fields.security &&
          previous.user === fields.user && previous.from === fields.from) {
          await this.savePassword(`smtp-${previous.version}`, credential);
          return;
        }
        next = { ...fields, version: randomUUID() };
        await this.savePassword(`smtp-${next.version}`, credential);
      } else if (!previous) return;
      const persist = (smtp: SavedSmtpChannel | undefined) => {
        const { smtp: _smtp, ...receiving } = config;
        this.saveAccounts(Array.from(this.accounts, ([key, entry]) => key === accountKey
          ? { ...receiving, ...(smtp ? { smtp } : {}) } : entry.config));
        if (smtp) config.smtp = smtp;
        else delete config.smtp;
      };
      try { persist(next); }
      catch (error) {
        if (next) await this.credentials.delete(`smtp-${next.version}`);
        throw error;
      }
      try {
        if (previous) await this.credentials.delete(`smtp-${previous.version}`);
      } catch {
        persist(previous);
        if (next) await this.credentials.delete(`smtp-${next.version}`);
        throw new Error("mail_credentials_unavailable");
      }
      this.emit("changed");
    });
  }

  smtpAccount(key: string) {
    const config = this.accounts.get(key)?.config;
    if (config?.enabled && config.smtp && this.credentials.supported) return { smtp: config.smtp, label: `${config.user} · ${config.host}` };
  }

  async smtpPassword(version: string): Promise<string | undefined> {
    return this.credentials.get(`smtp-${version}`).catch((error: unknown) => {
      if (error instanceof Error && error.message === "mail_credentials_unavailable") return undefined;
      throw error;
    });
  }

  replySource(accountKey: string, mailRefId: string): { subject: string; source: Readable } {
    const event = this.store.event(mailRefId);
    if (!event || event.accountKey !== accountKey) throw new AgendaEditError("NOT_FOUND", "此账号下找不到原邮件。");
    return { subject: event.subject, source: this.store.stream(mailRefId)! };
  }

  setAccountEnabled(accountKey: string, enabled: boolean): Promise<void> {
    return this.mutateAccount(accountKey, () => this.updateEnabled(accountKey, enabled));
  }

  setAccountPollInterval(accountKey: string, pollIntervalSeconds: MailPollInterval): Promise<void> {
    return this.mutateAccount(accountKey, async () => {
      const { config, receiver } = this.requireAccount(accountKey);
      if (config.pollIntervalSeconds === pollIntervalSeconds) return;
      this.saveAccounts(Array.from(this.accounts, ([key, { config }]) => key === accountKey ? { ...config, pollIntervalSeconds } : config));
      config.pollIntervalSeconds = pollIntervalSeconds;
      if (config.enabled && receiver.state === "unsupported") await this.restartReceiver(accountKey);
      else if (config.enabled && receiver.state === "polling") receiver.resume();
      this.emit("changed");
    });
  }

  private async updateEnabled(accountKey: string, enabled: boolean): Promise<void> {
    const account = this.requireAccount(accountKey);
    if (enabled && !this.credentials.supported) throw new Error("mail_credentials_unsupported");
    if (account.config.enabled === enabled) return;
    this.saveAccounts(Array.from(this.accounts, ([key, { config }]) => key === accountKey ? { ...config, enabled } : config));
    account.config.enabled = enabled;
    if (enabled) {
      await this.restartReceiver(accountKey);
    } else {
      const stopping = account.receiver.stop();
      this.emit("changed");
      await stopping;
    }
  }

  removeAccount(accountKey: string): Promise<void> {
    return this.mutateAccount(accountKey, async () => {
      const account = this.requireAccount(accountKey);
      if (!this.credentials.supported) throw new Error("mail_credentials_unsupported");
      const smtpKey = account.config.smtp && `smtp-${account.config.smtp.version}`;
      const smtpPassword = smtpKey ? await this.credentials.get(smtpKey) : undefined;
      this.saveAccounts(Array.from(this.accounts.values()).filter(entry => entry !== account).map(entry => entry.config));
      this.accounts.delete(accountKey);
      this.removingAccounts.set(accountKey, account.receiver);
      let deletedSmtp = false;
      try {
        if (smtpKey) {
          await this.credentials.delete(smtpKey);
          deletedSmtp = true;
        }
        await this.credentials.delete(accountKey);
      } catch {
        if (deletedSmtp && smtpPassword) await this.savePassword(smtpKey!, smtpPassword);
        this.saveAccounts([...Array.from(this.accounts.values(), entry => entry.config), account.config]);
        this.accounts.set(accountKey, account);
        this.emit("changed");
        throw new Error("mail_credentials_unavailable");
      } finally {
        this.removingAccounts.delete(accountKey);
        if (!this.accounts.has(accountKey)) {
          const stopping = account.receiver.stop();
          this.emit("changed");
          await stopping;
        }
      }
    });
  }

  async disable(): Promise<void> {
    await Promise.all(Array.from(this.accounts.keys(), key => this.setAccountEnabled(key, false)));
  }

  resume(): void {
    for (const { config, receiver } of this.accounts.values()) if (config.enabled) receiver.resume();
  }

  requestOlder(): void {
    const receivers = Array.from(this.accounts.values()).filter(({ config }) => config.enabled).map(({ receiver }) => receiver);
    if (receivers.some(receiver => receiver.historyLoading)) return;
    if (receivers.map(receiver => receiver.requestOlder()).some(Boolean)) this.emit("changed");
  }

  get triggers() { return this.store.triggers; }
  binding(): AssistantBinding | undefined { return this.store.binding(); }
  setBinding(binding: AssistantBinding): void { this.store.setBinding(binding); this.emit("changed", true); }
  setAutomaticDelivery(enabled: boolean): void { this.store.setAutomaticDelivery(enabled); this.emit("changed", true); }
  page(...options: Parameters<AssistantMailStore["page"]>): ReturnType<AssistantMailStore["page"]> { return this.store.page(...options); }
  read(mailRefId: string): ReturnType<AssistantMailStore["read"]> { return this.store.read(mailRefId); }
  event(mailRefId: string) { return this.store.event(mailRefId); }
  async readEvent(mailRefId: string) {
    const event = this.store.event(mailRefId);
    if (!event) return undefined;
    const parsed = await parseMail(this.store.stream(mailRefId)!);
    this.store.completeMimeProjection(mailRefId, parsed);
    if (parsed.bodyError) throw parsed.bodyError;
    return { event, bodyText: parsed.bodyText, attachments: parsed.attachments, attachmentCount: parsed.attachmentCount };
  }
  attachment({ mailRefId, attachmentId }: BridgeMailAttachmentRef) {
    const attachment = this.store.event(mailRefId)?.attachments.find(part => part.attachmentId === attachmentId);
    if (!attachment) throw new MailAttachmentError("MAIL_ATTACHMENT_NOT_FOUND", "邮件附件不存在。");
    return attachment;
  }
  async attachmentBytes({ mailRefId, attachmentId }: BridgeMailAttachmentRef, maxBytes: number): Promise<Buffer> {
    const { size } = this.attachment({ mailRefId, attachmentId });
    if (size > maxBytes) throw new MailAttachmentError("MAIL_ATTACHMENT_TOO_LARGE", "邮件附件超过大小上限。");
    const { bytes, tooLarge } = await parseMail(this.store.stream(mailRefId)!, { attachmentId, maxBytes });
    if (tooLarge) throw new MailAttachmentError("MAIL_ATTACHMENT_TOO_LARGE", "邮件附件超过大小上限。");
    if (!bytes || bytes.byteLength !== size) throw new MailAttachmentError("MAIL_ATTACHMENT_NOT_FOUND", "邮件附件不存在或已变化。");
    return bytes;
  }
  async readAttachment(ref: BridgeMailAttachmentRef) {
    const attachment = this.attachment(ref);
    if (!supportsAttachmentText(attachment.mimeType)) {
      throw new MailAttachmentError("MAIL_ATTACHMENT_UNSUPPORTED", "此附件格式不支持提取文本。");
    }
    return { attachment, text: await attachmentText(await this.attachmentBytes(ref, MAIL_TEXT_MAX_BYTES), attachment.mimeType, this.attachmentCMapUrl, attachment.charset) };
  }
  updateAnalysis(mailRefId: string, analysis: MailAnalysis) {
    const event = this.store.updateAnalysis(mailRefId, analysis);
    if (event) this.emit("changed", true, true);
    return event;
  }
  setProcessingStatus(mailRefId: string, status: MailProcessingStatus) {
    const event = this.store.setProcessingStatus(mailRefId, status);
    if (event) this.emit("changed", true);
    return event;
  }

  private async mutateAccount(key: string, mutate: () => Promise<void>): Promise<void> {
    if (this.accountConfigError) throw new Error(this.accountConfigError);
    const previous = this.accountMutations.get(key);
    // A failed operation still releases its turn so the next request can run.
    const pending = (previous?.catch(() => {}) ?? Promise.resolve()).then(mutate);
    this.accountMutations.set(key, pending);
    try {
      await pending;
    } finally {
      if (this.accountMutations.get(key) === pending) this.accountMutations.delete(key);
    }
  }

  private requireAccount(accountKey: string) {
    const account = this.accounts.get(accountKey);
    if (!account) throw new Error("mail_account_not_found");
    return account;
  }

  private async restartReceiver(accountKey: string): Promise<void> {
    const account = this.accounts.get(accountKey);
    if (!account?.config.enabled) return;
    await account.receiver.stop();
    if (account.config.enabled && this.accounts.get(accountKey) === account && !this.closed) account.receiver.start();
  }

  private addAccount(accountKey: string, config: SavedAccount) {
    const receiver = new MailReceiver(accountKey, config, this.store, this.credentials, this.createClient, {
      changed: mailDataChanged => this.emit("changed", mailDataChanged), mail: event => this.emit("mail", event),
      error: error => this.emit("error", error, { accountKey, errorCode: receiver.errorCode ?? "mail_receiver_failed" } satisfies MailAccountFailure),
    });
    const account = { config, receiver };
    this.accounts.set(accountKey, account);
    return account;
  }

  private saveAccounts(configs: SavedAccount[]): void {
    const path = join(this.store.directory, "accounts.json");
    const content = JSON.stringify(configs);
    // The whole account list is one file. Replace it before publishing the in-memory change.
    try {
      writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch {
      throw new Error("mail_storage_failed");
    }
  }

  private async savePassword(accountKey: string, password: string): Promise<void> {
    if (!this.credentials.supported) throw new Error("mail_credentials_unsupported");
    if (typeof password !== "string" || !password) throw new Error("Invalid IMAP password");
    await this.credentials.set(accountKey, password).catch((error: unknown) => {
      if (error instanceof Error && error.message === "mail_password_too_long") throw new Error(error.message);
      throw new Error("mail_credentials_unavailable");
    });
  }

  async close(): Promise<void> {
    this.mimeBackfillAbort.abort();
    try {
      await this.mimeBackfill;
      await Promise.all([...Array.from(this.accounts.values(), ({ receiver }) => receiver), ...this.removingAccounts.values()].map(receiver => receiver.stop()));
    } finally {
      this.store.close();
      this.closed = true;
      this.emit("changed");
    }
  }
}
