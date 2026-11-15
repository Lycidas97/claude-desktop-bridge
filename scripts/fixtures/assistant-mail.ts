import { EventEmitter, once } from "node:events";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { AssistantMailService } from "../../plugins/assistant-mail/desktop.js";

/** Synthetic IMAP boundary; the real receiver, SQLite store and MIME reader run unchanged. */
export async function startAssistantMailFixture(directory: string) {
  const inbox = new EventEmitter();
  const messages: FetchMessageObject[] = [];
  let finishIdle: (() => void) | undefined;
  Object.assign(inbox, {
    capabilities: new Map([["IDLE", true]]), enabled: new Set(),
    async connect() {},
    async mailboxOpen() { return { uidValidity: 1n, uidNext: 1 }; },
    async *fetch(range: string) { yield* messages.filter(message => message.uid >= Number(range.split(":")[0])); },
    async fetchOne(uid: string) { return messages.find(message => message.uid === Number(uid)) ?? false; },
    idle() { return new Promise<void>(resolve => { finishIdle = resolve; queueMicrotask(() => inbox.emit("idle")); }); },
    async noop() { finishIdle?.(); },
    close() { finishIdle?.(); inbox.emit("close"); },
  });
  let password = "";
  const service = new AssistantMailService({ userDataPath: directory,
    createClient: () => inbox as unknown as ImapFlow,
    credentials: { supported: true, get: async () => password, set: async (_key, value) => { password = value; } },
  });
  await service.initialize();
  const idle = once(inbox, "idle");
  await service.enable({ host: "imap.example.test", user: "assistant@example.test", password: "synthetic-only" });
  await idle;
  return {
    service,
    async deliver(count: number, source?: Buffer) {
      const next = messages.length + 1;
      for (let uid = next; uid < next + count; uid++) messages.push({
        uid, seq: uid, internalDate: new Date(Date.UTC(2026, 10, 12, 2, uid)),
        envelope: { subject: uid === 1 ? '<img src="https://tracker.invalid/pixel" onerror="window.mailInjected=1">' : `收件记录 ${uid}`,
          from: [{ name: "研究协作", address: "sender@example.test" }] },
        source: source ?? Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\n邮件正文 <script>window.mailInjected=1</script>\n<img src="https://tracker.invalid/body">\nhttps://trusted.example@actual.example.test/path\nhttps://actual.example.test/unsubscribe\nhttps://[invalid'),
      });
      const received = new Promise<void>(resolve => {
        const onMail = (event: { uid: number }) => {
          if (event.uid === next + count - 1) { service.off("mail", onMail); resolve(); }
        };
        service.on("mail", onMail);
      });
      inbox.emit("exists");
      await received;
      return service.page({ limit: 1 }).events[0]!;
    },
  };
}
