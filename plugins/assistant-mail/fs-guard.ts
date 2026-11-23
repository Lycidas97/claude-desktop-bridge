import { readFileSync, statSync, type BigIntStats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { ASSISTANT_DIRECTORY_TOOL, ASSISTANT_MEMORY_POLICY, ASSISTANT_WORKSPACE_POLICY, isAssistantWorkspacePolicy } from "../../packages/protocol/src/assistant-mail.js";
import { PROPOSAL_TOOLS } from "../../packages/protocol/src/assistant-proposal.js";

const readTools = ["Read", "Glob", "Grep"];
export const ASSISTANT_FILE_WRITES = ["Write", "Edit", "MultiEdit"];
const fileTools = ["Read", ...ASSISTANT_FILE_WRITES, "Glob", "Grep"];
export const ASSISTANT_HELPER = "assistant-helper";
export const ASSISTANT_MCP = "assistant-mail";
export const ASSISTANT_TOKEN_ENV = "BRIDGE_ASSISTANT_SESSION_TOKEN";
export const AGENDA_TOOLS = ["todo_list", "calendar_list_events", "calendar_find_free_slots"].map(name => `mcp__${ASSISTANT_MCP}__${name}`);
export const PROPOSAL_NATIVE_TOOLS = PROPOSAL_TOOLS.map(name => `mcp__${ASSISTANT_MCP}__${name.replace(".", "_")}`);
export const ASSISTANT_MARK_READ_TOOL = `mcp__${ASSISTANT_MCP}__mail_mark_read`;
const mailTools = ["list_events", "list_unfinished_triggers", "read_event", "read_attachment", "update_analysis", "set_processing_status", "move"].map(name => `mcp__${ASSISTANT_MCP}__mail_${name}`);
export const ASSISTANT_TOOLS = [
  ...AGENDA_TOOLS, ...PROPOSAL_NATIVE_TOOLS, ...fileTools, "Agent", "ToolSearch", "TodoWrite", ...mailTools, ASSISTANT_MARK_READ_TOOL,
];
export const ASSISTANT_WEB_SEARCH_TOOL = "WebSearch";
export const ASSISTANT_DIRECTORY_NATIVE_TOOL = `mcp__${ASSISTANT_MCP}__${ASSISTANT_DIRECTORY_TOOL.replace(".", "_")}`;
export const MEMORY_LOOKUP_TOOL = `mcp__${ASSISTANT_MCP}__memory_lookup_entry`;
const proposalDraftTools = PROPOSAL_NATIVE_TOOLS.slice(0, 2);
const triageTools = mailTools.filter(name => !name.endsWith("__mail_list_unfinished_triggers") && !name.endsWith("__mail_set_processing_status"));
export const ASSISTANT_SPECIALISTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["mail-triager", [...readTools, "ToolSearch", ...triageTools, ...proposalDraftTools]],
  ["schedule-planner", [...readTools, "ToolSearch", ...AGENDA_TOOLS, ...proposalDraftTools]],
  ["memory-curator", [...fileTools, "ToolSearch", MEMORY_LOOKUP_TOOL, ...proposalDraftTools]],
]);
export const ASSISTANT_MEMORY_ROOTS = ["memory/threads", "memory/notes"];

export function isAssistantTool(name: string, policy: string = ASSISTANT_WORKSPACE_POLICY): boolean {
  return ASSISTANT_TOOLS.includes(name) || (policy === ASSISTANT_MEMORY_POLICY && name === MEMORY_LOOKUP_TOOL) ||
    (policy === ASSISTANT_WORKSPACE_POLICY && (name === ASSISTANT_WEB_SEARCH_TOOL || name === ASSISTANT_DIRECTORY_NATIVE_TOOL));
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

export function isMcpConfig(path: string): boolean {
  return basename(path).toLowerCase() === ".mcp.json";
}

async function searchableTree(path: string): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    // Grep/Glob recurse inside the native tool, after the hook returns. Reject trees
    // containing links or .mcp.json since a PreToolUse hook cannot filter results.
    if (isMcpConfig(child) || !(entry.isDirectory() ? await searchableTree(child) :
      entry.isFile() && (await lstat(child)).nlink === 1)) return false;
  }
  return true;
}

const protectedNames = new Set(["claude.md", "claude.local.md", "agents.md", ".claude", ".mcp.json", ".bridge-uploads"]);

export interface AssistantReadDirectories {
  bindingToken: string;
  cliSessionId: string;
  directories: string[];
}

export const assistantReadDirectoriesPath = (workspace: string) => join(dirname(workspace), "read-directories.json");

export function isAssistantReadDirectory(workspace: string, value: unknown): value is string {
  const userData = dirname(dirname(dirname(workspace)));
  return safePathInput(value) && isAbsolute(value) && !withinPath(userData, value) && !withinPath(value, userData);
}

function ancestryContains(path: string, { dev, ino }: BigIntStats): boolean {
  for (;;) {
    const identity = statSync(path, { bigint: true });
    if (identity.dev === dev && identity.ino === ino) return true;
    const parent = dirname(path);
    if (parent === path) return false;
    path = parent;
  }
}

