import type { ImapFlow, ImapFlowOptions } from "imapflow";
import { hasCapability } from "imapflow/lib/tools.js";
import type { MailCredentials } from "./credentials.js";
import type { AssistantMailStore, MailEvent } from "./store.js";
import type { MailPollInterval } from "../../packages/protocol/src/assistant-mail.js";

export type MailState = "disabled" | "connecting" | "connected" | "polling" | "reconnecting" | "unsupported" | "error" | "closed";

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
    private readonly accountKey: string,
    private readonly account: { host: string; port: number; user: string; pollIntervalSeconds: MailPollInterval },
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
    const { accountKey, account: { host, port, user } } = this;
    this.setState("connecting");
    const password = await this.credentials.get(accountKey).catch(() => undefined);
    if (this.stopped) return;
    if (!password) { this.setState("error", "mail_credentials_unavailable"); return; }
    let idleRefusedOnClose = false;
    while (!this.stopped) {
      const client = this.createClient({
        host, port, secure: true,
        auth: { user, pass: password }, logger: false, logRaw: false,
        emitLogs: false, disableAutoIdle: true,
      });
      this.client = client;
      let ended = false;
      let changed = false;
      let useIdle = false;
      const notify = () => { changed = true; this.wake(); };
      this.requestScan = notify;
      client.on("exists", () => { if (useIdle) notify(); });
      client.on("error", () => { ended = true; notify(); client.close(); });
      client.on("close", () => { ended = true; notify(); });
      let storageFailure = false;
      let connectionError = "mail_connection_failed";
      try {
        await client.connect();
        if (this.stopped) break;
        useIdle = !idleRefusedOnClose && hasCapability(client, "IDLE");
        let uidValidity: string | undefined;
        let lastUid = 0;
        while (!this.stopped && !ended) {
          changed = false;
          if (!useIdle && this.account.pollIntervalSeconds === null) {
            this.setState("unsupported", "mail_idle_unsupported");
            return;
          }
          if (uidValidity === undefined || !useIdle) {
            // EXAMINE refreshes UIDVALIDITY before each polling scan without changing flags.
            const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
            if (this.stopped || ended) break;
            const generation = mailbox.uidValidity.toString();
            if (uidValidity !== generation) {
              storageFailure = true;
              let watermark = this.store.openMailbox(accountKey, generation, mailbox.uidNext);
              storageFailure = false;
              if (watermark === undefined) {
                // Some servers omit UIDNEXT. Read only the tail UID; don't import history.
                let nextUid = 1;
                if (mailbox.exists !== 0) {
                  const tail = await client.fetchOne("*", { uid: true });
                  if (this.stopped || ended) break;
                  if (!tail || !tail.uid) throw new Error("IMAP tail UID unavailable");
                  nextUid = tail.uid + 1;
                }
                storageFailure = true;
                watermark = this.store.openMailbox(accountKey, generation, nextUid)!;
                storageFailure = false;
              }
              uidValidity = generation;
              lastUid = watermark;
            }
            if (useIdle) this.setState("connected");
          }
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
          if (useIdle) {
            if (changed) continue;
            // Install the wakeup before IDLE. EXISTS during a fetch is consumed by the next scan.
            const notified = new Promise<void>(resolve => { this.wake = resolve; });
            const idling = client.idle();
            void idling.then(notify, notify);
            await notified;
            if (this.stopped || ended) {
              const result = await idling;
              // Only an explicit BYE refusal changes the next connection's mode, not a lost socket.
              if (!this.stopped && result === false && /\bIDLE\s+(?:is\s+)?(?:disabled|unsupported|not\s+(?:allowed|supported))\b/i.test(client.byeReason ?? "")) {
                idleRefusedOnClose = true;
              }
              break;
            }
            await client.noop(); // An IMAP command breaks IDLE and checks the connection is still usable.
            if (await idling !== false) continue;
            if (this.stopped || ended) break;
            useIdle = false;
          }
          const seconds = this.account.pollIntervalSeconds;
          if (seconds === null) continue;
          const timer = setTimeout(() => this.wake(), seconds * 1_000);
          timer.unref();
          const poll = new Promise<void>(resolve => { this.wake = resolve; });
          if (this.state !== "polling") this.setState("polling");
          await poll;
          clearTimeout(timer);
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
      if (idleRefusedOnClose && this.account.pollIntervalSeconds === null) {
        this.setState("unsupported", "mail_idle_unsupported");
        return;
      }
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
