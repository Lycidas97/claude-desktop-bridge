import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { KeychainMailCredentials, type MailCredentials } from "./credentials.js";
import { MailReceiver, type MailState } from "./receiver.js";
import { AssistantMailStore, type AssistantBinding, type MailAnalysis, type MailProcessingStatus } from "./store.js";
import { mailBodyText } from "./mime.js";
export { MailBodyParseError } from "./mime.js";

export interface MailAccount {
  host: string;
  port: number;
  user: string;
}

type SavedAccount = MailAccount & { enabled: boolean };
export type MailAccountStatus = SavedAccount & { accountKey: string; state: MailState; errorCode?: string };

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
  private readonly credentials: MailCredentials;
  private readonly createClient: (options: ImapFlowOptions) => ImapFlow;
  private readonly accounts = new Map<string, { config: SavedAccount; receiver: MailReceiver }>();
  private readonly removingAccounts = new Map<string, MailReceiver>();
  private readonly accountMutations = new Map<string, Promise<void>>();
  private accountConfigError?: "mail_account_config_unavailable";
  private closed = false;

  constructor(options: {
    userDataPath: string;
    credentials?: MailCredentials;
    createClient?: (options: ImapFlowOptions) => ImapFlow;
  }) {
    super();
    this.store = new AssistantMailStore(options.userDataPath);
    this.credentials = options.credentials ?? new KeychainMailCredentials();
    this.createClient = options.createClient ?? ((config) => new ImapFlow(config));
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
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
        return { ...parseAccount(config), enabled: config.enabled };
      });
    } catch {
      this.accountConfigError = "mail_account_config_unavailable";
      return;
    }
    for (const config of configs) this.addAccount(accountKey(config), config);
    for (const { config, receiver } of this.accounts.values()) if (config.enabled) receiver.start();
  }

  status(): {
    state: MailState; credentialsSupported: boolean; accounts: MailAccountStatus[];
    account?: SavedAccount; accountKey?: string; errorCode?: string;
    accountConfigError?: "mail_account_config_unavailable";
  } {
    const accounts = Array.from(this.accounts, ([key, { config, receiver }]): MailAccountStatus => ({
      ...config, accountKey: key,
      state: this.closed ? "closed" : config.enabled ? receiver.state : "disabled",
      ...(config.enabled && !this.closed && receiver.errorCode ? { errorCode: receiver.errorCode } : {}),
    }));
    const current = accounts.find(account => account.state === "connected") ?? accounts.find(account => account.enabled) ?? accounts[0];
    return {
      state: this.closed ? "closed" : this.accountConfigError ? "error" : current?.state ?? "disabled",
      credentialsSupported: this.credentials.supported, accounts,
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
    const config = { ...parseAccount({ host: input.host, port: input.port ?? 993, user: input.user }), enabled: true };
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

  setAccountEnabled(accountKey: string, enabled: boolean): Promise<void> {
    return this.mutateAccount(accountKey, () => this.updateEnabled(accountKey, enabled));
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
      this.saveAccounts(Array.from(this.accounts.values()).filter(entry => entry !== account).map(entry => entry.config));
      this.accounts.delete(accountKey);
      this.removingAccounts.set(accountKey, account.receiver);
      try {
        await this.credentials.delete(accountKey);
      } catch {
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

  binding(): AssistantBinding | undefined { return this.store.binding(); }
  setBinding(binding: AssistantBinding): void { this.store.setBinding(binding); this.emit("changed"); }
  page(options?: Parameters<AssistantMailStore["page"]>[0]): ReturnType<AssistantMailStore["page"]> { return this.store.page(options); }
  read(mailRefId: string): ReturnType<AssistantMailStore["read"]> { return this.store.read(mailRefId); }
  async readEvent(mailRefId: string) {
    const mail = await this.store.read(mailRefId);
    return mail ? { event: mail.event, bodyText: await mailBodyText(mail.source) } : undefined;
  }
  updateAnalysis(mailRefId: string, analysis: MailAnalysis) {
    const event = this.store.updateAnalysis(mailRefId, analysis);
    if (event) this.emit("changed", true);
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
    const receiver = new MailReceiver({ ...config, accountKey }, this.store, this.credentials, this.createClient, {
      changed: () => this.emit("changed"), mail: event => this.emit("mail", event), error: error => this.emit("error", error),
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
    try {
      await Promise.all([...Array.from(this.accounts.values(), ({ receiver }) => receiver), ...this.removingAccounts.values()].map(receiver => receiver.stop()));
    } finally {
      this.store.close();
      this.closed = true;
      this.emit("changed");
    }
  }
}
