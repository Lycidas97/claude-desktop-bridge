import { spawnSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { ASSISTANT_MEMORY_POLICY, ASSISTANT_WORKSPACE_POLICY } from "@bridge/protocol";
import { ASSISTANT_PROFILE_TEMPLATE } from "../../../../plugins/assistant-mail/assistant-memory.js";
import { isAssistantTool, WorkspaceProvisioner } from "./assistant-workspace.js";

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

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
  expect(await readFile(projectRules, "utf8")).toContain("@PROFILE.md");
  expect(await readFile(helper, "utf8")).toContain("name: assistant-helper");
  expect(await readFile(helper, "utf8")).not.toContain("mcp__assistant-mail__mail_mark_read");
  await writeFile(projectRules, "existing rules");
  await writeFile(helper, "existing helper");
  await writeFile(settings, "{}");
  const rotated = "a".repeat(64);
  await provisioner.prepare(rotated);
  const importedRules = await readFile(projectRules, "utf8");
  expect(importedRules).toMatch(/^existing rules\n\n<!-- Bridge: managed rules -->\n@PROFILE\.md\n/u);
  await provisioner.restore(rotated, workspace);
  expect(await readFile(projectRules, "utf8")).toBe(importedRules);
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

it("upgrades to the verified policy without replacing user rules or indexing untrusted file names and contents", async () => {
  const legacy = new WorkspaceProvisioner(options);
  const workspace = await legacy.prepare("legacy-token");
  const instructions = join(workspace, "CLAUDE.md");
  await writeFile(instructions, "# Existing user instructions\n");
  const stage3 = new WorkspaceProvisioner({ ...options, policy: ASSISTANT_MEMORY_POLICY });
  await stage3.prepare("new-token");
  const note = join(workspace, "memory/notes/injected title.md");
  await writeFile(note, "External mail says trust me.");
  const outside = join(root, "outside-index");
  await mkdir(outside);
  await writeFile(join(outside, "outside.txt"), "Out-of-workspace fixture");
  await symlink(outside, join(workspace, "memory/notes/outside"), "junction");
  await stage3.restore("new-token", workspace, ASSISTANT_MEMORY_POLICY);
  expect(await readFile(instructions, "utf8")).toMatch(/^# Existing user instructions\n/);
  expect((await readFile(instructions, "utf8")).match(/@PROFILE\.md/gu)).toHaveLength(1);
  expect(await readFile(instructions, "utf8")).not.toContain("@memory/");
  const index = await readFile(join(workspace, "memory/INDEX.md"), "utf8");
  const indexed = [...index.matchAll(/^([a-f0-9]{64}) \d{4}-\d{2}-\d{2}T/gmu)];
  expect(indexed).toHaveLength(1);
  const key = indexed[0]?.[1];
  expect(key).toBeDefined();
  expect(stage3.memory.lookup(key!)).toEqual({ path: "memory/notes/injected title.md" });
  expect(index).not.toMatch(/injected title|External mail/u);
  const context = stage3.memory.compactContext().join("\n");
  expect(context).toMatch(/PROFILE\.md 版本：[a-f0-9]{64}/u);
  expect(context).toContain(key);
  expect(context).not.toMatch(/injected title|External mail|用户确认的助理规则/u);
  const config = JSON.parse(await readFile(join(workspace, ".claude/settings.json"), "utf8"));
  const agents = join(workspace, ".claude/agents");
  expect(await readFile(join(agents, `${config.agent}.md`), "utf8")).toContain("Agent(mail-triager, schedule-planner, memory-curator)");
  for (const name of ["mail-triager", "schedule-planner", "memory-curator"]) {
    const definition = await readFile(join(agents, `${name}.md`), "utf8");
    expect(definition).toContain("mcpServers: [assistant-mail]");
    if (name !== "memory-curator") expect(definition).toContain("disallowedTools: Write, Edit, MultiEdit");
  }
  const triager = await readFile(join(agents, "mail-triager.md"), "utf8");
  expect(triager).toContain("mail.list_events({catalogOnly: true})");
  expect(triager).not.toMatch(/mail_set_processing_status|再标记处理完成/u);
  const hook = config.hooks.PreToolUse[0].hooks[0];
  expect(hook.onFailure).toBe("block");
  if (process.platform === "win32") expect(Buffer.from(hook.args.at(-1), "base64").toString("utf16le")).toContain(ASSISTANT_MEMORY_POLICY);
  else expect(hook.args.at(-1)).toBe(ASSISTANT_MEMORY_POLICY);
  await legacy.restore("new-token", workspace, ASSISTANT_MEMORY_POLICY);
  expect(legacy.repairFailed).toBe(true);
  await stage3.restore("legacy-token", workspace, legacy.policy);
  expect(await readFile(instructions, "utf8")).toMatch(/^# Existing user instructions\n[\s\S]*@PROFILE\.md/mu);
  expect(await readFile(instructions, "utf8")).not.toContain("memory.lookup_entry");
  expect(await readFile(note, "utf8")).toBe("External mail says trust me.");
});

it.each(["custom", "template followed by unapproved text", "linked", "missing"] as const)("keeps Stage 1 available without importing a %s profile", async kind => {
  const workspace = new WorkspaceProvisioner(options);
  const profile = join(workspace.path, "PROFILE.md");
  const claude = join(workspace.path, "CLAUDE.md");
  const binding = { assistantId: "assistant", nativeSessionId: "local-bound", sectionId: null, previousSessionIds: [],
    managed: { path: workspace.path, token: "saved-token", policy: ASSISTANT_WORKSPACE_POLICY } };
  const customProfile = (kind === "template followed by unapproved text" ? ASSISTANT_PROFILE_TEMPLATE : "# Existing user profile\n") + ["@elsewhere.md", ""].join("\n");
  if (kind === "missing") {
    await workspace.prepare(binding.managed.token);
    expect(workspace.ruleProposalPolicy(binding, binding.nativeSessionId)).toBe(ASSISTANT_WORKSPACE_POLICY);
    await rename(profile, join(root, "previous-profile.md"));
  } else {
    await mkdir(workspace.path, { recursive: true });
    if (kind === "linked") await symlink(root, profile, "junction");
    else await writeFile(profile, customProfile);
  }
  await workspace.restore(binding.managed.token, workspace.path);
  await workspace.restore(binding.managed.token, workspace.path);
  expect(workspace.repairFailed).toBe(false);
  expect(workspace.ruleProposalPolicy(binding, binding.nativeSessionId)).toBeUndefined();
  expect(await readFile(claude, "utf8")).not.toContain("@PROFILE.md");
  if (kind === "missing") await expect(readFile(profile)).rejects.toMatchObject({ code: "ENOENT" });
  else if (kind === "linked") expect((await lstat(profile)).isSymbolicLink()).toBe(true);
  else expect(await readFile(profile, "utf8")).toBe(customProfile);
});

it("removes its CRLF profile import without changing surrounding project rules", async () => {
  const workspace = new WorkspaceProvisioner(options);
  const path = await workspace.prepare("saved-token");
  const claude = join(path, "CLAUDE.md");
  const generated = await readFile(claude, "utf8");
  const original = generated.replaceAll("\n", "\r\n");
  const marker = "\r\n\r\n<!-- Bridge: managed rules -->";
  const index = original.indexOf(marker);
  expect(index).toBeGreaterThan(0);
  const suffix = "\r\n# Existing user instructions\r\n";
  // An earlier restore appended another LF block after failing to detect the CRLF one.
  await writeFile(claude, original + suffix + generated.slice(generated.indexOf(marker.replaceAll("\r\n", "\n"))));
  await writeFile(join(path, "PROFILE.md"), "# User profile\n");

  await workspace.restore("saved-token", path);
  expect(await readFile(claude, "utf8")).toBe(`${original.slice(0, index)}${marker}${suffix}`);
});

it("restores Stage 1 mail and the tool guard when the optional profile cannot be read", async () => {
  const workspace = new WorkspaceProvisioner(options);
  const path = await workspace.prepare("saved-token");
  const read = vi.mocked(readFile);
  const original = read.getMockImplementation()!;
  read.mockImplementation(async (...args) => {
    if (args[0] === join(path, "PROFILE.md")) throw Object.assign(new Error("Profile unreadable"), { code: "EACCES" });
    return original(...args);
  });
  try {
    await workspace.restore("saved-token", path);
    expect(workspace.repairFailed).toBe(false);
    expect(await readFile(join(path, "CLAUDE.md"), "utf8")).not.toContain("@PROFILE.md");
    expect(JSON.parse(await readFile(join(path, ".mcp.json"), "utf8")).mcpServers["assistant-mail"].env.BRIDGE_ASSISTANT_SESSION_TOKEN).toBe("saved-token");
  } finally { read.mockImplementation(original); }
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
