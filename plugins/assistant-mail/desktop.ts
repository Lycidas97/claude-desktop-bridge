import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { hasCapability } from "imapflow/lib/tools.js";
import { KeychainMailCredentials, type MailCredentials } from "./credentials.js";
import { AssistantMailStore, type AssistantBinding, type MailAnalysis, type MailProcessingStatus } from "./store.js";
import { mailBodyText } from "./mime.js";
export { MailBodyParseError } from "./mime.js";

export interface MailAccount {
  host: string;
  port: number;
  user: string;
}

type SavedAccount = MailAccount & { enabled: boolean };
type MailState = "disabled" | "connecting" | "connected" | "reconnecting" | "unsupported" | "error" | "closed";

function parseAccount(value: MailAccount): MailAccount {
  if (typeof value.host !== "string" || !value.host.trim() || /\s/.test(value.host.trim()) ||
      typeof value.user !== "string" || !value.user.trim() || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error("Invalid IMAP account");
  }
  return { host: value.host.trim().toLowerCase(), port: value.port, user: value.user.trim() };
}

/** One instance belongs to the background service. Clients borrow this business API, never its connection. */
export class AssistantMailService extends EventEmitter {
  private readonly store: AssistantMailStore;
  private readonly credentials: MailCredentials;
  private readonly createClient: (options: ImapFlowOptions) => ImapFlow;
  private account: SavedAccount | undefined;
  private state: MailState = "disabled";
  private errorCode: string | undefined;
  private client: ImapFlow | undefined;
  private receiver: Promise<void> | undefined;
  private stopped = true;
  private wake: () => void = () => {};
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

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
    const saved = await readFile(join(this.store.directory, "account.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (saved !== undefined) {
      const value = JSON.parse(saved) as SavedAccount;
      if (typeof value.enabled !== "boolean") throw new Error("Invalid saved IMAP account");
      this.account = { ...parseAccount(value), enabled: value.enabled };
      if (this.account.enabled) this.start();
    }
  }

  status(): { state: MailState; credentialsSupported: boolean; account?: SavedAccount; accountKey?: string; errorCode?: string } {
    return {
      state: this.state, credentialsSupported: this.credentials.supported,
      ...(this.account ? { account: { ...this.account }, accountKey: this.accountKey(this.account) } : {}),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
    };
  }

  async enable(input: { host: string; port?: number; user: string; password: string }): Promise<void> {
    if (!this.credentials.supported) throw new Error("mail_credentials_unsupported");
    const account = parseAccount({ host: input.host, port: input.port ?? 993, user: input.user });
    if (typeof input.password !== "string" || !input.password) throw new Error("Invalid IMAP password");
    await this.credentials.set(this.accountKey(account), input.password);
    await this.stop();
    this.account = { ...account, enabled: true };
    await this.saveAccount();
    this.start();
  }

  async disable(): Promise<void> {
    await this.stop();
    if (this.account) {
      this.account.enabled = false;
      await this.saveAccount();
    }
    this.setState("disabled");
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
    if (event) this.emit("changed");
    return event;
  }
  setProcessingStatus(mailRefId: string, status: MailProcessingStatus) {
    const event = this.store.setProcessingStatus(mailRefId, status);
    if (event) this.emit("changed");
    return event;
  }

  private accountKey(account: MailAccount): string {
    return createHash("sha256").update(JSON.stringify([account.host, account.port, account.user])).digest("hex");
  }

  private saveAccount(): Promise<void> {
    return writeFile(join(this.store.directory, "account.json"), JSON.stringify(this.account), { mode: 0o600 });
  }

  private setState(state: MailState, errorCode?: string): void {
    this.state = state;
    this.errorCode = errorCode;
    this.emit("changed");
  }

  private start(): void {
    if (!this.credentials.supported) { this.setState("unsupported", "mail_credentials_unsupported"); return; }
    this.stopped = false;
    this.receiver = this.receive(this.account!).catch(error => { this.emit("error", error); });
  }

