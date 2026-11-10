import { rm, appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ObservedClaudeSession } from "./claude-session-catalog.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";
import { readClaudeSessionHistory } from "./claude-history.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bridge-plan-sync-"));
  directories.push(root);
  const paths = { projects: join(root, "projects"), sessions: join(root, "sessions"), tasks: join(root, "tasks"), desktopSessions: [] };
  await mkdir(paths.projects);
  const sessionId = "plan-session";
  const path = join(paths.projects, `${sessionId}.jsonl`);
  await writeFile(path, [
    { uuid: "u", parentUuid: null, type: "user", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "Work" } },
    { uuid: "p", parentUuid: "u", type: "assistant", timestamp: new Date(2000).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "plan-tool", name: "mcp__ccd_turn__update_plan", input: { items: [{ content: "First", status: "in_progress" }, { content: "Second", status: "pending" }] } }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const log = new SessionEventLog(join(root, "events.jsonl"));
  const session = { sessionId, cwd: root, transcriptPath: path, activeProcesses: [] } as unknown as ObservedClaudeSession;
  const observer = new TranscriptObserver({ paths, eventLog: log });
  return {
    root, paths, path, log, session, observer,
    observe: () => (observer as unknown as { observeTranscript(session: ObservedClaudeSession): Promise<void> }).observeTranscript(session),
    advance: () => appendFile(path, JSON.stringify({ uuid: "a", parentUuid: "p", type: "assistant", timestamp: new Date(3000).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "advance-tool", name: "mcp__ccd_turn__update_plan", input: { advance: true } }] } }) + "\n"),
  };
}

