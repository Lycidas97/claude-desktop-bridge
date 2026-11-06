import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionBroker, type SessionHostRuntime, type TranscriptObserverRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(maxParallelTurns = 2) {
  const root = await mkdtemp(join(tmpdir(), "bridge-dispatch-")); roots.push(root);
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  let heldSession = "";
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const sends: string[] = [];
  const sentInputs: Parameters<SessionHostRuntime["send"]>[0][] = [];
  const persistedAtSend: Promise<unknown>[] = [];
  const hosts = new Map<string, SessionHostRuntime & {events:EventEmitter;closed:boolean}>();
  const observer: TranscriptObserverRuntime = {
    catalog: { sessions: [{sessionId:"seed",cwd:root,projectId:"p",projectName:"p",title:"seed",source:"desktop",ownership:"DESKTOP_OBSERVED",transport:"bridge-host",turnState:"idle",pendingCount:0,lastActivityAt:Date.now(),transcriptMtimeMs:0,processAlive:false,desktopProcessAlive:false,bridgeProcessAlive:false,processOverlap:false,activeProcesses:[],activeTask:false}], projects: [], observedAt: Date.now() },
    isDesktopBusy: () => false, isMainTurnBusy: () => false,
    runningSubagents: () => undefined,
    externalWriteVersion: () => 0,
    async canStartBridgeHost(id) { if (id === heldSession) { entered(); await held; } return true; },
    onCatalog: () => () => {},
  };
  const broker = new SessionBroker({
    paths: { sessions: join(root,"sessions"), projects: join(root,"projects"), tasks: join(root,"tasks"), desktopSessions: [] },
    sessionsPath: join(root,"sessions.json"), queuePath: join(root,"queue.json"),
    eventLog, observer, maxParallelTurns,
    prepareRuntime: async () => ({executablePath:"/fake/claude",credentialPath:"/fake/creds",environment:{}}),
    discoverGatewayModels: async () => [], scanSessionProcesses: async () => [],
    hostFactory: ({sessionId}) => {
      const events = new EventEmitter();
      const host: SessionHostRuntime & {events:EventEmitter;closed:boolean} = {
        events, closed:false,
        start() {}, async setModel() {}, async setEffort() {}, async setAutoCompactWindow() {},
        async supportedModels() {return [];}, async contextUsage() {throw Error("unused");},
        send(input) {
          sends.push(sessionId);
          sentInputs.push(input);
          persistedAtSend.push(readFile(join(root,"queue.json"),"utf8").then(JSON.parse));
          return {turnId:typeof input === "string" ? `t-${sends.length}` : input.turnId ?? `t-${sends.length}`,
            messageId:typeof input === "string" ? `m-${sends.length}` : input.messageId ?? `m-${sends.length}`};
        },
        async interrupt() {}, async stopTask() {}, async close() {host.closed=true;},
        onEvent(listener) {events.on("event",listener);return ()=>events.off("event",listener);},
      };
      hosts.set(sessionId,host);
      return host;
    },
  });
  await broker.initialize();
  const a = await broker.createSession(root,"A"), b = await broker.createSession(root,"B");
  heldSession = a.sessionId;
  const submit = (sessionId: string, key: string) => broker.startTurn({sessionId, requestId:key,idempotencyKey:key,text:key,origin:"mobile"});
  return {broker,a,b,sends,sentInputs,hosts,eventLog,persistedAtSend,waiting,release,submit, async close() {release(); await broker.close();await eventLog.close();}};
}

it("starts another eligible session while the first session is awaiting ownership", async () => {
  const f=await fixture();
  try {
    await f.submit(f.a.sessionId,"a"); await f.waiting;
    await f.submit(f.b.sessionId,"b");
    await vi.waitFor(()=>expect(f.sends).toContain(f.b.sessionId),{timeout:500});
    expect(f.sends).not.toContain(f.a.sessionId);
    f.release();
    await vi.waitFor(()=>expect(f.sends).toHaveLength(2));
  } finally {await f.close();}
});

it("reserves global capacity and the session while startup is pending", async () => {
  const f=await fixture(1);
  try {
    const first=await f.submit(f.a.sessionId,"a");await f.waiting;
    await f.submit(f.a.sessionId,"a-next");await f.submit(f.b.sessionId,"b");
    await new Promise(resolve=>setImmediate(resolve));expect(f.sends).toEqual([]);
    f.release();await vi.waitFor(()=>expect(f.sends).toHaveLength(1));
    expect(f.sends).toEqual([f.a.sessionId]);
    await f.broker.interruptTurn(f.a.sessionId, first.commandId, true);
    await vi.waitFor(()=>expect(f.sends).toHaveLength(2));
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
  } finally {await f.close();}
});

