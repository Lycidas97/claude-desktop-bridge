import type { ImapFlow, ImapFlowOptions } from "imapflow";
import { hasCapability } from "imapflow/lib/tools.js";
import type { MailCredentials } from "./credentials.js";
import type { AssistantMailStore, MailEvent } from "./store.js";

export type MailState = "disabled" | "connecting" | "connected" | "reconnecting" | "unsupported" | "error" | "closed";

export class MailReceiver {
  state: MailState = "disabled";
  errorCode: string | undefined;
  private client: ImapFlow | undefined;
  private receiving: Promise<void> | undefined;
  private stopped = true;
  private wake: () => void = () => {};
  private requestScan: (() => void) | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly account: { accountKey: string; host: string; port: number; user: string },
    private readonly store: AssistantMailStore,
    private readonly credentials: MailCredentials,
    private readonly createClient: (options: ImapFlowOptions) => ImapFlow,
    private readonly events: { changed(): void; mail(event: MailEvent): void; error(error: unknown): void },
  ) {}

  start(): void {
    if (this.receiving) return;
    if (!this.credentials.supported) { this.setState("unsupported", "mail_credentials_unsupported"); return; }
    this.stopped = false;
    this.receiving = this.receive().catch(error => { this.events.error(error); });
  }

  resume(): void {
    if (this.requestScan) this.requestScan();
    else if (this.reconnectTimer) this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    this.client?.close();
    const receiving = this.receiving;
    await receiving;
    if (this.receiving === receiving) this.receiving = undefined;
  }

  private setState(state: MailState, errorCode?: string): void {
    this.state = state;
    this.errorCode = errorCode;
    this.events.changed();
  }

  private async receive(): Promise<void> {
    const { accountKey, host, port, user } = this.account;
    this.setState("connecting");
    const password = await this.credentials.get(accountKey).catch(() => undefined);
    if (this.stopped) return;
    if (!password) { this.setState("error", "mail_credentials_unavailable"); return; }
    while (!this.stopped) {
      const client = this.createClient({
        host, port, secure: true,
        auth: { user, pass: password }, logger: false, logRaw: false,
        emitLogs: false, disableAutoIdle: true,
      });
      this.client = client;
      let ended = false;
      let changed = false;
      const notify = () => { changed = true; this.wake(); };
      this.requestScan = notify;
      client.on("exists", notify);
      client.on("error", () => { ended = true; notify(); client.close(); });
      client.on("close", () => { ended = true; notify(); });
      let storageFailure = false;
      let connectionError = "mail_connection_failed";
      try {
        await client.connect();
        if (this.stopped) break;
        if (!hasCapability(client, "IDLE")) { this.setState("unsupported", "mail_idle_unsupported"); return; }
        const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
        if (this.stopped) break;
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
            if (event) this.events.mail(event);
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
        if ((error as { authenticationFailed?: boolean } | null)?.authenticationFailed === true) {
          connectionError = "mail_authentication_failed";
        }
      } finally {
        client.close();
        this.client = undefined;
        this.requestScan = undefined;
      }
      if (this.stopped) return;
      const reconnect = new Promise<void>((resolve) => {
        this.wake = resolve;
        this.reconnectTimer = setTimeout(resolve, 5_000);
        this.reconnectTimer.unref();
      });
      this.setState("reconnecting", connectionError);
      await reconnect;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
