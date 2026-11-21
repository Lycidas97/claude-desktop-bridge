import { createControllerFixture } from "../controller/controller-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { fixture } from "./claude-desktop-bridge-fixture.js";

describe("native tool permissions", () => {
  it.each(["default", "acceptEdits", "bypassPermissions", "plan", "auto", "dontAsk"])("projects the current native %s mode without a prior mode change", async mode => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.permissionMode = mode;
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({ nativePermissionMode: mode });
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toBeUndefined();
      delete f.native.sessions[0]!.permissionMode;
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).not.toHaveProperty("nativePermissionMode");
    } finally { await f.close(); }
  });

  it("forwards permission IDs and native modes without a Bridge auto-approval policy", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "native-ask", sessionId: "local-native", toolName: "AskUserQuestion", input: { questions: [] } }];
      await f.bridge.refreshRuntime();
      expect(f.bridge.permissionsList()).toMatchObject([{ requestId: "native-ask", canAllowAlways: false }]);
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
      expect(await f.bridge.resolvePermission("native-ask", "allow-once", undefined, { answers: { x: "yes" } })).toBe(true);
      expect(f.native.calls.find(call => call.method === "respondToToolPermission")?.args).toEqual(["native-ask", "once", { questions: [], answers: { x: "yes" } }]);
      const configured = await f.bridge.configureSession({ sessionId: "local-native", permissionMode: "plan" });
      expect(configured.nativePermissionMode).toBe("plan");
      expect(configured.permissionPolicy).toBeUndefined();
    } finally { await f.close(); }
  });

  it.each(["default", "acceptEdits", "bypassPermissions"] as const)("sets native %s before approving ExitPlanMode and confirms it from Desktop", async mode => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.permissionMode = "plan";
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "exit-plan", toolName: "ExitPlanMode", input: { plan: "Implement" } }];
      await f.bridge.refreshRuntime();
      expect(f.bridge.permissionsList()[0]?.canSetNativeFullAccess).toBe(true);
      const changes: unknown[] = [];
      f.bridge.on("changed", () => changes.push(f.bridge.session("local-native")?.nativePermissionModeChange));
      f.native.calls = [];
      expect(await f.bridge.resolvePermission("exit-plan", "allow-once", "Keep the diff small", { plan: "Updated" }, { deviceId: "phone", name: "Phone" }, mode)).toBe(true);
      expect(f.native.calls.filter(call => ["setPermissionMode", "respondToToolPermission"].includes(call.method))).toEqual([
        { method: "setPermissionMode", args: ["local-native", mode] },
        { method: "respondToToolPermission", args: ["exit-plan", "once", { plan: "Updated", _feedbackMessage: "Keep the diff small" }] },
      ]);
      expect(changes).toContainEqual({ requestId: "exit-plan", mode, state: "requested" });
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toEqual({ requestId: "exit-plan", mode, state: "confirmed", observedMode: mode });
      expect((await f.bridge.configuration("local-native")).nativePermissionMode).toBe(mode);
      expect(f.eventLog.replay(0).find(event => event.type === "permission.resolved")?.data).toMatchObject({ resolvedByDeviceId: "phone", resolvedByName: "Phone" });
    } finally { await f.close(); }
  });

  it("does not approve when the native mode setter is unsupported or rejects the choice", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "exit-plan", toolName: "ExitPlanMode", input: {} }];
      f.native.unsupported.add("setPermissionMode");
      await f.bridge.refreshRuntime();
      expect(f.bridge.permissionsList()[0]?.canSetNativeFullAccess).toBe(false);
      await expect(f.bridge.resolvePermission("exit-plan", "allow-once", undefined, undefined, undefined, "bypassPermissions")).rejects.toThrow(/unsupported/iu);
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
      f.native.unsupported.clear();
      f.native.permissionModeResult = false;
      await expect(f.bridge.resolvePermission("exit-plan", "allow-once", undefined, undefined, undefined, "bypassPermissions")).rejects.toThrow(/permission mode/iu);
      expect(f.bridge.permissionsList()).toHaveLength(1);
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toMatchObject({ state: "not-applied", observedMode: "default" });
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
    } finally { await f.close(); }
  });

  it("does not confirm a mode from the setter acknowledgment when Desktop metadata differs", async () => {
    const f = await fixture();
    try {
      f.native.applyPermissionMode = false;
      f.native.sessions[0]!.permissionMode = "plan";
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "exit-plan", toolName: "ExitPlanMode", input: {} }];
      await f.bridge.refreshRuntime();
      await f.bridge.resolvePermission("exit-plan", "allow-once", undefined, undefined, undefined, "acceptEdits");
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toEqual({ requestId: "exit-plan", mode: "acceptEdits", state: "not-applied", observedMode: "plan" });
      expect(f.bridge.session("local-native")?.nativePermissionMode).toBe("plan");
      f.native.sessions[0]!.permissionMode = "acceptEdits";
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.nativePermissionModeChange?.state).toBe("confirmed");
    } finally { await f.close(); }
  });

  it("denies with feedback without changing native mode even when a mode was supplied", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "exit-plan", toolName: "ExitPlanMode", input: { plan: "Implement" } }];
      f.native.unsupported.add("setPermissionMode");
      await f.bridge.refreshRuntime();
      expect(await f.bridge.resolvePermission("exit-plan", "deny", "Revise the plan", undefined, undefined, "bypassPermissions")).toBe(true);
      expect(f.native.calls.some(call => call.method === "setPermissionMode")).toBe(false);
      expect(f.native.calls.find(call => call.method === "respondToToolPermission")?.args).toEqual(["exit-plan", "deny", { plan: "Implement", _feedbackMessage: "Revise the plan" }]);
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toBeUndefined();
    } finally { await f.close(); }
  });

  it("projects a permission stream event as waiting immediately and ignores unknown sessions", async () => {
    const f = await fixture();
    try {
      const permission = { requestId: "stream-permission", sessionId: "local-native", toolName: "Bash", input: { command: "pwd" } };
      f.native.emit("permission", { ...permission, requestId: "foreign", sessionId: "unknown-native" });
      expect(f.bridge.permissionsList()).toEqual([]);
      f.native.emit("permission", permission);
      expect(f.bridge.permissionsList()).toMatchObject([{ requestId: "stream-permission", sessionId: "local-native" }]);
      expect(f.bridge.session("local-native")?.turnState).toBe("waiting");
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
    } finally { await f.close(); }
  });

  it("resolves only the native request ID that was selected", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "first", sessionId: "local-native", toolName: "Bash", input: {} }];
      f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native", pendingToolPermissions: [{ requestId: "other", sessionId: "other-native", toolName: "Bash", input: {} }] });
      await f.bridge.refreshRuntime();
      expect(await f.bridge.resolvePermission("missing", "allow-once")).toBe(false);
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
      expect(await f.bridge.resolvePermission("first", "allow-once")).toBe(true);
      expect(f.bridge.permissionsList().map(permission => permission.requestId)).toEqual(["other"]);
      expect(f.bridge.session("other-native")?.turnState).toBe("waiting");
      expect(f.eventLog.replay(0).filter(event => event.type === "permission.resolved").map(event => event.data.requestId)).toEqual(["first"]);
    } finally { await f.close(); }
  });

  it("does not report permission resolution while Desktop still lists the request", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "pending", sessionId: "local-native", toolName: "Bash", input: {} }];
      await f.bridge.refreshRuntime();
      const original = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation((method, args) => method === "respondToToolPermission" ? Promise.resolve(undefined) : original(method, args));
      expect(await f.bridge.resolvePermission("pending", "allow-once")).toBe(false);
      expect(f.bridge.permissionsList()).toHaveLength(1);
      expect(f.eventLog.replay(0).some(event => event.type === "permission.resolved")).toBe(false);
    } finally { await f.close(); }
  });

  it("does not let the passive permission diff preempt a manual resolution", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "manual-permission", sessionId: "local-native", toolName: "Bash", input: {} }];
      await f.bridge.refreshRuntime();
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      await controller.publishPermissions();
      const passive: Array<Promise<void>> = [];
      f.bridge.on("changed", () => { passive.push(controller.publishPermissions()); });
      expect(await f.bridge.resolvePermission("manual-permission", "allow-once", undefined, undefined, { deviceId: "phone-1", name: "Phone" })).toBe(true);
      await Promise.all(passive);
      const resolved = f.eventLog.replay().filter(event => event.type === "permission.resolved" && event.data.requestId === "manual-permission");
      expect(resolved.map(event => event.data)).toEqual([expect.objectContaining({
        requestId: "manual-permission", decision: "allow-once", resolvedByDeviceId: "phone-1", resolvedByName: "Phone",
      })]);
    } finally { await f.close(); }
  });
});