it("does not send a command cancelled while ownership was being checked", async () => {
  const f=await fixture();
  try {
    const turn=await f.submit(f.a.sessionId,"a");await f.waiting;
    const cancel=f.broker.interruptTurn(f.a.sessionId,turn.commandId);
    f.release();await cancel;
    await (f.broker as unknown as {pump():Promise<void>}).pump();
    expect(f.sends).toEqual([]);
  } finally {await f.close();}
});

it("persists execution identity before handing input to the SDK", async () => {
  const f=await fixture();
  try {
    await f.submit(f.b.sessionId,"persist-first");
    await vi.waitFor(()=>expect(f.sends).toHaveLength(1));
    const persisted=await f.persistedAtSend[0] as {pending:Array<Record<string,unknown>>};
    expect(persisted.pending[0]).toMatchObject({state:"running",turnId:expect.any(String),messageId:expect.any(String),submissionStartedAt:expect.any(Number)});
  } finally {await f.close();}
});

it("retains background tasks after the main result and releases only after their terminal event", async () => {
  const f=await fixture();
  try {
    const turn=await f.submit(f.b.sessionId,"background");
    await (f.broker as unknown as {pump():Promise<void>}).pump();
    const host=f.hosts.get(f.b.sessionId)!;
    const task={taskId:"child",toolUseId:"agent-tool",description:"Still working",state:"running",startedAt:10,updatedAt:10};
    host.events.emit("event",{...task,type:"task.started",sessionId:f.b.sessionId,at:10});
    host.events.emit("event",{type:"background.tasks",sessionId:f.b.sessionId,tasks:[task],at:10});
    host.events.emit("event",{type:"turn.completed",sessionId:f.b.sessionId,turnId:(turn as {turnId?:string}).turnId,result:"Main done",at:11});
    const internal=f.broker as unknown as {eventQueue:Promise<void>;releaseSession(id:string):Promise<void>};
    await internal.eventQueue;await internal.releaseSession(f.b.sessionId);
    expect(host.closed).toBe(false);
    expect(f.broker.session(f.b.sessionId)?.runningSubagents?.count).toBe(1);
    await f.broker.stopSubagent(f.b.sessionId,"child");
    expect(f.broker.session(f.b.sessionId)?.runningSubagents?.count).toBe(1);
    host.events.emit("event",{...task,type:"task.notification",sessionId:f.b.sessionId,state:"stopped",updatedAt:12,at:12});
    host.events.emit("event",{type:"background.tasks",sessionId:f.b.sessionId,tasks:[],at:12});
    await internal.eventQueue;await internal.releaseSession(f.b.sessionId);
    expect(host.closed).toBe(true);
    expect(f.broker.session(f.b.sessionId)?.runningSubagents).toBeUndefined();
    expect(f.eventLog.latestTaskEvents(f.b.sessionId).at(-1)?.data.subagent).toMatchObject({state:"stopped"});
  } finally {await f.close();}
});

it("keeps a background child's pending permission after the launching main turn completes", async () => {
  const f = await fixture();
  let permission: Promise<unknown> | undefined;
  const permissionAbort = new AbortController();
  try {
    const turn = await f.submit(f.b.sessionId, "background-permission");
    await (f.broker as unknown as { pump(): Promise<void> }).pump();
    const host = f.hosts.get(f.b.sessionId)!;
    const task = { taskId: "child", toolUseId: "agent-tool", description: "Research", state: "running", startedAt: 10, updatedAt: 10 };
    host.events.emit("event", { ...task, type: "task.started", sessionId: f.b.sessionId, at: 10 });
    host.events.emit("event", { type: "background.tasks", sessionId: f.b.sessionId, tasks: [task], at: 10 });
    const internal = f.broker as unknown as {
      eventQueue: Promise<void>;
      releaseSession(id: string): Promise<void>;
      permissionBroker: import("./permission-broker.js").PermissionBroker;
    };
    await internal.eventQueue;
    permission = internal.permissionBroker.request(f.b.sessionId, "Read", { file_path: "/qa/source" }, {
      signal: permissionAbort.signal, toolUseId: "child-read",
    });
    host.events.emit("event", { type: "turn.completed", sessionId: f.b.sessionId,
      turnId: (turn as { turnId?: string }).turnId, result: "Child continues", at: 11 });
    await internal.eventQueue;
    expect(internal.permissionBroker.list(f.b.sessionId)).toHaveLength(1);
    await internal.releaseSession(f.b.sessionId);
    expect(host.closed).toBe(false);
    expect(f.broker.runtimeStatus().activeTurns).toBe(0);
  } finally {
    permissionAbort.abort();
    await f.close();
    await permission;
  }
});