  private async receive(account: SavedAccount): Promise<void> {
    const accountKey = this.accountKey(account);
    this.setState("connecting");
    const password = await this.credentials.get(accountKey).catch(() => undefined);
    if (!password) { this.setState("error", "mail_credentials_unavailable"); return; }
    while (!this.stopped) {
      const client = this.createClient({
        host: account.host, port: account.port, secure: true,
        auth: { user: account.user, pass: password }, logger: false, logRaw: false,
        emitLogs: false, disableAutoIdle: true,
      });
      this.client = client;
      let ended = false;
      let changed = false;
      const notify = () => { changed = true; this.wake(); };
      client.on("exists", notify);
      client.on("error", () => { ended = true; notify(); client.close(); });
      client.on("close", () => { ended = true; notify(); });
      let storageFailure = false;
      try {
        await client.connect();
        if (this.stopped) break;
        if (!hasCapability(client, "IDLE")) { this.setState("unsupported", "mail_idle_unsupported"); return; }
        const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
        const uidValidity = mailbox.uidValidity.toString();
        storageFailure = true;
        let lastUid = this.store.openMailbox(accountKey, uidValidity, mailbox.uidNext);
        storageFailure = false;
        this.setState("connected");
        while (!this.stopped && !ended) {
          changed = false;
          // FETCH responses may arrive out of UID order. Enumerate IDs first so each commit covers every earlier new UID.
          const uids: number[] = [];
          for await (const message of client.fetch(`${lastUid + 1}:*`, { uid: true }, { uid: true })) uids.push(message.uid);
          for (const uid of uids.sort((left, right) => left - right)) {
            // UID ranges ending in '*' can include the last old UID when there is no new mail.
            if (uid <= lastUid) continue;
            const message = await client.fetchOne(String(uid), { uid: true, envelope: true, internalDate: true, source: true }, { uid: true });
            if (!message) continue; // The server may have expunged it since enumeration.
            if (!message.source) throw new Error("IMAP source unavailable");
            storageFailure = true;
            const event = await this.store.record({
              accountKey, mailbox: "INBOX", uidValidity, uid: message.uid, source: message.source,
              subject: message.envelope?.subject ?? "", from: message.envelope?.from ?? [],
              receivedAt: message.internalDate instanceof Date ? message.internalDate.toISOString() : message.internalDate ?? new Date().toISOString(),
            });
            lastUid = message.uid;
            storageFailure = false;
            if (event) this.emit("mail", event);
          }
          if (this.stopped || ended) break;
          if (changed) continue;
          // Install the wakeup before entering IDLE. EXISTS during a fetch is consumed by the next scan.
          const notified = new Promise<void>((resolve) => { this.wake = resolve; });
          const idling = client.idle();
          void idling.then(notify, notify);
          await notified;
          if (this.stopped || ended) { await idling; break; }
          // Any command breaks IDLE. This is event-driven, never an IDLE-less polling fallback.
          await client.noop();
          if (await idling === false) { this.setState("unsupported", "mail_idle_unsupported"); return; }
        }
      } catch (error) {
        if (this.stopped) return;
        if (storageFailure) {
          this.setState("error", "mail_storage_failed");
          throw error;
        }
        this.setState("reconnecting", "mail_connection_failed");
      } finally {
        client.close();
        this.client = undefined;
      }
      if (this.stopped) return;
      this.setState("reconnecting", "mail_connection_failed");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.reconnectTimer = setTimeout(resolve, 5_000);
        this.reconnectTimer.unref();
      });
      this.reconnectTimer = undefined;
    }
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.wake();
    this.client?.close();
    await this.receiver;
    this.receiver = undefined;
  }

  async close(): Promise<void> {
    try { await this.stop(); } finally { this.store.close(); this.setState("closed"); }
  }
}
