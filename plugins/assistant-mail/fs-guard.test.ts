import { link, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { ASSISTANT_MEMORY_POLICY } from "../../packages/protocol/src/assistant-mail.js";
import { ASSISTANT_TOOLS, allowAssistantTool } from "./fs-guard.js";
import { MAIL_TOOLS } from "./tool-contract.js";

let root: string;
let workspace: string;
let outputs: string;
let uploads: string;
let privateFile: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "assistant-guard-")));
  workspace = join(root, "workspace");
  outputs = join(workspace, "outputs");
  uploads = join(workspace, ".bridge-uploads", "upload");
  privateFile = join(root, "assistant.sqlite");
  await Promise.all([mkdir(outputs, { recursive: true }), mkdir(uploads, { recursive: true })]);
  await Promise.all([
    writeFile(join(workspace, ".mcp.json"), "private fixture token"),
    writeFile(join(uploads, "attachment.txt"), "attachment"),
    writeFile(join(outputs, "draft.txt"), "draft"),
    writeFile(privateFile, "private fixture database"),
  ]);
});

function check(tool_name: string, tool_input: Record<string, unknown>, cwd = workspace) {
  return allowAssistantTool(workspace, { hook_event_name: "PreToolUse", cwd, tool_name, tool_input });
}

it("allows workspace reads and output writes, including files with missing ancestors", async () => {
  await expect(check("Read", { file_path: ".bridge-uploads/upload/attachment.txt" })).resolves.toBe(true);
  await expect(check("Write", { file_path: "outputs/folder/new.txt" })).resolves.toBe(true);
  await expect(check("Edit", { file_path: join(outputs, "draft.txt") })).resolves.toBe(true);
  await expect(check("MultiEdit", { file_path: join(outputs, "draft.txt") })).resolves.toBe(true);
  await expect(check("Read", { file_path: privateFile })).resolves.toBe(false);
  await expect(check("Read", { file_path: "../assistant.sqlite" })).resolves.toBe(false);
  await expect(check("Write", { file_path: join(root, "new-parent", "new.txt") })).resolves.toBe(false);
  for (const file_path of ["CLAUDE.md", ".mcp.json", ".claude/settings.json", ".bridge-uploads/upload/attachment.txt", "outputs", "outputs-copy/new.txt"]) {
    await expect(check("Write", { file_path })).resolves.toBe(false);
  }
});

it("rejects recursive credential reads and confines recursive searches to checked subtrees", async () => {
  const glob = { pattern: "**/*.txt" };
  await expect(check("Glob", glob, uploads)).resolves.toBe(true);
  await expect(check("Grep", { pattern: "attachment", path: uploads })).resolves.toBe(true);
  await expect(check("Read", { file_path: ".mcp.json" })).resolves.toBe(false);
  await expect(check("Grep", { pattern: ".", path: ".mcp.json" })).resolves.toBe(false);
  await expect(check("Glob", glob)).resolves.toBe(false);
  await expect(check("Grep", { pattern: "." })).resolves.toBe(false);
  await expect(check("Glob", glob, root)).resolves.toBe(false);
  await expect(check("Glob", { pattern: `${root}/**/*`, path: outputs })).resolves.toBe(false);
  await expect(check("Glob", { pattern: "../../*/**", path: outputs })).resolves.toBe(false);
});

it("rejects symlink escapes, output aliases and searches whose results could traverse links", async () => {
  await symlink(root, join(workspace, "outside"), "junction");
  await symlink(uploads, join(outputs, "upload-alias"), "junction");
  await symlink(root, join(outputs, "outside"), "junction");
  await expect(check("Read", { file_path: "outside/assistant.sqlite" })).resolves.toBe(false);
  await expect(check("Write", { file_path: "outputs/outside/new/future.txt" })).resolves.toBe(false);
  await expect(check("Edit", { file_path: "outputs/upload-alias/attachment.txt" })).resolves.toBe(false);
  await expect(check("Glob", { pattern: "**/*", path: outputs })).resolves.toBe(false);
  await link(join(workspace, ".mcp.json"), join(outputs, "credentials-alias.txt"));
  await link(privateFile, join(outputs, "private-alias.txt"));
  await expect(check("Read", { file_path: "outputs/credentials-alias.txt" })).resolves.toBe(false);
  await expect(check("Write", { file_path: "outputs/private-alias.txt" })).resolves.toBe(false);
});