it("does not let an old turn result settle the next active command", async () => {
  const f=await fixture();
  try {
    const first=await f.submit(f.b.sessionId,"first");
    await (f.broker as unknown as {pump():Promise<void>}).pump();
    const host=f.hosts.get(f.b.sessionId)!;
    const internal=f.broker as unknown as {eventQueue:Promise<void>};
    host.events.emit("event",{type:"turn.completed",sessionId:f.b.sessionId,turnId:(first as {turnId?:string}).turnId,result:"done",at:1});
    await internal.eventQueue;
    const next=await f.submit(f.b.sessionId,"next");
    await (f.broker as unknown as {pump():Promise<void>}).pump();
    host.events.emit("event",{type:"turn.completed",sessionId:f.b.sessionId,turnId:(first as {turnId?:string}).turnId,result:"old duplicate",at:2});
    await internal.eventQueue;
    expect(f.broker.session(f.b.sessionId)?.activeTurnId).toBe((next as {turnId?:string}).turnId);
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
  } finally {await f.close();}
});

it("SDK running tasks survive generic Agent tool completion", async () => {
  const f=await fixture();
  try {
    await f.submit(f.b.sessionId,"task");await (f.broker as unknown as {pump():Promise<void>}).pump();
    const host=f.hosts.get(f.b.sessionId)!;
    const task={taskId:"child",toolUseId:"agent-tool",description:"Working",state:"running",startedAt:10,updatedAt:10};
    host.events.emit("event",{type:"tool.started",sessionId:f.b.sessionId,itemId:"agent-tool",toolName:"Agent",input:{description:"Working"},at:9});
    host.events.emit("event",{...task,type:"task.started",sessionId:f.b.sessionId,at:10});
    host.events.emit("event",{type:"tool.completed",sessionId:f.b.sessionId,itemId:"agent-tool",output:"Agent launched",at:11});
    await (f.broker as unknown as {eventQueue:Promise<void>}).eventQueue;
    expect(f.eventLog.latestTaskEvents(f.b.sessionId).at(-1)?.data.subagent).toMatchObject({state:"running"});
  } finally {await f.close();}
});

it("promotes the original queued command ahead of other messages without duplicating its payload", async () => {
  const f = await fixture();
  try {
    const active = await f.submit(f.b.sessionId, "active");
    await (f.broker as unknown as { pump(): Promise<void> }).pump();
    const ordinary = await f.submit(f.b.sessionId, "ordinary");
    const attachments = [{ id: "image", name: "context.png", mimeType: "image/png" as const, data: "cGljdHVyZQ==", size: 7 }];
    const queued = await f.broker.startTurn({ sessionId: f.b.sessionId, requestId: "original-request", idempotencyKey: "original-key", text: "Adjust with this image", attachments, origin: "mobile" });
    const original = { ...queued };
    if (!("text" in original)) throw new Error("Expected a newly queued command");
    const host = f.hosts.get(f.b.sessionId)!;
    const interrupt = vi.spyOn(host, "interrupt");
    const promoted = await f.broker.steerQueuedTurn(f.b.sessionId, queued.commandId);
    expect(promoted).toBe(queued);
    expect(promoted).toMatchObject({ ...original, state: "running", mode: "steer", priority: 100 });
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.sentInputs[1]).toMatchObject({ text: original.text, attachments, priority: "now" });
    expect(f.eventLog.replay(0).filter(event => event.type === "turn.queued")).toHaveLength(3);
    const persisted = JSON.parse(await readFile((f.broker as unknown as { options: { queuePath: string } }).options.queuePath, "utf8"));
    expect(persisted.pending.find((turn: { commandId: string }) => turn.commandId === queued.commandId)).toMatchObject({ ...original, state: "running", mode: "steer", priority: 100 });
    await f.broker.steerQueuedTurn(f.b.sessionId, queued.commandId);
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.sentInputs).toHaveLength(2);
    host.events.emit("event", { type: "turn.interrupted", sessionId: f.b.sessionId, turnId: (active as { turnId: string }).turnId, at: Date.now() });
    await (f.broker as unknown as { eventQueue: Promise<void> }).eventQueue;
    await (f.broker as unknown as { pump(): Promise<void> }).pump();
    expect(f.sentInputs).toHaveLength(2);
    expect(f.sentInputs[1]).toMatchObject({ text: original.text, attachments });
    expect(f.broker.session(f.b.sessionId)?.pendingCommandIds).toEqual([ordinary.commandId]);
    expect(f.eventLog.replay(0).filter(event => event.type === "turn.queued")).toHaveLength(3);
  } finally { await f.close(); }
});

