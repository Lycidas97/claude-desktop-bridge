import { rm, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRIDGE_HOOK_URL, readClaudeModelOptions, removeLegacyConnector, type ConnectorPaths } from "./connector.js";

let directory: string;
let paths: ConnectorPaths;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bridge-connector-"));
  paths = {
    claudeDesktop: [join(directory, "desktop.json")],
    claudeCode: join(directory, "code.json"),
    claudeSettings: join(directory, "settings.json"),
  };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("saved Claude model directory", () => {
  it("projects only model and label, preserves order and context suffixes, and never rewrites settings", async () => {
    const original = JSON.stringify({ env: { PRIVATE_ACCOUNT: "fixture-private-value" }, modelPicker: { options: [
      { model: "custom-z[1m]", label: "Z large context", description: "private-account-description" },
      { model: "custom-a", label: "A", env: { PRIVATE_TOKEN: "fixture-private-token" } },
      null, { model: "missing-label" }, { model: 1, label: "invalid" },
    ] } });
    await writeFile(paths.claudeSettings, original);
    expect(await readClaudeModelOptions(paths.claudeSettings)).toEqual([{ value: "custom-z[1m]", displayName: "Z large context" }, { value: "custom-a", displayName: "A" }]);
    expect(await readFile(paths.claudeSettings, "utf8")).toBe(original);
  });

  it("keeps private settings fragments out of parse errors", async () => {
    await writeFile(paths.claudeSettings, '{"env":private}');
    const error = await readClaudeModelOptions(paths.claudeSettings).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('"env"');
    expect(String(error)).not.toContain("private");
  });

  it("reports missing or unusable directories without historical model guesses", async () => {
    expect(await readClaudeModelOptions(paths.claudeSettings)).toBeUndefined();
    for (const settings of [{}, { modelPicker: { options: [] } }, { modelPicker: { options: [{ model: "no-label" }] } }]) {
      await writeFile(paths.claudeSettings, JSON.stringify(settings));
      expect(await readClaudeModelOptions(paths.claudeSettings)).toBeUndefined();
    }
  });
});

describe("legacy connector migration", () => {
  it("backs up and removes fixed and marked dynamic Bridge hooks across lifecycle events", async () => {
    const dynamicHook = {
      type: "http",
      url: "http://127.0.0.1:51234/hooks/claude-permission",
      timeout: 600,
      headers: {
        Authorization: "Bearer old-bridge-token",
        "X-Bridge-Permission-Host": "$BRIDGE_PERMISSION_HOST",
      },
      allowedEnvVars: ["BRIDGE_PERMISSION_HOST"],
    };
    const userHook = { type: "command", command: "user-permission-hook" };
    const settings = {
      env: { USER_SETTING: "kept" },
      permissions: { allow: ["Read"] },
      mcpServers: { unrelated: { command: "user-server" } },
      hooks: {
        PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "http", url: BRIDGE_HOOK_URL }, dynamicHook, userHook] }],
        ...Object.fromEntries(["PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"].map(event => [event, [{
          hooks: [{ ...dynamicHook, url: "http://127.0.0.1:62451/hooks/claude-permission", timeout: 5 }],
        }]])),
        PreToolUse: [{ matcher: "Read", hooks: [userHook] }],
        Notification: [],
        CustomEvent: { user: "kept" },
      },
    };
    const original = `${JSON.stringify(settings, null, 2)}\n`;
    await writeFile(paths.claudeSettings, original);

    expect(await removeLegacyConnector(paths)).toBe(true);
    expect(await readFile(`${paths.claudeSettings}.bridge-backup`, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(paths.claudeSettings, "utf8"))).toEqual({
      ...settings,
      hooks: {
        PermissionRequest: [{ matcher: "Bash", hooks: [userHook] }],
        PreToolUse: settings.hooks.PreToolUse,
        Notification: [],
        CustomEvent: settings.hooks.CustomEvent,
      },
    });
    expect(await removeLegacyConnector(paths)).toBe(false);
    expect(await readFile(`${paths.claudeSettings}.bridge-backup`, "utf8")).toBe(original);
  });

  it("preserves unmarked and unrelated hooks without rewriting settings", async () => {
    const marker = {
      headers: { "X-Bridge-Permission-Host": "$BRIDGE_PERMISSION_HOST" },
      allowedEnvVars: ["BRIDGE_PERMISSION_HOST"],
    };
    const original = JSON.stringify({
      env: { BRIDGE_PERMISSION_HOST: "user-owned-value" },
      hooks: {
        PermissionRequest: [{ hooks: [
          { type: "http", url: "http://127.0.0.1:51234/hooks/claude-permission" },
          { type: "http", url: "http://127.0.0.1:51234/hooks/claude-permission", headers: marker.headers },
          { type: "http", url: "http://127.0.0.1:51234/hooks/claude-permission", allowedEnvVars: marker.allowedEnvVars },
          { type: "http", url: "http://127.0.0.1:51234/hooks/claude/permission", ...marker },
          { type: "http", url: "http://127.0.0.1:51234/user-hook", ...marker },
          { type: "http", url: "http://other-host:51234/hooks/claude-permission", ...marker },
          { type: "http", url: "https://127.0.0.1:51234/hooks/claude-permission", ...marker },
          { type: "http", url: "not-a-url", ...marker },
          { type: "command", command: BRIDGE_HOOK_URL },
          null,
        ] }],
        PreToolUse: [{ matcher: "Bash", command: "user-hook" }],
        Notification: [],
      },
    });
    await writeFile(paths.claudeSettings, original);

    expect(await removeLegacyConnector(paths)).toBe(false);
    expect(await readFile(paths.claudeSettings, "utf8")).toBe(original);
    await expect(readFile(`${paths.claudeSettings}.bridge-backup`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("backs up legacy MCP configs and preserves other servers and user settings", async () => {
    for (const path of [...paths.claudeDesktop, paths.claudeCode]) {
      const original = JSON.stringify({
        mcpServers: { "claude-bridge": { command: "old-bridge" }, user: { command: "user-server" } },
        preferences: { theme: "dark" },
      });
      await writeFile(path, original);
    }

    expect(await removeLegacyConnector(paths)).toBe(true);
    for (const path of [...paths.claudeDesktop, paths.claudeCode]) {
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        mcpServers: { user: { command: "user-server" } },
        preferences: { theme: "dark" },
      });
      expect(JSON.parse(await readFile(`${path}.bridge-backup`, "utf8"))).toHaveProperty("mcpServers.claude-bridge");
    }
    expect(await removeLegacyConnector(paths)).toBe(false);
  });

  it("leaves missing config files absent", async () => {
    expect(await removeLegacyConnector(paths)).toBe(false);
    for (const path of [...paths.claudeDesktop, paths.claudeCode, paths.claudeSettings]) {
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
