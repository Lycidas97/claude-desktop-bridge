import { spawnSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { isAssistantTool, WorkspaceProvisioner } from "./assistant-workspace.js";

let root: string;
let options: ConstructorParameters<typeof WorkspaceProvisioner>[0];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "assistant-workspace-")));
  options = { userDataPath: root, appPath: join(root, "App Space's $, work", "app.asar"), execPath: join(root, "Bridge's App", "Bridge") };
});

it("writes the exact project policy and bundled MCP launch, preserving templates across token rotation", async () => {
  const provisioner = new WorkspaceProvisioner(options);
  const workspace = await provisioner.prepare("first-session-token");
  expect(workspace).toBe(join(root, "private", "assistant", "workspace"));
  expect(provisioner.path).toBe(workspace);
  const config = join(workspace, ".mcp.json");
  const settings = join(workspace, ".claude", "settings.json");
  const projectRules = join(workspace, "CLAUDE.md");
  const helper = join(workspace, ".claude", "agents", "assistant-helper.md");
  const runner = join(workspace, ".claude", "agents", "assistant-runner.md");
  expect(await readFile(projectRules, "utf8")).toContain("outputs/");
  expect(await readFile(helper, "utf8")).toContain("name: assistant-helper");
  await writeFile(projectRules, "existing rules");
  await writeFile(helper, "existing helper");
  await writeFile(settings, "{}");
  const rotated = "a".repeat(64);
  await provisioner.prepare(rotated);
  expect(await readFile(projectRules, "utf8")).toBe("existing rules");
  expect(await readFile(helper, "utf8")).toBe("existing helper");
  expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ mcpServers: { "assistant-mail": {
    type: "stdio", command: options.execPath,
    args: [join(options.appPath, "dist", "assistant-mcp.cjs"), join(root, "private", "assistant", "mail-tools.json"), "--managed"],
    env: { ELECTRON_RUN_AS_NODE: "1", BRIDGE_ASSISTANT_SESSION_TOKEN: rotated },
  } } });
  const policy = JSON.parse(await readFile(settings, "utf8"));
  expect(policy).toMatchObject({
    agent: "assistant-runner",
    autoMemoryEnabled: false, enableAllProjectMcpServers: false, enabledMcpjsonServers: ["assistant-mail"],
    permissions: {
      defaultMode: "dontAsk",
      deny: expect.arrayContaining(["Bash", "NotebookEdit", "WebFetch", "WebSearch", "SendMessage", "mcp__ccd_*", "Read(./.mcp.json)"]),
    },
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", onFailure: "block" }] }] },
  });
  expect(policy.permissions.allow.every(isAssistantTool)).toBe(true);
  expect(await readFile(runner, "utf8")).toBe(`---\n# Managed by Bridge: assistant-runner\nname: assistant-runner\ndescription: 托管助理主会话\ntools: ${policy.permissions.allow.join(", ")}\n---\n`);
  expect(JSON.stringify(policy)).not.toContain(rotated);
  if (process.platform !== "win32") {
    const [entry] = policy.hooks.PreToolUse[0].hooks;
    expect(entry.command).toBe("/usr/bin/env");
    expect(entry.args).toEqual(["ELECTRON_RUN_AS_NODE=1", options.execPath, join(options.appPath, "dist", "assistant-fs-guard.cjs"), workspace]);
    for (const dir of [workspace, join(workspace, "outputs"), join(workspace, ".claude", "agents")]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    for (const file of [config, settings]) expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
});

it.each([false, true])("upgrades a generated helper without proposals (has trigger tool: %s)", async hasTriggerTool => {
  const provisioner = new WorkspaceProvisioner(options);
  const workspace = await provisioner.prepare("session-token");
  const helper = join(workspace, ".claude", "agents", "assistant-helper.md");
  const current = await readFile(helper, "utf8");
  const previous = current.replace(/mcp__assistant-mail__proposal_\w+, /gu, "");
  await writeFile(helper, hasTriggerTool ? previous : previous.replace("mcp__assistant-mail__mail_list_unfinished_triggers, ", ""));

  await provisioner.restore("session-token", workspace);
  expect(await readFile(helper, "utf8")).toBe(current);
});

