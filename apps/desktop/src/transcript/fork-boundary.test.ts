import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseClaudeTranscriptSnapshot, readClaudeSessionSubagents } from "./claude-history.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Row = Record<string, any>;
function transcript(sessionId: string, kind: string): Row[] {
  const rows: Row[] = [];
  const add = (uuid: string, type: string, content: unknown, extra: Row = {}) => {
    rows.push({ uuid, parentUuid: rows.at(-1)?.uuid ?? null, type, sessionId,
      timestamp: new Date(1_700_000_000_000 + rows.length * 1000).toISOString(),
      message: { role: type, content }, ...extra });
  };
  if (kind !== "first-turn") {
    add("stable-user", "user", "Complete request");
    add("stable-answer", "assistant", "Complete answer");
    rows.at(-1)!.message.stop_reason = "end_turn";
  }
  add("active-user", "user", "Triggering input");
  if (!["partial-response", "first-turn", "steering"].includes(kind)) {
    add("agent-call", "assistant", [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Parent agent", run_in_background: true } }]);
    rows.at(-1)!.message.stop_reason = "tool_use";
    add("agent-result", "user", [{ type: "tool_result", tool_use_id: "agent-tool", content: "Async agent launched successfully. agentId: parent-agent" }], { toolUseResult: { agentId: "parent-agent", status: "async_launched", isAsync: true } });
    add("shell-call", "assistant", [{ type: "tool_use", id: "shell-tool", name: "Bash", input: { run_in_background: true } }]);
    rows.at(-1)!.message.stop_reason = "tool_use";
    add("shell-result", "user", [{ type: "tool_result", tool_use_id: "shell-tool", content: "Background task" }], { toolUseResult: { backgroundTaskId: "parent-shell" } });
  }
  if (kind === "completed-agent-control") add("notification", "user", "<task-notification><task-id>parent-agent</task-id><status>completed</status></task-notification>");
  if (kind === "abandoned-agent-branch") add("sibling-user", "user", "Selected sibling", { parentUuid: "stable-answer" });
  if (kind === "steering") {
    add("progress", "assistant", "Intermediate progress");
    add("steer", "user", "Adjust the same unfinished round");
  }
  add("partial-answer", "assistant", "Intermediate answer");
  if (!["partial-response", "active-agent-and-shell", "first-turn", "steering"].includes(kind)) rows.at(-1)!.message.stop_reason = "end_turn";
  return rows;
}

it("cuts before a notification follow-up while ignoring sidechain records", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-idle-notification-"));
  roots.push(root);
  const path = join(root, "parent.jsonl");
  const rows = transcript("parent", "main-finished-agent-running");
  rows.push({ type: "user", uuid: "late", parentUuid: "partial-answer", sessionId: "parent",
    message: { role: "user", content: "<task-notification><task-id>parent-agent</task-id><status>completed</status></task-notification>" } });
  rows.push({ type: "assistant", uuid: "sidechain", parentUuid: "stable-answer", isSidechain: true,
    message: { role: "assistant", content: "Sidechain work" } });
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const snapshot = await parseClaudeTranscriptSnapshot(path);
  expect(snapshot.terminalUuid).toBe("late");
  expect(snapshot.atTurnBoundary).toBe(false);
  expect(snapshot.branch?.forkBaseMessageUuid).toBe("partial-answer");
});

it("retains inherited ownership when a child selects ancestry before its saved base UUID", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-rewound-chain-"));
  roots.push(root);
  const path = join(root, "child.jsonl");
  await writeFile(path, [
    ...transcript("parent", "main-finished-agent-running"),
    { type: "custom-title", bridgeFork: { baseMessageUuid: "partial-answer" } },
    { type: "user", uuid: "child-rewind", parentUuid: "agent-result", sessionId: "child", message: { role: "user", content: "New branch before saved base" } },
    { type: "assistant", uuid: "child-answer", parentUuid: "child-rewind", sessionId: "child", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  expect((await parseClaudeTranscriptSnapshot(path)).branch?.inheritedUuids).toContain("agent-call");
  expect((await readClaudeSessionSubagents(root, "child", root, 0)).map(task => task.state)).toEqual(["unknown"]);
});

it("does not invent an empty boundary when a compacted unfinished round has no prior completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-compacted-"));
  roots.push(root);
  const path = join(root, "parent.jsonl");
  await writeFile(path, [
    { type: "system", subtype: "compact_boundary", uuid: "compact", parentUuid: null },
    { type: "user", uuid: "summary", parentUuid: "compact", isCompactSummary: true, message: { role: "user", content: "Prior context" } },
    { type: "user", uuid: "active", parentUuid: "summary", message: { role: "user", content: "Continue" } },
    { type: "assistant", uuid: "partial", parentUuid: "active", message: { role: "assistant", content: "Partial" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  expect((await parseClaudeTranscriptSnapshot(path)).branch?.forkBaseMessageUuid).toBeUndefined();
});
