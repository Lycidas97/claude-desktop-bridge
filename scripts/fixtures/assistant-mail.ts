import { EventEmitter, once } from "node:events";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { AssistantAgendaService } from "../../plugins/assistant-mail/agenda.js";
import { AgendaStore } from "../../plugins/assistant-mail/agenda-store.js";
import { AssistantMailService } from "../../plugins/assistant-mail/desktop.js";
import { ProposalExecutor } from "../../plugins/assistant-mail/proposal-executor.js";
import { ProposalStore } from "../../plugins/assistant-mail/proposal-store.js";

/** Synthetic IMAP boundary; the real receiver, SQLite store and MIME reader run unchanged. */
export async function startAssistantMailFixture(directory: string, historyCount = 0, profile?: ConstructorParameters<typeof ProposalExecutor>[5]) {
  const seedAccount = { host: "imap.example.test", user: "assistant@example.test" };
  const seedInbox = new EventEmitter();
  const messages: FetchMessageObject[] = [];
  function append(count: number, source?: Buffer) {
    const last = messages.length + count;
    for (let uid = messages.length + 1; uid <= last; uid++) messages.push({
      uid, seq: uid, internalDate: new Date(Date.UTC(2026, 10, 12, 2, uid)),
      envelope: { subject: uid === 1 ? '<img src="https://tracker.invalid/pixel" onerror="window.mailInjected=1">' : `收件记录 ${uid}`,
        from: [{ name: "研究协作", address: "sender@example.test" }] },
      source: source ?? Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\n邮件正文 <script>window.mailInjected=1</script>\n<img src="https://tracker.invalid/body">\nhttps://trusted.example@actual.example.test/path\nhttps://actual.example.test/unsubscribe\nhttps://[invalid'),
    });
    return last;
  }
  append(historyCount);
  const credentials = new Map<string, string>();
  const service = new AssistantMailService({ userDataPath: directory,
    createClient: ({ host, auth }) => {
      const seeded = host === seedAccount.host && auth?.user === seedAccount.user;
      const inbox = seeded ? seedInbox : new EventEmitter();
      const mailbox = seeded ? messages : [];
      let finishIdle: (() => void) | undefined;
      return Object.assign(inbox, {
        capabilities: seeded ? new Map([["IDLE", true]]) : new Map(), enabled: new Set(),
        async connect() {},
        async mailboxOpen() { return { uidValidity: 1n, uidNext: mailbox.length + 1 }; },
        async *fetch(range: string) { yield* mailbox.filter(message => message.uid >= Number(range.split(":")[0])); },
        async search({ uid }: { uid: string }) { return mailbox.filter(message => message.uid <= Number(uid.split(":")[1])).map(message => message.uid); },
        async fetchOne(uid: string) { return mailbox.find(message => message.uid === Number(uid)) ?? false; },
        idle() { return new Promise<void>(resolve => { finishIdle = resolve; queueMicrotask(() => inbox.emit("idle")); }); },
        async noop() { finishIdle?.(); },
        close() { finishIdle?.(); inbox.emit("close"); },
      }) as unknown as ImapFlow;
    },
    credentials: {
      supported: true,
      get: async key => credentials.get(key),
      set: async (key, value) => { credentials.set(key, value); },
      delete: async key => { credentials.delete(key); },
    },
  });
  let store!: AgendaStore;
  let proposalStore!: ProposalStore;
  await service.initialize(db => { store = new AgendaStore(db); proposalStore = new ProposalStore(db); });
  const agenda = new AssistantAgendaService(store);
  const proposals = new ProposalExecutor(proposalStore, store, {
    available: () => false, encrypt: () => { throw new Error("No calendar credentials in fixture"); },
    decrypt: () => { throw new Error("No calendar credentials in fixture"); },
  }, sourceId => { void agenda.proposalChanged(sourceId); }, undefined, profile);
  const idle = once(seedInbox, "idle");
  await service.enable({ ...seedAccount, password: "synthetic-only" });
  await idle;
  return {
    service, agenda, proposals,
    seedCalendar(...resources: string[]) {
      const url = "https://caldav.example.test/fixtures/";
      const source = store.addSource({ url, user: "fixture", label: "外部日历" }, Buffer.from("sealed"));
      store.applySync(source, { removed: [], changed: resources.map((data, index) => ({ href: `${url}${index}.ics`, etag: '"1"', data })) });
    },
    async deliver(count: number, source?: Buffer) {
      const last = append(count, source);
      const received = new Promise<void>(resolve => {
        const onMail = (event: { uid: number }) => {
          if (event.uid === last) { service.off("mail", onMail); resolve(); }
        };
        service.on("mail", onMail);
      });
      seedInbox.emit("exists");
      await received;
      return service.page({ limit: 1 }).events[0]!;
    },
  };
}
