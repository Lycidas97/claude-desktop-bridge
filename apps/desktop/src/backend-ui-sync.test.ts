import { EventEmitter } from "node:events";
import { rm, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BridgeDesktopRuntime, BridgeRequest } from "@bridge/protocol";
import { DesktopController } from "./controller.js";
import { discoverClaudeGatewayModels } from "./claude-runtime-discovery.js";

vi.mock("electron", () => ({ shell: {} }));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("reports gateway discovery HTTP failure separately from an empty successful catalog", async () => {
  await expect(discoverClaudeGatewayModels({ environment: { ANTHROPIC_BASE_URL: "https://gateway.invalid" } },
    vi.fn(async () => new Response("private error", { status: 503 })) as typeof fetch)).rejects.toThrow(/503/u);
});

function controller(fields: Record<string, unknown>) {
  return Object.assign(Object.create(DesktopController.prototype), fields) as {
    handleRequest(request: BridgeRequest, origin: "desktop" | "mobile"): Promise<unknown>;
    desktopRuntimes(): BridgeDesktopRuntime[];
  };
}
function request(method: BridgeRequest["method"], params: Record<string, unknown> = {}): BridgeRequest {
  return { kind: "request", requestId: "test", idempotencyKey: "test", method, params };
}

it("lists one directory level and recents for local and paired requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-ui-directory-")); roots.push(root);
  await mkdir(join(root, "child")); await mkdir(join(root, "child", "grandchild")); await writeFile(join(root, "file"), "not read");
  const c = controller({ allSessions: () => [{ cwd: root }, { cwd: root }], allProjects: () => [{ cwd: join(root, "child") }] });
  for (const origin of ["desktop", "mobile"] as const) {
    expect(await c.handleRequest(request("directory.list", { path: root }), origin)).toEqual({ listing: {
      path: root, parentPath: dirname(root), directories: [{ name: "child", path: join(root, "child") }], recentPaths: [root, join(root, "child")],
    } });
  }
  await expect(c.handleRequest(request("directory.list", { path: "relative" }), "mobile")).rejects.toThrow(/absolute/u);
});

it("writes runtime defaults without a session and broadcasts through publish", async () => {
  const setHostPermissionMode = vi.fn(async () => 0), publish = vi.fn(async () => {});
  const config = { runtimePermissionModes: {}, defaultPermissionMode: "standard", devices: [] };
  const c = controller({ config, repository: { save: vi.fn(async () => {}) }, eventLog: { append: vi.fn(async () => {}) },
    runtimeSessions: { setHostPermissionMode }, publish });
  expect(await c.handleRequest(request("permission.policy.configure", { scope: "host", runtimeId: "codex-desktop", mode: "full-access" }), "mobile"))
    .toMatchObject({ runtimeId: "codex-desktop", defaultPermissionMode: "full-access" });
  expect(config.runtimePermissionModes).toEqual({ "codex-desktop": "full-access" });
  expect(setHostPermissionMode).toHaveBeenCalledWith("codex-desktop", "full-access"); expect(publish).toHaveBeenCalled();
});

it("broadcasts changed runtime defaults even when the session set is unchanged", async () => {
  const snapshot = { sessions: [], permissions: [], host: { defaultPermissionMode: "standard" }, runtimes: [{ id: "codex-desktop", defaultPermissionMode: "standard" }] };
  const broadcast = vi.fn(async () => {});
  const c = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    snapshot: async () => snapshot, broadcast, eventLog: { append: vi.fn() },
    lastPublishedSessionKey: "", lastPublishedSessions: new Map<string, string>(),
    lastPublishedPermissions: new Map(), claudePermissions: () => [],
  });
  await c.publish();
  broadcast.mockClear();
  snapshot.runtimes[0]!.defaultPermissionMode = "full-access";
  await c.publish();
  expect(broadcast).toHaveBeenCalledWith({ kind: "snapshot", snapshot }, true);
  expect(c.eventLog.append).not.toHaveBeenCalled();
});

it("broadcasts changed Magpie settings without depending on a changed session or detection timestamp", async () => {
  const snapshot = { sessions: [], permissions: [], magpie: { mode: "auto", keyConfigured: true } };
  const broadcast = vi.fn(async () => {});
  const c = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    snapshot: async () => snapshot, broadcast, eventLog: { append: vi.fn() },
    lastPublishedSessionKey: "", lastPublishedSessions: new Map<string, string>(),
    lastPublishedPermissions: new Map(), claudePermissions: () => [],
  });
  await c.publish();
  broadcast.mockClear();
  snapshot.magpie.mode = "manual";
  await c.publish();
  expect(broadcast).toHaveBeenCalledWith({ kind: "snapshot", snapshot }, true);
  expect(c.eventLog.append).not.toHaveBeenCalled();
});

it("rejects permission runtime and session mismatch", async () => {
  const c = controller({ config: { devices: [] } });
  await expect(c.handleRequest(request("permission.policy.configure", {
    scope: "host", runtimeId: "hermes-desktop", sessionId: "codex-desktop:task", mode: "full-access",
  }), "desktop")).rejects.toThrow(/does not match the session runtime/u);
});