export function overlapsAssistantData(workspace: string, physicalPath: string): boolean {
  const userData = dirname(dirname(dirname(workspace)));
  const dataIdentity = statSync(userData, { bigint: true });
  if (ancestryContains(physicalPath, dataIdentity)) return true;
  const targetIdentity = statSync(physicalPath, { bigint: true });
  if (ancestryContains(userData, targetIdentity)) return true;
  if (process.platform !== "darwin") return false;

  // APFS firmlinks can hide the data-volume mount from the ordinary dirname chain.
  const mountedPath = join("/System/Volumes/Data", userData);
  const mounted = statSync(mountedPath, { bigint: true, throwIfNoEntry: false });
  return mounted?.dev === dataIdentity.dev && mounted.ino === dataIdentity.ino &&
    ancestryContains(mountedPath, targetIdentity);
}

export function loadAssistantReadDirectories(workspace: string): AssistantReadDirectories | undefined {
  try {
    const grants = JSON.parse(readFileSync(assistantReadDirectoriesPath(workspace), "utf8")) as Partial<AssistantReadDirectories> | null;
    if (typeof grants?.bindingToken === "string" && typeof grants.cliSessionId === "string" &&
      Array.isArray(grants.directories) && grants.directories.every(path => isAssistantReadDirectory(workspace, path))) {
      return { bindingToken: grants.bindingToken, cliSessionId: grants.cliSessionId, directories: grants.directories };
    }
  } catch (error) {
    if (!isMissingPath(error) && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

export async function allowAssistantTool(workspace: string, input: unknown, policy: string = ASSISTANT_WORKSPACE_POLICY): Promise<boolean> {
  if (!isAssistantWorkspacePolicy(policy) || typeof input !== "object" || input === null) return false;
  const { cwd, tool_name: rawName, tool_input: args, hook_event_name: event, agent_id: agentId, agent_type: agentType,
    session_id: cliSessionId } = input as Record<string, unknown>;
  const name = rawName === "Task" ? "Agent" : rawName;
  const memory = policy === ASSISTANT_MEMORY_POLICY;
  if (event !== "PreToolUse" || typeof name !== "string" || !isAssistantTool(name, policy) ||
    typeof args !== "object" || args === null || Array.isArray(args)) return false;
  const params = args as Record<string, unknown>;
  const specialist = memory && typeof agentType === "string" ? ASSISTANT_SPECIALISTS.get(agentType) : undefined;
  if (memory && (specialist ? !specialist.includes(name) : agentId !== undefined)) return false;
  if ((name === ASSISTANT_MARK_READ_TOOL || name === ASSISTANT_WEB_SEARCH_TOOL) && agentId !== undefined) return false;
  if (name === "Agent") {
    // Resume, worktree, background and teammate modes carry a different execution scope.
    const target = params.subagent_type;
    return (memory ? typeof target === "string" && ASSISTANT_SPECIALISTS.has(target) && params.run_in_background !== true
      : target === ASSISTANT_HELPER && params.run_in_background === false) &&
      Object.keys(params).every(key => ["subagent_type", "description", "prompt", "model", "effort", "run_in_background"].includes(key));
  }
  if (proposalDraftTools.includes(name)) {
    const kind = (params.action as { kind?: unknown } | undefined)?.kind;
    if (agentId !== undefined && (kind === "session.open" || kind === "session.send" || (!memory && kind === "memory.rule_upsert"))) return false;
    if (specialist && (typeof kind !== "string" || !(agentType === "mail-triager" ? kind.startsWith("mail.")
      : agentType === "schedule-planner" ? /^(todo|calendar)\./.test(kind) : kind === "memory.rule_upsert"))) return false;
  }
  if (name === ASSISTANT_DIRECTORY_NATIVE_TOOL) {
    if (agentId !== undefined || !safePathInput(cwd) || !isAbsolute(cwd)) return false;
    const root = await realpath(workspace);
    if (relative(root, await realpath(cwd)) !== "") return false;
    const grants = loadAssistantReadDirectories(root);
    if (!grants || grants.cliSessionId !== cliSessionId) return false;
    const config = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    return config.mcpServers?.[ASSISTANT_MCP]?.env?.[ASSISTANT_TOKEN_ENV] === grants.bindingToken;
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
  const writing = ASSISTANT_FILE_WRITES.includes(name);
  const physical = await resolveWorkspacePath(candidate, writing);
  if (!withinPath(root, physical.path) || isMcpConfig(physical.path) ||
    (!physical.info.isDirectory() && !(physical.info.isFile() && physical.info.nlink === 1))) return false;
  if (!writing) return physical.info.isDirectory() ? search && await searchableTree(physical.path) : true;

  if (memory && [candidate, physical.path].some(path => relative(root, path).split(sep).some(part => protectedNames.has(part.toLowerCase())))) return false;
  const writeRoots = specialist && agentType === "memory-curator" ? ASSISTANT_MEMORY_ROOTS : ["outputs"];
  const allowed = writeRoots.map(dir => join(root, dir)).find(dir =>
    relative(dir, physical.path) !== "" && withinPath(dir, candidate) && withinPath(dir, physical.path));
  return allowed !== undefined && (await lstat(allowed)).isDirectory() &&
    (physical.missing ? physical.info.isDirectory() : physical.info.isFile());
}

export async function runAssistantFsGuard(workspace: string, policy?: string): Promise<void> {
  let stdin = "";
  for await (const chunk of process.stdin.setEncoding("utf8")) stdin += chunk;
  try {
    if (await allowAssistantTool(workspace, JSON.parse(stdin), policy)) return;
  } catch (error) {
    if (!(error instanceof Error && (error instanceof SyntaxError || "code" in error))) throw error;
  }
  process.stderr.write("Tool or path is outside the managed assistant policy. For recursive searches, choose an upload or output subdirectory without links.\n");
  process.exitCode = 2;
}
