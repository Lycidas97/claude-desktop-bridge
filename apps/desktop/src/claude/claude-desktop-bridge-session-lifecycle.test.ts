import { createControllerFixture } from "../controller/controller-fixture.js";
import { describe, expect, it } from "vitest";
import { ClaudeDesktopBridge } from "./claude-desktop-bridge.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import { fixture, withDatabase, turnInput as input } from "./claude-desktop-bridge-fixture.js";

describe("native session lifecycle and sidechats", () => {
  it("creates an empty native session without starting a turn", async () => {
    const f = await fixture();
    try {
      const session = await f.bridge.createSession("/new-project", "New");
      expect(session.transport).toBe("claude-desktop-native");
      expect(f.native.calls.find(call => call.method === "start")?.args[0]).toMatchObject({ withoutFirstMessage: true, message: "" });
      expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(false);
    } finally { await f.close(); }
  });

  it("deletes the native session and refreshes the Desktop list", async () => {
    const f = await fixture();
    try {
      await f.bridge.deleteSession("local-native");
      expect(f.native.calls.filter(call => call.method === "delete")).toEqual([{ method: "delete", args: ["local-native"] }]);
      expect(f.native.calls.some(call => call.method === "archive")).toBe(false);
      expect(f.bridge.listSessions()).toEqual([]);
    } finally { await f.close(); }
  });

  it("opens a newly created session before its first message with empty history", async () => {
    const f = await fixture();
    try {
      const { sessionId } = await f.bridge.createSession("/project");
      expect(sessionId).not.toBe("local-native");
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;
      const opened = await controller.dispatchLocal({ method: "session.open", params: { sessionId } });
      expect(opened).toMatchObject({ ok: true });
      expect(opened).toHaveProperty("result.history", { sessionId, items: [], hasMore: false });
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage")).toEqual([
        { method: "getTranscriptPage", args: [sessionId, "", 18, { window: "accept" }] },
      ]);
    } finally { await f.close(); }
  });

  it("adds btw once to the native command menu and preserves native command metadata", async () => {
    const f = await fixture();
    try {
      expect((await f.bridge.commands("local-native")).commands.map(command => command.name)).toEqual(["compact", "btw", "rewind"]);
      f.native.commands.push({ name: "btw", description: "Native side question" });
      const catalog = await f.bridge.commands("local-native");
      expect(catalog.commands.filter(command => command.name === "btw")).toEqual([{ name: "btw", description: "Native side question" }]);
      expect(catalog.commands[0]).toEqual(f.native.commands[0]);
    } finally { await f.close(); }
  });

  it("starts a native btw child, sends only the question there, and restores native sidechat identity", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    let reloadedLog: SessionEventLog | undefined;
    try {
      const command = { ...input, text: "/btw Why does this work?" };
      const result = await f.bridge.runCommand(command);
      expect(result).toMatchObject({ action: "session", session: { sessionId: "local-child", parentSessionId: "local-native", sidechat: true } });
      expect(f.native.calls.filter(call => call.method === "startBtwChild")).toEqual([{ method: "startBtwChild", args: ["local-native"] }]);
      expect(f.native.calls.some(call => call.method === "forkSession")).toBe(false);
      expect(f.native.calls.filter(call => ["startBtwChild", "getSession", "sendMessage"].includes(call.method)).map(call => call.method)).toEqual(["startBtwChild", "getSession", "sendMessage"]);
      expect(f.native.calls.find(call => call.method === "sendMessage")?.args.slice(0, 2)).toEqual(["local-child", "Why does this work?"]);
      expect(f.native.sessions.find(session => session.sessionId === "local-child")?.spawnedFrom).toMatchObject({ sessionId: "local-native", btw: true });
      expect(f.eventLog.replay(0).some(event => event.type === "session.observed")).toBe(false);
      expect(withDatabase(f.databasePath, (db) => db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'bridge_sessions'",
      ).get())).toBeUndefined();
      expect(await f.bridge.runCommand(command)).toMatchObject({ action: "session", session: { sessionId: "local-child" } });
      expect(f.native.calls.filter(call => call.method === "startBtwChild")).toHaveLength(1);
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      await f.bridge.close();
      await f.eventLog.close();
      reloadedLog = new SessionEventLog(f.eventLog.path);
      await reloadedLog.initialize();
      restarted = new ClaudeDesktopBridge({ ...f.options, eventLog: reloadedLog });
      await restarted.initialize();
      expect(restarted.session("local-child")).toMatchObject({ sidechat: true, parentSessionId: "local-native" });
    } finally { await restarted?.close(); await reloadedLog?.close(); await f.close(); }
  });

  it.each(["refused", "disabled", "failed"])("reports native btw %s without falling back to an ordinary fork", async status => {
    const f = await fixture();
    try {
      f.native.btwResult = { status, refusalReason: "native-policy" };
      await expect(f.bridge.runCommand({ ...input, text: "/btw Why?" })).rejects.toThrow(new RegExp(`${status}.*native-policy`, "u"));
      expect(f.native.calls.filter(call => call.method === "startBtwChild")).toHaveLength(1);
      expect(f.native.calls.some(call => call.method === "forkSession" || call.method === "sendMessage")).toBe(false);
      expect(f.bridge.listSessions()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("reports an unsupported native btw method without creating another session", async () => {
    const f = await fixture();
    try {
      f.native.unsupported.add("startBtwChild");
      await expect(f.bridge.runCommand({ ...input, text: "/btw Why?" })).rejects.toThrow("Unsupported");
      expect(f.native.calls.some(call => call.method === "forkSession" || call.method === "sendMessage")).toBe(false);
    } finally { await f.close(); }
  });

  it("projects sidechat and parent navigation from native metadata without a Bridge marker", async () => {
    const f = await fixture();
    try {
      f.native.sessions.push({ sessionId: "desktop-btw", cwd: "/project", spawnedFrom: { sessionId: "local-native", btw: true } });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("desktop-btw")).toMatchObject({ sidechat: true, parentSessionId: "local-native" });
      f.native.sessions[1]!.lineageDetached = true;
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("desktop-btw")?.sidechat).toBeUndefined();
      expect(f.eventLog.replay(0).some(event => event.type === "session.observed")).toBe(false);
    } finally { await f.close(); }
  });

  it("requires a btw question before forking and forwards other native commands unchanged", async () => {
    const f = await fixture();
    try {
      await expect(f.bridge.runCommand({ ...input, text: "/btw   " })).rejects.toThrow(/question/iu);
      expect(f.native.calls.some(call => ["startBtwChild", "forkSession", "sendMessage"].includes(call.method))).toBe(false);
      expect(await f.bridge.runCommand({ ...input, text: "/compact" })).toEqual({ action: "sent" });
      expect(f.native.calls.find(call => call.method === "sendMessage")?.args.slice(0, 2)).toEqual(["local-native", "/compact"]);
    } finally { await f.close(); }
  });
});
