import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCommandEvidence } from "./command-evidence.js";
import { SessionEventLog } from "./session-event-log.js";

const directories: string[] = [];
afterEach(() => {
  const fixtures = directories.splice(0);
  if (!fixtures.length) return;
  const recycle = process.platform === "darwin" ? "/usr/bin/trash" : process.platform === "linux" ? "trash-put" : undefined;
  if (!recycle) {
    console.warn("No recycle command configured; keeping test fixtures:", fixtures);
    return;
  }
  try {
    execFileSync(recycle, fixtures);
  } catch (error) {
    console.warn("Could not recycle test fixtures; keeping remaining files:", fixtures, error);
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-command-evidence-"));
  directories.push(directory);
  return {
    log: new SessionEventLog(join(directory, "events.jsonl")),
    paths: { projects: directory },
    transcript: join(directory, "native-session.jsonl"),
    turn: { sessionId: "bridge-session", turnId: "turn-1", commandId: "command-1", messageId: "input-1", sessionCwd: directory },
  };
}

const input = { uuid: "input-1", type: "user", message: { content: "Do this exact task" } };

describe("readCommandEvidence", () => {
  it("requires exact input acceptance rather than substring matches or idle timing", async () => {
    const { log, paths, transcript, turn } = await fixture();
    await writeFile(transcript, [
      { uuid: "other-input", type: "user", message: { content: "A quote of input-1" } },
      { uuid: "other-output", parentUuid: "other-input", type: "assistant", message: { stop_reason: "end_turn" } },
    ].map((node) => JSON.stringify(node)).join("\n"));
    expect(await readCommandEvidence(log, paths, turn, "native-session")).toEqual({ messageId: "input-1" });
    await log.close();
  });

  it.each(["end_turn", "stop_sequence"])("completes only the exact input descendant with %s", async (stopReason) => {
    const { log, paths, transcript, turn } = await fixture();
    await writeFile(transcript, [
      input,
      { uuid: "thinking", parentUuid: "input-1", type: "assistant", message: { stop_reason: "tool_use" } },
      { uuid: "tool-result", parentUuid: "thinking", type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } },
      { uuid: "answer", parentUuid: "tool-result", type: "assistant", message: { stop_reason: stopReason } },
    ].map((node) => JSON.stringify(node)).join("\n") + '\n{"uuid":"partial');
    expect(await readCommandEvidence(log, paths, turn, "native-session")).toEqual({ submitted: true, accepted: true, terminal: "completed", messageId: "input-1" });
    await log.close();
  });

  it.each([null, "tool_use", "max_tokens", "pause_turn"])("keeps partial output with %s unsettled despite later unrelated completion", async (stopReason) => {
    const { log, paths, transcript, turn } = await fixture();
    await writeFile(transcript, [
      input,
      { uuid: "partial", parentUuid: "input-1", type: "assistant", message: { stop_reason: stopReason, content: [{ type: "text", text: "Work begun" }] } },
      { uuid: "sidechain", parentUuid: "partial", type: "assistant", isSidechain: true, message: { stop_reason: "end_turn" } },
      { uuid: "later-user", parentUuid: "partial", type: "user", message: { content: "Different request" } },
      { uuid: "later-answer", parentUuid: "later-user", type: "assistant", message: { stop_reason: "end_turn" } },
    ].map((node) => JSON.stringify(node)).join("\n"));
    expect(await readCommandEvidence(log, paths, turn, "native-session")).toEqual({ submitted: true, accepted: true, messageId: "input-1" });
    await log.close();
  });

  it.each([
    { logicalParentUuid: "partial" },
    { compactMetadata: { preservedSegment: { headUuid: "input-1", tailUuid: "partial" } } },
    { compactMetadata: { preservedSegment: { headUuid: "partial", tailUuid: "missing" } } },
    { compactMetadata: { preservedMessages: { allUuids: ["input-1", "partial"] } } },
    {},
  ])("follows compaction ancestry through synthetic summaries: %j", async (ancestry) => {
    const { log, paths, transcript, turn } = await fixture();
    await writeFile(transcript, [
      input,
      { uuid: "partial", parentUuid: "input-1", type: "assistant", message: { stop_reason: "tool_use" } },
      { uuid: "metadata-only", type: "queue-operation" },
      { uuid: "boundary", type: "system", subtype: "compact_boundary", parentUuid: "missing", ...ancestry },
      { uuid: "summary", parentUuid: "boundary", type: "user", isCompactSummary: true, message: { content: "Synthetic compact summary" } },
      { uuid: "meta", parentUuid: "summary", type: "user", isMeta: true, message: { content: "Continue" } },
      { uuid: "answer", parentUuid: "meta", type: "assistant", message: { stop_reason: "end_turn" } },
    ].map((node) => JSON.stringify(node)).join("\n"));
    expect(await readCommandEvidence(log, paths, turn, "native-session")).toEqual({ submitted: true, accepted: true, terminal: "completed", messageId: "input-1" });
    await log.close();
  });

  it("does not attach a later user turn through a rewritten preserved node", async () => {
    const { log, paths, transcript, turn } = await fixture();
    await writeFile(transcript, [
      input,
      { uuid: "partial", parentUuid: "input-1", type: "assistant", message: { stop_reason: "tool_use" } },
      { uuid: "later-user", parentUuid: "partial", type: "user", message: { content: "Different request" } },
      { uuid: "later-partial", parentUuid: "later-user", type: "assistant", message: { stop_reason: "tool_use" } },
      { uuid: "boundary", type: "system", subtype: "compact_boundary", compactMetadata: { preservedSegment: { tailUuid: "partial" } } },
      { uuid: "summary", parentUuid: "boundary", type: "user", isCompactSummary: true },
      { uuid: "later-partial", parentUuid: "summary", type: "assistant", message: { stop_reason: "tool_use" } },
      { uuid: "later-answer", parentUuid: "later-partial", type: "assistant", message: { stop_reason: "end_turn" } },
    ].map((node) => JSON.stringify(node)).join("\n"));
    expect(await readCommandEvidence(log, paths, turn, "native-session")).toEqual({ submitted: true, accepted: true, messageId: "input-1" });
    await log.close();
  });

  it.each(["turn.failed", "turn.interrupted", "runtime.error"] as const)("preserves explicit %s despite transcript completion", async (type) => {
    const { log, paths, transcript, turn } = await fixture();
    await log.append({ sessionId: turn.sessionId, turnId: turn.turnId, itemId: turn.messageId, type: "user.message.accepted", origin: "mobile", data: { commandId: turn.commandId } });
    await log.append({ sessionId: turn.sessionId, turnId: turn.turnId, type, origin: "claude-host", data: { delivery: "failed" } });
    await writeFile(transcript, [input, { uuid: "answer", parentUuid: "input-1", type: "assistant", message: { stop_reason: "end_turn" } }].map((node) => JSON.stringify(node)).join("\n"));
    expect(await readCommandEvidence(log, paths, turn, "native-session")).toEqual({ submitted: true, accepted: true, terminal: type === "turn.interrupted" ? "cancelled" : "failed", messageId: "input-1" });
    await log.close();
  });

  it("retains submitted but unconfirmed evidence and derives the input ID from its receipt", async () => {
    const { log, paths, turn } = await fixture();
    await log.append({ sessionId: turn.sessionId, turnId: turn.turnId, itemId: turn.messageId, type: "message.delivery", origin: "claude-host", data: { commandId: turn.commandId, delivery: "submitted" } });
    const { messageId: _messageId, ...withoutMessageId } = turn;
    expect(await readCommandEvidence(log, paths, withoutMessageId, "native-session")).toEqual({ submitted: true, messageId: "input-1" });
    await log.close();
  });

  it("uses an observed exact user ID as acceptance without claiming completion", async () => {
    const { log, paths, turn } = await fixture();
    await log.append({ sessionId: turn.sessionId, itemId: turn.messageId, type: "session.observed", origin: "claude-desktop", data: { role: "user", text: "Do this exact task" } });
    expect(await readCommandEvidence(log, paths, turn)).toEqual({ submitted: true, accepted: true, messageId: "input-1" });
    await log.close();
  });
});
