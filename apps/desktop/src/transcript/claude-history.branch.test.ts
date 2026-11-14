import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseClaudeTranscriptSnapshot, readClaudeTranscriptBranch } from "./claude-history.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each(["parent", "logical", "compact-segment", "compact-messages", "missing", "duplicate", "fork"])("matches snapshot DAG selection: %s", async kind => {
  const root = await mkdtemp(join(tmpdir(), "bridge-branch-only-")); roots.push(root);
  const path = join(root, "parent.jsonl");
  const rows: Record<string, unknown>[] = [
    { type: "user", uuid: "a", parentUuid: null, message: { role: "user", content: "first" } },
    { type: "assistant", uuid: "b", parentUuid: "a", message: { role: "assistant", content: "answer", stop_reason: "end_turn" } },
    { type: "assistant", uuid: "sibling", parentUuid: "a", message: { role: "assistant", content: "sibling" } },
  ];
  const links: Record<string, unknown> = kind === "logical" ? { parentUuid: "missing", logicalParentUuid: "b" }
    : kind === "compact-segment" ? { subtype: "compact_boundary", parentUuid: "missing", compactMetadata: { preservedSegment: { tailUuid: "b" } } }
    : kind === "compact-messages" ? { parentUuid: "missing", compactMetadata: { preservedMessages: { allUuids: ["absent", "a", "b"] } } }
    : kind === "missing" ? { parentUuid: "missing" } : { parentUuid: "b", logicalParentUuid: "sibling" };
  rows.push({ type: "assistant", uuid: "c", ...links, message: { role: "assistant", content: "selected" } });
  if (kind === "duplicate") rows.push({ type: "assistant", uuid: "b", parentUuid: "sibling", message: { role: "assistant", content: "replacement" } });
  if (kind === "fork") rows.push({ type: "custom-title", bridgeFork: { baseMessageUuid: "b" } });
  rows.push({ type: "assistant", uuid: "side", parentUuid: "c", isSidechain: true, message: { content: "hidden" } });
  rows.push({ type: "queue-operation", uuid: "queue", parentUuid: "c" });
  rows.push({ type: "attachment", attachment: { type: "task_status", taskType: "local_bash", taskId: "task", status: "completed" } });
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const snapshot = await parseClaudeTranscriptSnapshot(path, { limit: 1 });
  const branch = await readClaudeTranscriptBranch(path);
  expect(branch).toEqual({ uuids: snapshot.branch!.uuids, inheritedUuids: snapshot.branch!.inheritedUuids });
  if (kind === "fork") expect(branch.inheritedUuids).toEqual(["a", "b"]);
  if (kind === "duplicate") expect(branch.uuids).toEqual(["a", "b", "c"]);
  await appendFile(path, JSON.stringify({ type: "assistant", uuid: "appended", parentUuid: "c" }) + "\n");
  expect((await readClaudeTranscriptBranch(path)).uuids.at(-1)).toBe("appended");
});
