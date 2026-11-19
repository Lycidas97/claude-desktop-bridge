import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const fileTools = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep"];
export const ASSISTANT_HELPER = "assistant-helper";
export const ASSISTANT_MCP = "assistant-mail";
export const ASSISTANT_TOKEN_ENV = "BRIDGE_ASSISTANT_SESSION_TOKEN";
export const AGENDA_TOOLS = ["todo_list", "calendar_list_events", "calendar_find_free_slots"].map(name => `mcp__${ASSISTANT_MCP}__${name}`);
export const ASSISTANT_TOOLS = [
  ...AGENDA_TOOLS,
  ...fileTools, "Agent", "ToolSearch", "TodoWrite",
  ...["list_events", "read_event", "read_attachment", "update_analysis", "set_processing_status"].map(name => `mcp__${ASSISTANT_MCP}__mail_${name}`),
];

export function isAssistantTool(name: string): boolean {
  return ASSISTANT_TOOLS.includes(name);
}

export function withinPath(root: string, path: string): boolean {
  const offset = relative(root, path);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

export function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function resolveWorkspacePath(path: string, allowMissing: boolean) {
  const missing: string[] = [];
  let ancestor = path;
  while (allowMissing && !await lstat(ancestor).catch(error => {
    if (!isMissingPath(error)) throw error;
  })) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  // lstat distinguishes an absent component from a dangling symlink. realpath must succeed on the latter.
  const physical = await realpath(ancestor);
  const info = await stat(physical);
  return { path: join(physical, ...missing), info, missing: missing.length > 0 };
}

function safePathInput(value: unknown): value is string {
  if (typeof value !== "string" || !value || /^[~]|\0/.test(value) || value.split(/[\\/]/).includes("..")) return false;
  if (process.platform !== "win32") return true;
  // Avoid Windows device/UNC paths, alternate data streams and ambiguous DOS spellings.
  const { root } = parse(value);
  return (!root || /^[a-z]:[\\/]$/i.test(root)) && value.slice(root.length).split(/[\\/]/).every(part =>
    part === "." || (!/[<>:"|?*]|[. ]$/.test(part) && !/^(?:CON(?:IN\$|OUT\$)?|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)));
}

function isMcpConfig(path: string): boolean {
  return basename(path).toLowerCase() === ".mcp.json";
}

async function searchableTree(path: string): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    // Grep/Glob recurse inside the native tool, after the hook returns. Reject trees
    // containing links or credentials since a PreToolUse hook cannot filter results.
    if (isMcpConfig(child) || !(entry.isDirectory() ? await searchableTree(child) :
      entry.isFile() && (await lstat(child)).nlink === 1)) return false;
  }
  return true;
}

export async function allowAssistantTool(workspace: string, input: unknown): Promise<boolean> {
  if (typeof input !== "object" || input === null) return false;
  const { cwd, tool_name: name, tool_input: args, hook_event_name: event } = input as Record<string, unknown>;
  if (event !== "PreToolUse" || typeof name !== "string" || !isAssistantTool(name) ||
    typeof args !== "object" || args === null || Array.isArray(args)) return false;
  const params = args as Record<string, unknown>;
  if (name === "Agent") {
    // Limit delegation to the project helper with its own tool list. Resume,
    // worktree and teammate modes carry a different execution scope.
    return params.subagent_type === ASSISTANT_HELPER && params.run_in_background === false &&
      Object.keys(params).every(key => ["subagent_type", "description", "prompt", "model", "effort", "run_in_background"].includes(key));
  }
  if (!fileTools.includes(name)) return true;
  if (!safePathInput(cwd) || !isAbsolute(cwd)) return false;
  const search = name === "Glob" || name === "Grep";
  const target = search ? params.path === undefined ? "." : params.path : params.file_path;
  if (!safePathInput(target)) return false;
  if (name === "Glob" && (typeof params.pattern !== "string" ||
    /^(?:[~/]|[a-z]:)|\.\.|[\\{}]/i.test(params.pattern))) return false;

  const root = await realpath(workspace);
  const dir = await realpath(cwd);
  if (!withinPath(root, dir)) return false;
  const candidate = resolve(dir, target);
  if (!withinPath(root, candidate) || isMcpConfig(candidate)) return false;
  const writing = name === "Write" || name === "Edit" || name === "MultiEdit";
  const physical = await resolveWorkspacePath(candidate, writing);
  if (!withinPath(root, physical.path) || isMcpConfig(physical.path) ||
    (!physical.info.isDirectory() && !(physical.info.isFile() && physical.info.nlink === 1))) return false;
  if (!writing) return physical.info.isDirectory() ? search && await searchableTree(physical.path) : true;

  const outputs = join(root, "outputs");
  return relative(outputs, physical.path) !== "" && withinPath(outputs, candidate) && withinPath(outputs, physical.path) &&
    (await lstat(outputs)).isDirectory() && (physical.missing ? physical.info.isDirectory() : physical.info.isFile());
}

export async function runAssistantFsGuard(workspace: string): Promise<void> {
  let stdin = "";
  for await (const chunk of process.stdin.setEncoding("utf8")) stdin += chunk;
  try {
    if (await allowAssistantTool(workspace, JSON.parse(stdin))) return;
  } catch (error) {
    if (!(error instanceof Error && (error instanceof SyntaxError || "code" in error))) throw error;
  }
  process.stderr.write("Tool or path is outside the managed assistant policy. For recursive searches, choose an upload or output subdirectory without links.\n");
  process.exitCode = 2;
}