it("does not interrupt or resend a command that has already started or completed", async () => {
  const f = await fixture();
  try {
    const turn = await f.submit(f.b.sessionId, "already-running");
    await (f.broker as unknown as { pump(): Promise<void> }).pump();
    const host = f.hosts.get(f.b.sessionId)!;
    const interrupt = vi.spyOn(host, "interrupt");
    expect((await f.broker.steerQueuedTurn(f.b.sessionId, turn.commandId)).state).toBe("running");
    host.events.emit("event", { type: "turn.completed", sessionId: f.b.sessionId, turnId: (turn as { turnId: string }).turnId, result: "Done", at: Date.now() });
    await (f.broker as unknown as { eventQueue: Promise<void> }).eventQueue;
    expect((await f.broker.steerQueuedTurn(f.b.sessionId, turn.commandId)).state).toBe("completed");
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.sentInputs).toHaveLength(1);
  } finally { await f.close(); }
});

it("rejects a command from another session without changing its queue position", async () => {
  const f = await fixture();
  try {
    const turn = await f.submit(f.a.sessionId, "waiting");
    await f.waiting;
    await expect(f.broker.steerQueuedTurn(f.b.sessionId, turn.commandId)).rejects.toThrow("排队消息");
    expect(turn).toMatchObject({ state: "queued", mode: "start", priority: 0 });
    expect(f.sentInputs).toEqual([]);
  } finally { await f.close(); }
});

it("does not promote a command whose ownership check has already begun", async () => {
  const f = await fixture();
  try {
    const turn = await f.submit(f.a.sessionId, "starting");
    await f.waiting;
    await expect(f.broker.steerQueuedTurn(f.a.sessionId, turn.commandId)).rejects.toThrow("启动");
    expect(turn).toMatchObject({ mode: "start", priority: 0 });
    f.release();
    await (f.broker as unknown as { pump(): Promise<void> }).pump();
    expect(f.sentInputs).toHaveLength(1);
  } finally { await f.close(); }
});

it("does not interrupt the selected message if it starts while promotion is being persisted", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const active = await f.submit(f.b.sessionId, "finishes-naturally");
    const internal = f.broker as unknown as { pump(): Promise<void>; saveQueue(): Promise<void>; eventQueue: Promise<void> };
    await internal.pump();
    const queued = await f.submit(f.b.sessionId, "promote-me");
    const host = f.hosts.get(f.b.sessionId)!;
    const interrupt = vi.spyOn(host, "interrupt");
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const enteredSave = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(internal, "saveQueue").mockImplementationOnce(async () => { entered(); await held; });
    const promotion = f.broker.steerQueuedTurn(f.b.sessionId, queued.commandId);
    await enteredSave;
    host.events.emit("event", { type: "turn.completed", sessionId: f.b.sessionId, turnId: (active as { turnId: string }).turnId, result: "Done", at: Date.now() });
    await internal.eventQueue;
    expect(queued.state).toBe("running");
    release();
    await promotion;
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.sentInputs).toHaveLength(2);
    expect(f.broker.session(f.b.sessionId)?.pendingCount).toBe(0);
  } finally { release?.(); await f.close(); }
});

it.each(["uncertain", "recovery-blocked"])("does not promote a delivery requiring confirmation: %s", async status => {
  const f = await fixture();
  try {
    const turn = await f.submit(f.a.sessionId, "unconfirmed");
    await f.waiting;
    Object.assign(turn, status === "uncertain" ? { state: "uncertain" } : { recoveryBlocked: true });
    await expect(f.broker.steerQueuedTurn(f.a.sessionId, turn.commandId)).rejects.toThrow("尚未确认");
    expect(turn).toMatchObject({ mode: "start", priority: 0 });
    expect(f.sentInputs).toEqual([]);
  } finally { await f.close(); }
});

