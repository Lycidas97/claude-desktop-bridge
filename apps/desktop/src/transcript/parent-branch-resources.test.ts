import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readClaudeTranscriptSubagents } from "./transcript-subagents.js";

let root: string;
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });
it("extracts parent summaries without projecting unrelated text or populating the history cache", async () => {
  root = await mkdtemp(join(tmpdir(), "bridge-parent-branch-"));
  const path = join(root, "parent.jsonl");
  await writeFile(path, Array.from({ length: 16 }, (_, i) => JSON.stringify({
    uuid: `message-${i}`, parentUuid: i ? `message-${i - 1}` : null, type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "unrelated parent text", resourceProbe: true }] },
  })).join("\n") + "\n");
  const parse = JSON.parse;
  let textReads = 0;
  let snapshotCacheWrites = 0;
  vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
    const value = parse(text);
    const block = value?.message?.content?.[0];
    if (block?.resourceProbe) Object.defineProperty(block, "text", { get() { textReads++; return "unrelated parent text"; } });
    return value;
  });
  const set = Map.prototype.set;
  vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
    if (key === path && value && typeof value === "object" && "allMessages" in value) snapshotCacheWrites++;
    return set.call(this, key, value);
  });
  expect(await readClaudeTranscriptSubagents(path)).toEqual([]);
  expect.soft(textReads, "parent branch extraction must not read unrelated visible text").toBe(0);
  expect.soft(snapshotCacheWrites, "parent summaries must not populate allMessages snapshot cache").toBe(0);
});