it.each(["file", "link"])("restores the workspace without taking over an existing runner %s", async kind => {
  const provisioner = new WorkspaceProvisioner(options);
  const agents = join(provisioner.path, ".claude", "agents");
  const existing = join(agents, "assistant-runner.md");
  const custom = "---\nname: assistant-runner\ndescription: User agent\ntools: Read\n---\nUser instructions\n";
  await mkdir(agents, { recursive: true });
  if (kind === "file") await writeFile(existing, custom);
  else await symlink(root, existing, "junction");

  await expect(provisioner.restore("saved-token", provisioner.path)).resolves.toBe(provisioner.path);
  if (kind === "file") expect(await readFile(existing, "utf8")).toBe(custom);
  else expect((await lstat(existing)).isSymbolicLink()).toBe(true);
  expect(provisioner.repairFailed).toBe(false);
  const settings = join(provisioner.path, ".claude", "settings.json");
  const policy = JSON.parse(await readFile(settings, "utf8"));
  expect(policy.agent).not.toBe("assistant-runner");
  expect(await readFile(join(agents, `${policy.agent}.md`), "utf8")).toContain(`tools: ${policy.permissions.allow.join(", ")}`);
  await provisioner.restore("saved-token", provisioner.path);
  expect(JSON.parse(await readFile(settings, "utf8")).agent).toBe(policy.agent);
});

it("checks physical membership through directory aliases and refuses to overwrite linked configs", async () => {
  const provisioner = new WorkspaceProvisioner(options);
  await expect(provisioner.contains(root)).resolves.toBe(false);
  const workspace = await provisioner.prepare("session-token");
  const alias = join(root, "workspace-alias");
  await symlink(workspace, alias, "junction");
  await symlink(root, join(workspace, "outside"), "junction");
  await expect(provisioner.contains(join(alias, "outputs"))).resolves.toBe(true);
  await expect(provisioner.contains(join(workspace, "outside"))).resolves.toBe(false);

  const linked = new WorkspaceProvisioner({ ...options, userDataPath: join(root, "other-profile") });
  const linkedRoot = await linked.prepare("session-token");
  // A managed file backed by a shared inode must not be overwritten during rotation.
  const original = join(linkedRoot, ".mcp.json");
  const shared = join(root, "shared.json");
  await link(original, shared);
  await expect(linked.prepare("new-token")).rejects.toThrow("regular, unlinked files");
  expect(await readFile(shared, "utf8")).not.toContain("new-token");
});

it("uses an exec-form Windows launcher that passes raw stdin and propagates the guard exit code", async () => {
  const workspace = await new WorkspaceProvisioner({ ...options, platform: "win32" }).prepare("session-token");
  const policy = JSON.parse(await readFile(join(workspace, ".claude", "settings.json"), "utf8"));
  const [entry] = policy.hooks.PreToolUse[0].hooks;
  expect(entry.command).toBe("powershell.exe");
  expect(entry.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = Buffer.from(entry.args.at(-1), "base64").toString("utf16le");
  expect(script).toContain(options.execPath.replaceAll("'", "''"));
  expect(script).toContain(`"${join(options.appPath, "dist", "assistant-fs-guard.cjs").replaceAll("'", "''")}" "${workspace}"`);
  expect(script).toContain("$p.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'");
  expect(script).toContain("$p.UseShellExecute = $false");
  expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
  expect(script).toContain("exit $child.ExitCode");
});

it.runIf(process.platform === "win32")("passes UTF-8 hook stdin unchanged through the Windows launcher", async () => {
  const workspace = await new WorkspaceProvisioner({ ...options, execPath: process.execPath }).prepare("session-token");
  const policy = JSON.parse(await readFile(join(workspace, ".claude", "settings.json"), "utf8"));
  const [entry] = policy.hooks.PreToolUse[0].hooks;
  const guard = join(options.appPath, "dist", "assistant-fs-guard.cjs");
  await mkdir(join(options.appPath, "dist"), { recursive: true });
  await writeFile(guard, `process.stdin.pipe(process.stdout); process.stdin.pipe(process.stderr); process.exitCode = 2;`);
  const input = Buffer.from(JSON.stringify({ cwd: workspace, tool_input: { file_path: "outputs/稿件.txt" } }), "utf8");
  const child = spawnSync(entry.command, entry.args, { input, timeout: 10000 });
  expect(child.error).toBeUndefined();
  expect(child.stdout).toEqual(input);
  expect(child.stderr).toEqual(input);
  expect(child.status).toBe(2);
}, 15000);
