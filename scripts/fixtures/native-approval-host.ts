import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BridgePermissionInfo, BridgeRequest } from "../../packages/protocol/src/index.js";
import { ClaudePermissionHook } from "../../apps/desktop/src/claude-permission-hook.js";
import { DesktopController } from "../../apps/desktop/src/controller.js";
import { PermissionBroker, type PendingPermission } from "../../apps/desktop/src/permission-broker.js";

/** Only synthetic native events; the controller's real permission.resolve branch owns decisions. */
export async function startNativeApprovalHost(options: {
  directory: string;
  sessionId: string;
  deviceId: string;
  onRequested(request: BridgePermissionInfo): void;
  onResolved(request: PendingPermission, result: unknown, resolution: Record<string, unknown>): void;
}) {
  const broker = new PermissionBroker();
  broker.on("requested", (request: PendingPermission) => options.onRequested({ ...request, canAllowAlways: false }));
  broker.on("resolved", options.onResolved);
  const hook = new ClaudePermissionHook({
    settingsPath: join(options.directory, "synthetic-settings.json"), broker,
    sessionId: (nativeId) => nativeId === "synthetic-native-session" ? options.sessionId : undefined,
  });
  await hook.start();
  const installed = JSON.parse(await readFile(join(options.directory, "synthetic-settings.json"), "utf8")).hooks.PermissionRequest[0].hooks[0];
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { resolvePermission: (...args: Parameters<PermissionBroker["resolveRequest"]>) => broker.resolveRequest(...args) },
    config: { hostDeviceId: "synthetic-desktop", desktopName: "隔离电脑", devices: [{ deviceId: options.deviceId, name: "隔离手机", platform: "android", pairedAt: 1 }] },
  }) as { handleRequest(request: BridgeRequest, origin: "mobile", deviceId: string): Promise<unknown> };
  let sequence = 0;
  return {
    list: () => broker.list(),
    async open(toolName: string, input: Record<string, unknown>) {
      const requested = once(broker, "requested");
      const response = fetch(installed.url, {
        method: "POST", headers: { "Content-Type": "application/json", ...installed.headers },
        body: JSON.stringify({ session_id: "synthetic-native-session", hook_event_name: "PermissionRequest", tool_name: toolName, tool_input: input, tool_use_id: `native-browser-tool-${++sequence}` }),
        signal: AbortSignal.timeout(30_000),
      }).then(async (reply) => {
        if (!reply.ok) throw new Error(`Synthetic native Hook HTTP ${reply.status}`);
        return reply.json();
      });
      const [request] = await requested as [PendingPermission];
      return { request, response };
    },
    resolve: (request: BridgeRequest) => controller.handleRequest(request, "mobile", options.deviceId),
    close: () => hook.close(),
  };
}