it.skipIf(process.platform === "win32")("rejects a direct credential symlink and refuses writes through a dangling symlink", async () => {
  await symlink(join(workspace, ".mcp.json"), join(outputs, "secret.txt"));
  await symlink(join(root, "future.txt"), join(outputs, "dangling.txt"));
  await expect(check("Read", { file_path: "outputs/secret.txt" })).resolves.toBe(false);
  await expect(check("Write", { file_path: "outputs/dangling.txt" })).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses the exact mail tool names and limits delegation to the foreground project helper", async () => {
  expect(ASSISTANT_TOOLS.filter(name => name.startsWith("mcp__"))).toEqual(
    MAIL_TOOLS.filter(tool => tool.name !== "memory.lookup_entry").map(tool => `mcp__assistant-mail__${tool.name.replaceAll(".", "_")}`),
  );
  for (const name of ["mcp__assistant-mail__mail_read_event", "ToolSearch", "TodoWrite"]) {
    await expect(check(name, {})).resolves.toBe(true);
  }
  for (const name of ["Bash", "PowerShell", "NotebookEdit", "WebFetch", "SendMessage", "mcp__ccd__query", "mcp__assistant-mail__mail_read_event_extra"]) {
    await expect(check(name, {})).resolves.toBe(false);
  }
  const helper = { subagent_type: "assistant-helper", prompt: "Summarize the provided file", run_in_background: false };
  await expect(check("Agent", helper)).resolves.toBe(true);
  await expect(check("Agent", { ...helper, subagent_type: "general-purpose" })).resolves.toBe(false);
  await expect(check("Agent", { ...helper, isolation: "worktree" })).resolves.toBe(false);
  await expect(check("Agent", { ...helper, run_in_background: true })).resolves.toBe(false);
  await expect(allowAssistantTool(workspace, null)).resolves.toBe(false);
});

it("fences Stage 3 child roles and keeps generated instructions out of writable roots", async () => {
  await mkdir(join(workspace, "memory/notes"), { recursive: true });
  await mkdir(join(workspace, "memory/threads"));
  const stage3 = (tool_name: string, tool_input: Record<string, unknown>, agent_type?: string, cwd = workspace) =>
    allowAssistantTool(workspace, { hook_event_name: "PreToolUse", cwd, tool_name, tool_input,
      ...(agent_type ? { agent_id: "agent-fixture", agent_type } : {}) }, ASSISTANT_MEMORY_POLICY);
  const write = { file_path: "memory/notes/nested/note.md" };
  await expect(check("Write", write)).resolves.toBe(false);
  await expect(stage3("Write", write, "memory-curator")).resolves.toBe(true);
  for (const role of [undefined, "mail-triager", "schedule-planner", "general-purpose"]) {
    await expect(stage3("Write", write, role)).resolves.toBe(false);
  }
  await expect(stage3("Write", { file_path: "outputs/export.txt" })).resolves.toBe(true);
  await expect(stage3("Write", { file_path: "outputs/export.txt" }, "memory-curator")).resolves.toBe(false);
  await expect(stage3("Glob", { pattern: "**/*.txt" }, "schedule-planner", outputs)).resolves.toBe(true);
  await expect(stage3("Grep", { pattern: "draft" }, "mail-triager", outputs)).resolves.toBe(true);
  await expect(stage3("Grep", { pattern: "draft" })).resolves.toBe(false);
  for (const path of ["PROFILE.md", "memory/INDEX.md", "memory/notes/CLAUDE.md", "memory/threads/claude.local.md",
    "memory/notes/sub/AGENTS.md", "memory/notes/sub/.claude/rules/instructions.md", "memory/notes/../threads/out.md"]) {
    await expect(stage3("Write", { file_path: path }, "memory-curator")).resolves.toBe(false);
  }
  await expect(check("Write", { file_path: "outputs/nested/CLAUDE.md" })).resolves.toBe(false);
  await symlink(root, join(workspace, "memory/notes/outside"), "junction");
  await expect(stage3("Write", { file_path: "memory/notes/outside/new/note.md" }, "memory-curator")).resolves.toBe(false);

  const draft = "mcp__assistant-mail__proposal_create";
  await expect(stage3(draft, { action: { kind: "memory.rule_upsert" } }, "memory-curator")).resolves.toBe(true);
  await expect(stage3(draft, { action: { kind: "memory.rule_upsert" } }, "mail-triager")).resolves.toBe(false);
  await expect(stage3(draft, { action: { kind: "todo.create" } }, "schedule-planner")).resolves.toBe(true);
  await expect(stage3("mcp__assistant-mail__mail_read_event", {}, "schedule-planner")).resolves.toBe(false);
  const delegation = { subagent_type: "memory-curator", prompt: "整理资料" };
  await expect(stage3("Task", delegation)).resolves.toBe(true);
  await expect(stage3("Agent", delegation, "mail-triager")).resolves.toBe(false);
  await expect(stage3("Agent", { ...delegation, run_in_background: true })).resolves.toBe(false);
  await expect(stage3("Agent", { subagent_type: "general-purpose" })).resolves.toBe(false);
  await expect(allowAssistantTool(workspace, { hook_event_name: "PreToolUse", cwd: workspace, tool_name: "Read",
    tool_input: { file_path: "outputs/draft.txt" } }, "unverified-policy")).resolves.toBe(false);
});