it("retains the queued payload if native submission fails", async () => {
  const f = await fixture();
  try {
    await f.submit(f.b.sessionId, "active");
    await (f.broker as unknown as { pump(): Promise<void> }).pump();
    const queued = await f.submit(f.b.sessionId, "keep-me");
    const host = f.hosts.get(f.b.sessionId)!;
    const interrupt = vi.spyOn(host, "interrupt");
    vi.spyOn(host, "send").mockImplementationOnce(() => { throw new Error("Native submission failed"); });
    await expect(f.broker.steerQueuedTurn(f.b.sessionId, queued.commandId)).rejects.toThrow("Native submission failed");
    expect(f.broker.session(f.b.sessionId)?.pendingCommandIds).toContain(queued.commandId);
    expect(queued).toMatchObject({ state: "queued", text: "keep-me" });
    expect(queued).not.toHaveProperty("submissionStartedAt");
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.sentInputs).toHaveLength(1);
  } finally { await f.close(); }
});

it.each(["persistence", "submission"])("releases an unsent promotion after the old turn completes and %s fails", async failure => {
  const f = await fixture();
  let release!: () => void;
  try {
    const active = await f.submit(f.b.sessionId, "finishes-during-promotion");
    const internal = f.broker as unknown as { pump(): Promise<void>; saveQueue(): Promise<void>; eventQueue: Promise<void> };
    await internal.pump();
    const queued = await f.submit(f.b.sessionId, "retry-original");
    const host = f.hosts.get(f.b.sessionId)!;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const enteredSave = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(internal, "saveQueue").mockImplementationOnce(async () => {
      entered();
      await held;
      if (failure === "persistence") throw new Error("Promotion failed");
    });
    if (failure === "submission") {
      vi.spyOn(host, "send").mockImplementationOnce(() => { throw new Error("Promotion failed"); });
    }
    const promotion = expect(f.broker.steerQueuedTurn(f.b.sessionId, queued.commandId)).rejects.toThrow("Promotion failed");
    await enteredSave;
    host.events.emit("event", { type: "turn.completed", sessionId: f.b.sessionId, turnId: (active as { turnId: string }).turnId, result: "Done", at: Date.now() });
    await internal.eventQueue;
    release();
    await promotion;
    expect(queued).toMatchObject({ state: "queued", text: "retry-original" });
    expect(queued).not.toHaveProperty("submissionStartedAt");
    expect(f.broker.session(f.b.sessionId)?.activeTurnId).toBeUndefined();
    expect(f.broker.runtimeStatus().activeTurns).toBe(0);
    await f.broker.steerQueuedTurn(f.b.sessionId, queued.commandId);
    await internal.pump();
    expect(f.sentInputs).toHaveLength(2);
    expect(f.sentInputs[1]).toMatchObject({ text: "retry-original" });
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
  } finally { release?.(); await f.close(); }
});

it("retains another submitted native command when an unsent promotion rolls back", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const active = await f.submit(f.b.sessionId, "original");
    const internal = f.broker as unknown as { pump(): Promise<void>; saveQueue(): Promise<void>; eventQueue: Promise<void> };
    await internal.pump();
    const queued = await f.submit(f.b.sessionId, "failed-promotion");
    const host = f.hosts.get(f.b.sessionId)!;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const enteredSave = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(internal, "saveQueue").mockImplementationOnce(async () => { entered(); await held; });
    const promotion = expect(f.broker.steerQueuedTurn(f.b.sessionId, queued.commandId)).rejects.toThrow("Promotion failed");
    await enteredSave;
    const surviving = await f.submit(f.b.sessionId, "already-submitted");
    await f.broker.steerQueuedTurn(f.b.sessionId, surviving.commandId);
    host.events.emit("event", { type: "turn.completed", sessionId: f.b.sessionId, turnId: (active as { turnId: string }).turnId, result: "Done", at: Date.now() });
    await internal.eventQueue;
    expect(f.broker.session(f.b.sessionId)?.activeTurnId).toBe((queued as { turnId: string }).turnId);
    vi.spyOn(host, "send").mockImplementationOnce(() => { throw new Error("Promotion failed"); });
    release();
    await promotion;
    expect(queued).toMatchObject({ state: "queued", text: "failed-promotion" });
    expect(f.broker.session(f.b.sessionId)?.activeTurnId).toBe((surviving as { turnId: string }).turnId);
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
    expect(f.sentInputs).toHaveLength(2);
    await f.broker.steerQueuedTurn(f.b.sessionId, queued.commandId);
    expect(f.sentInputs).toHaveLength(3);
    expect(f.sentInputs[2]).toMatchObject({ text: "failed-promotion", priority: "now" });
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
  } finally { release?.(); await f.close(); }
});

it("does not create or send a host after shutdown starts during ownership check", async () => {
  const f=await fixture();
  try {
    await f.submit(f.a.sessionId,"a");await f.waiting;
    const close=f.broker.close();f.release();await close;
    expect(f.sends).toEqual([]);
  } finally {await f.close();}
});
