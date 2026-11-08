import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeNativePermissionModeChange, BridgePermissionInfo, BridgeRequest } from "../../packages/protocol/src/index.js";
import type { SessionBroker } from "../../apps/desktop/src/session-broker.js";
import { ClaudePermissionHook } from "../../apps/desktop/src/claude-permission-hook.js";
import { DesktopController } from "../../apps/desktop/src/controller.js";
import { PermissionBroker, type PendingPermission } from "../../apps/desktop/src/permission-broker.js";
import { discoverSlashCommands } from "../../apps/desktop/src/slash-command-catalog.js";

/** Only synthetic native events; the controller's real permission.resolve branch owns decisions. */
export async function startNativeApprovalHost(options: {
  directory: string;
  sessionId: string;
  deviceId: string;
  requestTimeoutMs?: number;
  onRequested(request: BridgePermissionInfo): void;
  onResolved(request: PendingPermission, result: unknown, resolution: Record<string, unknown>): void;
  onModeChanged?(change: BridgeNativePermissionModeChange): void;
}) {
  const broker = new PermissionBroker();
  broker.on("requested", (request: PendingPermission) => options.onRequested({ ...request, canAllowAlways: false }));
  broker.on("resolved", options.onResolved);
  broker.on("native-mode", () => options.onModeChanged?.(broker.nativeModeChange(options.sessionId)!));
  const hook = new ClaudePermissionHook({
    settingsPath: join(options.directory, "synthetic-settings.json"), broker,
    sessionId: (nativeId) => nativeId === "synthetic-native-session" ? options.sessionId : undefined,
  });
  await hook.start();
  const installed = JSON.parse(await readFile(join(options.directory, "synthetic-settings.json"), "utf8")).hooks.PermissionRequest[0].hooks[0];
  const commandCwd = join(options.directory, "command-project");
  const commandHome = join(options.directory, "command-personal");
  await mkdir(join(commandCwd, ".claude/commands/frontend"), { recursive: true });
  await mkdir(join(commandHome, "skills/audit"), { recursive: true });
  await writeFile(join(commandHome, "skills/audit/SKILL.md"), "---\nname: inspect-changes\ndescription: 核对当前改动\nargument-hint: '[path]'\n---\nSynthetic fixture body; never sent to the model.\n");
  await writeFile(join(commandCwd, ".claude/commands/frontend/component.md"), "---\ndescription: 检查组件结构\nargument-hint: '[component]'\n---\nSynthetic command body.\n");
  for (const [name, description] of [["review", "审查当前改动"], ["report", "整理结果报告"], ...Array.from({ length: 12 }, (_, index) => [`tool-${String(index + 1).padStart(2, "0")}`, `示例工具 ${index + 1}`])]) {
    await writeFile(join(commandCwd, `.claude/commands/${name}.md`), `---\ndescription: ${description}\nargument-hint: '[path]'\n---\nSynthetic command body.\n`);
  }
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    routesToExternalRuntime: () => false,
    broker: {
      async commands(sessionId: string) {
        if (sessionId !== options.sessionId) throw new Error("Unknown synthetic session");
        return { sessionId, ...await discoverSlashCommands(commandCwd, commandHome) };
      },
      resolvePermission: (...[id, decision, message, input, resolver, nativeMode]: Parameters<SessionBroker["resolvePermission"]>) =>
        broker.resolveRequest(id, decision, message, input, resolver, nativeMode ? { nativeMode } : undefined),
    },
    config: { hostDeviceId: "synthetic-desktop", desktopName: "隔离电脑", devices: [{ deviceId: options.deviceId, name: "隔离手机", platform: "android", pairedAt: 1 }] },
  }) as { handleRequest(request: BridgeRequest, origin: "mobile", deviceId: string): Promise<unknown> };
  let sequence = 0;
  return {
    cwd: commandCwd,
    commands: (request: BridgeRequest) => controller.handleRequest(request, "mobile", options.deviceId),
    list: () => broker.list(),
    modeChange: () => broker.nativeModeChange(options.sessionId),
    async observe(request: PendingPermission, mode: string) {
      const reply = await fetch(installed.url, {
        method: "POST", headers: { "Content-Type": "application/json", ...installed.headers },
        body: JSON.stringify({ session_id: "synthetic-native-session", hook_event_name: "PostToolUse", tool_name: request.toolName,
          tool_input: request.input, tool_use_id: request.toolUseId, permission_mode: mode }),
      });
      if (!reply.ok) throw new Error(`Synthetic native observation HTTP ${reply.status}`);
    },
    async open(toolName: string, input: Record<string, unknown>) {
      const requested = once(broker, "requested");
      const response = fetch(installed.url, {
        method: "POST", headers: { "Content-Type": "application/json", ...installed.headers },
        body: JSON.stringify({ session_id: "synthetic-native-session", hook_event_name: "PermissionRequest", tool_name: toolName, tool_input: input, tool_use_id: `native-browser-tool-${++sequence}` }),
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30_000),
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