describe("task-plan transport and recovery", () => {
  it("emits a plan-only event and later updates exactly the same item", async () => {
    const f = await fixture();
    try {
      await f.observe();
      expect(f.log.history(f.session.sessionId).items.find(item => item.taskPlan)?.taskPlan?.items[0]?.status).toBe("in_progress");
      await f.advance();
      await f.observe();
      const plans = f.log.replay().filter(event => event.data.taskPlan);
      expect(plans).toHaveLength(2);
      expect(plans[0]!.itemId).toBe(plans[1]!.itemId);
      expect(f.log.history(f.session.sessionId).items.filter(item => item.taskPlan)).toHaveLength(1);
      expect(f.log.history(f.session.sessionId).items.find(item => item.taskPlan)?.taskPlan?.items.map(item => item.status)).toEqual(["completed", "in_progress"]);
      const seq = f.log.latestSeq();
      await f.observe();
      expect(f.log.latestSeq()).toBe(seq);
    } finally { await f.observer.close(); await f.log.close(); }
  });

  it("catches up a plan changed while Bridge was stopped during prime", async () => {
    const f = await fixture();
    await f.observe();
    await f.observer.close();
    await f.log.close();
    await f.advance();
    const log = new SessionEventLog(f.log.path);
    await log.initialize();
    const observer = new TranscriptObserver({ paths: f.paths, eventLog: log });
    try {
      const before = log.latestSeq();
      await (observer as unknown as { primeTranscript(session: ObservedClaudeSession): Promise<void> }).primeTranscript(f.session);
      expect(log.replay(before).filter(event => event.data.taskPlan)).toHaveLength(1);
      expect(log.history(f.session.sessionId).items.find(item => item.taskPlan)?.taskPlan?.items[1]?.status).toBe("in_progress");
    } finally { await observer.close(); await log.close(); }
  });

  it("deduplicates compacted plans after restart and still detects status changes", async () => {
    const f = await fixture();
    await f.observe();
    await f.observer.close();
    await f.log.close();
    const compacted = new SessionEventLog(f.log.path, 80, { bytesThreshold: 1, retainEvents: 0 });
    await compacted.initialize(); await compacted.close();
    const log = new SessionEventLog(f.log.path);
    await log.initialize();
    const observer = new TranscriptObserver({ paths: f.paths, eventLog: log });
    const observe = () => (observer as unknown as { observeTranscript(session: ObservedClaudeSession): Promise<void> }).observeTranscript(f.session);
    try {
      const before = log.latestSeq();
      await observe();
      expect(log.latestSeq()).toBe(before);
      await f.advance(); await observe();
      expect(log.replay(before).filter(event => event.data.taskPlan)).toHaveLength(1);
    } finally { await observer.close(); await log.close(); }
  });

  it.each([false, true])("removes an imported plan when its initialization later fails, including after restart (compact=%s)", async compact => {
    const f = await fixture();
    await f.observe();
    expect(f.log.history(f.session.sessionId).items.some(item => item.taskPlan)).toBe(true);
    await appendFile(f.path, JSON.stringify({ uuid: "failure", parentUuid: "p", type: "user", timestamp: new Date(3000).toISOString(), message: {
      role: "user", content: [{ type: "tool_result", tool_use_id: "plan-tool", is_error: true, content: "No such tool available" }],
    } }) + "\n");
    await f.observe();
    expect(f.log.history(f.session.sessionId).items.some(item => item.taskPlan)).toBe(false);
    const page = await readClaudeSessionHistory(f.paths.projects, f.session.sessionId, f.root);
    expect(page.messages.some(item => item.taskPlan)).toBe(false);
    expect(f.log.replay().filter(event => event.data.taskPlanInvalidated === true)).toHaveLength(1);
    await f.observer.close(); await f.log.close();
    if (compact) {
      const compacted = new SessionEventLog(f.log.path, 80, { bytesThreshold: 1, retainEvents: 0 });
      await compacted.initialize(); await compacted.close();
    }
    const log = new SessionEventLog(f.log.path);
    await log.initialize();
    const observer = new TranscriptObserver({ paths: f.paths, eventLog: log });
    try {
      const before = log.latestSeq();
      await (observer as unknown as { primeTranscript(session: ObservedClaudeSession): Promise<void> }).primeTranscript(f.session);
      expect(log.history(f.session.sessionId).items.some(item => item.taskPlan)).toBe(false);
      expect(log.latestItem(f.session.sessionId, "session.observed", "plan:plan-tool")?.data.taskPlanInvalidated).toBe(true);
      expect(log.latestSeq()).toBe(before);
    } finally { await observer.close(); await log.close(); }
  });

  it("filters a previously imported failed plan before an observer refresh", async () => {
    const f = await fixture();
    try {
      await f.observe();
      await appendFile(f.path, JSON.stringify({ uuid: "failure", parentUuid: "p", type: "user", message: {
        role: "user", content: [{ type: "tool_result", tool_use_id: "plan-tool", is_error: true, content: "Failed" }],
      } }) + "\n");
      const page = await readClaudeSessionHistory(f.paths.projects, f.session.sessionId, f.root);
      expect(page.messages.some(item => item.taskPlan)).toBe(false);
    } finally { await f.observer.close(); await f.log.close(); }
  });

  it("publishes a newer correction after a previously imported advance fails", async () => {
    const f = await fixture();
    try {
      await f.observe(); await f.advance(); await f.observe();
      const attempted = f.log.history(f.session.sessionId).items.find(item => item.taskPlan)!.taskPlan!;
      await appendFile(f.path, JSON.stringify({ uuid: "advance-failure", parentUuid: "a", type: "user", timestamp: new Date(3000).toISOString(), message: {
        role: "user", content: [{ type: "tool_result", tool_use_id: "advance-tool", is_error: true, content: "Failed" }],
      } }) + "\n");
      await f.observe();
      const corrected = f.log.history(f.session.sessionId).items.find(item => item.taskPlan)!.taskPlan!;
      expect(corrected.items.map(item => item.status)).toEqual(["in_progress", "pending"]);
      expect(corrected.updatedAt).toBeGreaterThan(attempted.updatedAt);
    } finally { await f.observer.close(); await f.log.close(); }
  });

  it("keeps newer transcript plan state when an older host event exists", async () => {
    const f = await fixture();
    try {
      await f.advance();
      await f.log.append({ sessionId: f.session.sessionId, itemId: "plan:plan-tool", timestamp: 2000, type: "session.observed", origin: "claude-host", data: { role: "assistant", text: "", taskPlan: { id: "plan-tool", updatedAt: 2000, items: [{ content: "First", status: "in_progress" }, { content: "Second", status: "pending" }] } } });
      const page = await readClaudeSessionHistory(f.paths.projects, f.session.sessionId, f.root);
      expect(page.messages.find(item => item.taskPlan)?.taskPlan?.items.map(item => item.status)).toEqual(["completed", "in_progress"]);
    } finally { await f.observer.close(); await f.log.close(); }
  });
});
