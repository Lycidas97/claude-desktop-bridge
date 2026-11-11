import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEventLog } from "../controller/session-event-log.js";
import type { ObservedDesktopEvidence } from "../evidence/evidence-manager.js";
import { TranscriptObserver } from "./transcript-observer.js";
import { parseClaudeTranscriptSnapshot } from "../transcript/claude-history.js";
import type { ObservedClaudeSession } from "../claude/claude-session-catalog.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for transcript observation");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setDesktopExecutorAlive(observer: TranscriptObserver, sessionId: string, registrationPath: string, alive: boolean): Promise<void> {
  const session = observer.session(sessionId)!;
  await writeFile(registrationPath, JSON.stringify({
    pid: alive ? process.pid : 2147483647, sessionId: session.sessionId, cwd: session.cwd,
    startedAt: Date.now(), entrypoint: "claude-desktop-3p",
  }));
  await waitFor(() => observer.session(sessionId)?.desktopProcessAlive === alive);
}

describe("TranscriptObserver", () => {
  it("deduplicates compacted text and prompts across restart while detecting later edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-compact-dedup-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    await mkdir(join(paths.projects, "project"), { recursive: true });
    const sessionId = "compact-dedup-session";
    const transcript = join(paths.projects, "project", `${sessionId}.jsonl`);
    const rows = [
      { uuid: "user-1", type: "user", timestamp: new Date().toISOString(), cwd: root, message: { role: "user", content: "Question" } },
      { uuid: "assistant-1", parentUuid: "user-1", type: "assistant", timestamp: new Date().toISOString(), cwd: root, message: { role: "assistant", content: [
        { type: "text", text: "Choose an option" },
        { type: "tool_use", id: "question-tool", name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A", description: "First" }] }] } },
      ] } },
    ];
    await writeFile(transcript, rows.map((row) => JSON.stringify(row)).join("\n"));
    const first = new SessionEventLog(join(root, "events.jsonl"));
    for (const message of (await parseClaudeTranscriptSnapshot(transcript)).messages) {
      await first.append({ sessionId, itemId: message.id, type: "session.observed", origin: "claude-desktop", data: { role: message.role, text: message.text, ...(message.interactivePrompt ? { interactivePrompt: message.interactivePrompt } : {}) } });
    }
    expect(first.latestItem(sessionId, "session.observed", "assistant-1")?.data.interactivePrompt).toBeDefined();
    await first.close();
    const compacted = new SessionEventLog(first.path, 80, { bytesThreshold: 1, retainEvents: 0 });
    await compacted.initialize();
    await compacted.close();
    const log = new SessionEventLog(first.path);
    await log.initialize();
    const before = log.latestSeq();
    const observer = new TranscriptObserver({ paths, eventLog: log, pollIntervalMs: 60_000, catalogIntervalMs: 60_000 });
    try {
      const session = { sessionId, cwd: root, transcriptPath: transcript, activeProcesses: [] } as unknown as ObservedClaudeSession;
      await (observer as unknown as { observeTranscript(session: ObservedClaudeSession): Promise<void> }).observeTranscript(session);
      expect(log.replay(before).filter((event) => event.type === "session.observed")).toEqual([]);
      expect(observer.externalWriteVersion(sessionId)).toBe(0);
      rows[0]!.message.content = "Edited question";
      await writeFile(transcript, rows.map((row) => JSON.stringify(row)).join("\n"));
    } finally {
      await observer.close();
    }
    const restarted = new TranscriptObserver({ paths, eventLog: log, pollIntervalMs: 60_000, catalogIntervalMs: 60_000 });
    try {
      // Exercise persisted dedup on a fresh observer before its in-memory prime cache.
      const session = { sessionId, cwd: root, transcriptPath: transcript, activeProcesses: [] } as unknown as ObservedClaudeSession;
      await (restarted as unknown as { observeTranscript(session: ObservedClaudeSession): Promise<void> }).observeTranscript(session);
      expect(log.replay(before).filter((event) => event.type === "session.observed")).toMatchObject([{ itemId: "user-1", data: { text: "Edited question" } }]);
      expect(log.replay(before).filter((event) => event.itemId === "assistant-1")).toEqual([]);
      expect(restarted.externalWriteVersion(sessionId)).toBe(0);
    } finally {
      await restarted.close();
      await log.close();
    }
  });
  it.each([
    { alias: false, compact: false },
    { alias: true, compact: false },
    { alias: false, compact: true },
    { alias: true, compact: true },
  ])("recognizes submitted input before its SDK acceptance (alias=$alias, compact=$compact)", async ({ alias, compact }) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-submitted-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    await mkdir(paths.projects, { recursive: true });
    const nativeId = "native-session";
    const sessionId = alias ? "logical-session" : nativeId;
    const transcript = join(paths.projects, `${nativeId}.jsonl`);
    await writeFile(transcript, `${JSON.stringify({ type: "assistant", uuid: "initial-answer", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } })}\n`);
    const logPath = join(root, "events.jsonl");
    let eventLog = new SessionEventLog(logPath);
    await eventLog.append({
      sessionId, turnId: "bridge-turn", itemId: "bridge-user", origin: "claude-host", type: "message.delivery",
      data: { delivery: "submitted", messageId: "bridge-user", commandId: "bridge-command", requestId: "bridge-request" },
    });
    if (compact) {
      await eventLog.close();
      const compacted = new SessionEventLog(logPath, 80, { bytesThreshold: 1, retainEvents: 0 });
      await compacted.initialize();
      await compacted.close();
      eventLog = new SessionEventLog(logPath);
      await eventLog.initialize();
    }
    const observer = new TranscriptObserver({ paths, eventLog, pollIntervalMs: 60_000, catalogIntervalMs: 60_000 });
    if (alias) observer.setSessionAlias(nativeId, sessionId);
    const session = { sessionId: nativeId, cwd: root, transcriptPath: transcript, activeProcesses: [] } as unknown as ObservedClaudeSession;
    const observe = () => (observer as unknown as { observeTranscript(session: ObservedClaudeSession): Promise<void> }).observeTranscript(session);
    try {
      await observe();
      // The transcript is written before the SDK echoes the accepted input.
      await appendFile(transcript, `${JSON.stringify({ type: "user", uuid: "bridge-user", parentUuid: "initial-answer", message: { role: "user", content: "Continue" } })}\n`);
      await observe();
      expect(eventLog.hasItem(sessionId, "user.message.accepted", "bridge-user")).toBe(false);
      expect(eventLog.latestItem(sessionId, "session.observed", "bridge-user")?.data.text).toBe("Continue");
      expect(observer.externalWriteVersion(sessionId)).toBe(0);
      expect(observer.externalWriteVersion(nativeId)).toBe(0);
      await eventLog.append({
        sessionId, turnId: "second-turn", itemId: "second-user", origin: "claude-host", type: "message.delivery",
        data: { delivery: "submitted", messageId: "second-user", commandId: "second-command", requestId: "second-request" },
      });
      await appendFile(transcript, `${JSON.stringify({ type: "user", uuid: "second-user", parentUuid: "bridge-user", message: { role: "user", content: "Continue" } })}\n`);
      await observe();
      expect(observer.externalWriteVersion(sessionId)).toBe(0);
      expect(eventLog.turnEvidence({ sessionId, messageId: "second-user" })).toMatchObject({ submitted: true, accepted: true });
      expect(eventLog.hasItem(sessionId, "user.message.accepted", "second-user")).toBe(false);
      await observe();
      expect(observer.externalWriteVersion(sessionId)).toBe(0);

      // Equal text with a different UUID is still a real external input.
      await appendFile(transcript, `${JSON.stringify({ type: "user", uuid: "desktop-user", parentUuid: "bridge-user", message: { role: "user", content: "Continue" } })}\n`);
      await observe();
      expect(observer.externalWriteVersion(sessionId)).toBe(1);
      await observe();
      expect(observer.externalWriteVersion(sessionId)).toBe(1);
      await eventLog.append({ sessionId, turnId: "bridge-turn", itemId: "bridge-user", origin: "mobile", type: "user.message.accepted", data: { text: "Continue" } });
      await observe();
      expect(observer.externalWriteVersion(sessionId)).toBe(1);
    } finally {
      await observer.close();
      await eventLog.close();
    }
  });

  it("keeps a focused idle Desktop executor exclusive while tracking real user writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-viewer-"));
    directories.push(root);
    const desktopSessions = join(root, "desktop-sessions");
    const paths = {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    };
    await Promise.all([
      mkdir(paths.sessions, { recursive: true }),
      mkdir(paths.tasks, { recursive: true }),
      mkdir(paths.projects, { recursive: true }),
      mkdir(desktopSessions, { recursive: true }),
    ]);
    const sessionId = "session-viewer";
    const cwd = join(root, "work");
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    const oldTimestamp = Date.now() - 60_000;
    await mkdir(cwd, { recursive: true });
    await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd,
      startedAt: oldTimestamp,
      entrypoint: "claude-desktop-3p",
    }));
    const desktopSessionPath = join(desktopSessions, "local_viewer.json");
    await writeFile(desktopSessionPath, JSON.stringify({
      sessionId: "desktop-viewer",
      cliSessionId: sessionId,
      cwd,
      createdAt: oldTimestamp,
      lastFocusedAt: oldTimestamp,
      lastActivityAt: oldTimestamp,
      title: "Viewer",
    }));
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        timestamp: new Date(oldTimestamp).toISOString(),
        message: { role: "user", content: "Run" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        timestamp: new Date(oldTimestamp + 1).toISOString(),
        message: { role: "assistant", content: "Done", stop_reason: "end_turn" },
      }),
      "",
    ].join("\n"));
    await utimes(transcript, oldTimestamp / 1_000, oldTimestamp / 1_000);

    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      platform: "linux",
      pollIntervalMs: 20,
      catalogIntervalMs: 20,
      idleGraceMs: 1_000,
    });
    await observer.start();
    await waitFor(() => observer.catalog.sessions.some((session) => session.sessionId === sessionId));

    expect(observer.catalog.sessions.find((session) => session.sessionId === sessionId)?.desktopProcessAlive)
      .toBe(true);
    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
    await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
    expect(observer.isDesktopBusy(sessionId)).toBe(false);
    expect(observer.externalWriteVersion(sessionId)).toBe(0);

    const previousActivityAt = observer.catalog.sessions.find((session) => session.sessionId === sessionId)!.lastActivityAt;
    const focusedAt = Date.now();
    await writeFile(desktopSessionPath, JSON.stringify({
      sessionId: "desktop-viewer",
      cliSessionId: sessionId,
      cwd,
      createdAt: oldTimestamp,
      lastFocusedAt: focusedAt,
      lastActivityAt: oldTimestamp,
      title: "Viewer",
    }));
    await waitFor(() => observer.catalog.observedAt > focusedAt);
    expect(observer.catalog.sessions.find((session) => session.sessionId === sessionId)?.lastActivityAt).toBe(previousActivityAt);
    expect(observer.isDesktopBusy(sessionId)).toBe(false);
    expect(observer.externalWriteVersion(sessionId)).toBe(0);

    const previousTranscriptMtime = observer.catalog.sessions.find(
      (session) => session.sessionId === sessionId,
    )?.transcriptMtimeMs ?? 0;
    await appendFile(transcript, `${JSON.stringify({
      type: "user",
      uuid: "control-interrupt",
      parentUuid: "assistant-1",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "[Request interrupted by user for tool use]" },
    })}\n`);
    await waitFor(() => (
      (observer.catalog.sessions.find((session) => session.sessionId === sessionId)?.transcriptMtimeMs ?? 0)
      > previousTranscriptMtime
    ));
    expect(observer.externalWriteVersion(sessionId)).toBe(0);
    await setDesktopExecutorAlive(observer, sessionId, join(paths.sessions, `${process.pid}.json`), false);
    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(true);

    await eventLog.append({
      sessionId,
      itemId: "bridge-user",
      timestamp: Date.now(),
      origin: "mobile",
      type: "user.message.accepted",
      data: { text: "Bridge command" },
    });
    await appendFile(transcript, `${JSON.stringify({
      type: "user",
      uuid: "bridge-user",
      parentUuid: "control-interrupt",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Bridge command" },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(observer.externalWriteVersion(sessionId)).toBe(0);

    await setDesktopExecutorAlive(observer, sessionId, join(paths.sessions, `${process.pid}.json`), true);
    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
    await eventLog.append({
      sessionId,
      itemId: "bridge-assistant-late",
      timestamp: Date.now(),
      origin: "claude-host",
      type: "assistant.completed",
      data: { text: "Bridge continued" },
    });
    await appendFile(transcript, `${[
      JSON.stringify({
        type: "user",
        uuid: "desktop-user",
        parentUuid: "bridge-user",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Desktop input" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "bridge-assistant-late",
        parentUuid: "bridge-user",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: "Bridge continued" },
      }),
    ].join("\n")}\n`);
    await waitFor(() => observer.externalWriteVersion(sessionId) === 1);
    expect(eventLog.latestItem(sessionId, "session.observed", "desktop-user")?.data)
      .toMatchObject({ role: "user", text: "Desktop input" });

    await observer.close();
    await eventLog.close();
  });

  it("uses the logical alias for ownership, evidence, settlement and external write versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-alias-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const nativeId = "native-session";
    const sessionId = "logical-session";
    const transcript = join(paths.projects, `${nativeId}.jsonl`);
    await Promise.all([mkdir(paths.sessions, { recursive: true }), mkdir(paths.projects, { recursive: true })]);
    await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: nativeId, cwd: root, startedAt: Date.now() - 1_000, entrypoint: "claude-desktop-3p",
    }));
    await writeFile(transcript, [
      JSON.stringify({ type: "user", uuid: "first-user", parentUuid: null, message: { role: "user", content: "First" } }),
      JSON.stringify({ type: "assistant", uuid: "first-tool", parentUuid: "first-user", message: { role: "assistant", content: [{ type: "tool_use", id: "owned-tool", name: "Read", input: { file_path: "owned.txt" } }] } }),
      JSON.stringify({ type: "user", uuid: "first-result", parentUuid: "first-tool", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "owned-tool", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", uuid: "first-answer", parentUuid: "first-result", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }), "",
    ].join("\n"));
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const recovered: ObservedDesktopEvidence[] = [];
    const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 20, catalogIntervalMs: 20, evidence: { async upsertDesktopEvidence(input) { recovered.push(input); } } });
    observer.setSessionAlias(nativeId, sessionId);
    try {
      await eventLog.append({ sessionId, itemId: "owned-tool", origin: "claude-host", type: "tool.started", data: { toolName: "Read" } });
      await observer.start();
      await eventLog.append({ sessionId, turnId: "bridge-turn", itemId: "bridge-user", origin: "mobile", type: "user.message.accepted", data: { text: "Bridge" } });
      await appendFile(transcript, [
        JSON.stringify({ type: "user", uuid: "bridge-user", parentUuid: "first-answer", message: { role: "user", content: "Bridge" } }),
        JSON.stringify({ type: "user", uuid: "desktop-user", parentUuid: "bridge-user", message: { role: "user", content: "Desktop" } }), "",
      ].join("\n"));
      await utimes(transcript, new Date(), new Date(Date.now() + 1_000));
      await waitFor(() => Boolean(eventLog.latestItem(sessionId, "session.observed", "desktop-user")));
      expect(observer.externalWriteVersion(nativeId)).toBe(1);
      expect(observer.externalWriteVersion(sessionId)).toBe(1);
      expect(recovered).toEqual([]);
      expect(eventLog.latestItem(sessionId, "session.observed", "bridge-user")).toBeUndefined();
      expect(observer.isMainTurnBusy(sessionId)).toBe(true);
      await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
      await eventLog.append({ sessionId, turnId: "desktop-turn", itemId: "desktop-user", origin: "mobile", type: "user.message.accepted", data: { text: "Desktop" } });
      await eventLog.append({ sessionId, turnId: "desktop-turn", origin: "claude-host", type: "turn.completed", data: {} });
      expect(observer.isMainTurnBusy(nativeId)).toBe(false);
      expect(observer.isMainTurnBusy(sessionId)).toBe(false);
      await expect(observer.canStartBridgeHost(nativeId)).resolves.toBe(false);
      await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
      await setDesktopExecutorAlive(observer, sessionId, join(paths.sessions, `${process.pid}.json`), false);
      await expect(observer.canStartBridgeHost(nativeId)).resolves.toBe(true);
      await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(true);
      expect(observer.externalWriteVersion(nativeId)).toBe(1);
      expect(observer.externalWriteVersion(sessionId)).toBe(1);
    } finally {
      await observer.close();
      await eventLog.close();
    }
  });

  it.each([false, true].flatMap(alias => [false, true].map(queued => ({ alias, queued }))))("tracks background shell tasks past end_turn and clears fresh completion evidence (alias=$alias, queued=$queued)", async ({ alias, queued }) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-background-shell-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const nativeId = "background-shell-native";
    const logicalId = alias ? "background-shell-logical" : nativeId;
    const transcript = join(paths.projects, `${nativeId}.jsonl`);
    await Promise.all([mkdir(paths.sessions, { recursive: true }), mkdir(paths.projects, { recursive: true })]);
    await writeFile(join(paths.sessions, "executor.json"), JSON.stringify({
      pid: process.pid, sessionId: nativeId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
    }));
    await writeFile(transcript, [
      { type: "user", uuid: "start", parentUuid: null, message: { role: "user", content: "Run the job" } },
      { type: "assistant", uuid: "bash", parentUuid: "start", message: { role: "assistant", content: [{ type: "tool_use", id: "bash-call", name: "Bash", input: { command: "long-job" } }] } },
      { type: "user", uuid: "bash-result", parentUuid: "bash", toolUseResult: { backgroundTaskId: "shell-1" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-call", content: "Running in background" }] } },
      { type: "assistant", uuid: "done", parentUuid: "bash-result", message: { role: "assistant", stop_reason: "end_turn", content: "The job is still running." } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 20, catalogIntervalMs: 60_000 });
    if (alias) observer.setSessionAlias(nativeId, logicalId);
    try {
      await observer.start();
      expect(observer.isMainTurnBusy(nativeId)).toBe(false);
      expect(observer.hasPendingBackgroundShellTasks(nativeId)).toBe(true);
      expect(observer.hasPendingBackgroundShellTasks(logicalId)).toBe(true);
      expect(observer.hasPendingBackgroundShellTasks("unknown-session")).toBe(false);

      await appendFile(transcript, [
        queued
          ? { type: "attachment", uuid: "finished", parentUuid: "done", attachment: { type: "queued_command", prompt: "<task-notification><task-id>shell-1</task-id><status>completed</status></task-notification>", origin: "task-notification" } }
          : { type: "user", uuid: "finished", parentUuid: "done", isMeta: true, message: { role: "user", content: "<task-notification><task-id>shell-1</task-id><status>completed</status></task-notification>" } },
        { type: "assistant", uuid: "confirmed", parentUuid: "finished", message: { role: "assistant", stop_reason: "end_turn", content: "The job finished." } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      await utimes(transcript, new Date(), new Date(Date.now() + 1_000));
      await waitFor(() => !observer.hasPendingBackgroundShellTasks(nativeId));
      expect(observer.hasPendingBackgroundShellTasks(logicalId)).toBe(false);
      expect(observer.isMainTurnBusy(logicalId)).toBe(false);
    } finally {
      await observer.close();
      await eventLog.close();
    }
  });

  it("requires Desktop executor exit for a new or reused host despite a main-turn boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-reuse-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "session-reuse";
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    const subagents = join(paths.projects, sessionId, "subagents");
    await Promise.all([mkdir(paths.sessions, { recursive: true }), mkdir(subagents, { recursive: true })]);
    await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
    }));
    await writeFile(transcript, [
      JSON.stringify({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "First turn" } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-1", parentUuid: "user-1", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }),
      "",
    ].join("\n"));
    await writeFile(join(subagents, "agent-old.meta.json"), JSON.stringify({ description: "Previous child", finished: false }));
    await writeFile(join(subagents, "agent-old.jsonl"), `${JSON.stringify({
      type: "assistant", uuid: "child-tool", timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "tool_use", id: "old-tool", name: "Read", input: {} }] },
    })}\n`);
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 20, catalogIntervalMs: 20 });
    try {
      await observer.start();
      expect(observer.catalog.sessions.find((session) => session.sessionId === sessionId), "catalog contains Desktop executor").toBeDefined();
      expect(observer.isDesktopBusy(sessionId), "subagent activity remains visible").toBe(true);
      expect(observer.isMainTurnBusy(sessionId)).toBe(false);
      expect(observer.runningSubagents(sessionId)?.count).toBe(1);
      await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
      await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
      await setDesktopExecutorAlive(observer, sessionId, join(paths.sessions, `${process.pid}.json`), false);
      await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(true);
      await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(true);
      await setDesktopExecutorAlive(observer, sessionId, join(paths.sessions, `${process.pid}.json`), true);
      await appendFile(transcript, `${JSON.stringify({ type: "user", uuid: "native-next", parentUuid: "assistant-1", message: { role: "user", content: "New Desktop input" } })}\n`);
      await waitFor(() => observer.externalWriteVersion(sessionId) === 1);
      expect(observer.isMainTurnBusy(sessionId)).toBe(true);
      await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
      await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
    } finally {
      await observer.close();
      await eventLog.close();
    }
  });

  it("keeps a hung subagent running until it is stopped, without blaming the main conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-stalled-subagent-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "session-stalled-subagent";
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    const subagents = join(paths.projects, sessionId, "subagents");
    const timestamp = new Date().toISOString();
    await Promise.all([mkdir(paths.sessions, { recursive: true }), mkdir(subagents, { recursive: true })]);
    await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId, cwd: root, startedAt: Date.now() - 1_000, entrypoint: "claude-desktop-3p",
    }));
    await writeFile(transcript, [
      JSON.stringify({ type: "user", uuid: "user-1", parentUuid: null, timestamp, message: { role: "user", content: "Check this" } }),
      JSON.stringify({ type: "assistant", uuid: "launch", parentUuid: "user-1", timestamp, message: { role: "assistant", content: [{ type: "tool_use", id: "agent-call", name: "Agent", input: { description: "Stalled child" } }], stop_reason: "tool_use" } }),
      JSON.stringify({ type: "user", uuid: "launched", parentUuid: "launch", timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "agent-call", content: "Async agent launched successfully.\nagentId: stalled" }] } }),
      JSON.stringify({ type: "assistant", uuid: "answer", parentUuid: "launched", timestamp, message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }),
      "",
    ].join("\n"));
    await writeFile(join(subagents, "agent-stalled.meta.json"), JSON.stringify({ description: "Stalled child", toolUseId: "agent-call" }));
    await writeFile(join(subagents, "agent-stalled.jsonl"), `${JSON.stringify({
      type: "assistant", uuid: "child-tool", timestamp,
      message: { role: "assistant", content: [{ type: "tool_use", id: "child-read", name: "Read", input: {} }] },
    })}\n`);
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 20, catalogIntervalMs: 60_000 });
    try {
      await observer.start();
      const realNow = Date.now.bind(Date);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 7 * 3_600_000);
      try {
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(observer.isDesktopBusy(sessionId), "a hung subagent is still unfinished").toBe(true);
        expect(observer.isMainTurnBusy(sessionId), "the main conversation already ended").toBe(false);
        expect(observer.runningSubagents(sessionId)?.count).toBe(1);
        expect(eventLog.latestItem(sessionId, "tool.completed", "agent-call")).toBeUndefined();
      } finally {
        clock.mockRestore();
      }

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(eventLog.latestItem(sessionId, "tool.completed", "agent-call"), "a stop request is not terminal evidence").toBeUndefined();
      expect(observer.runningSubagents(sessionId)?.count).toBe(1);
      await appendFile(transcript, `${JSON.stringify({
        type: "user", uuid: "stopped-notification", parentUuid: "answer", timestamp: new Date().toISOString(),
        message: { role: "user", content: "<task-notification><task-id>stalled</task-id><status>stopped</status></task-notification>" },
      })}\n`);
      await waitFor(() => Boolean(eventLog.latestItem(sessionId, "tool.completed", "agent-call")));
      expect((eventLog.latestItem(sessionId, "tool.completed", "agent-call")?.data.subagent as { state?: string }).state).toBe("stopped");
      await waitFor(() => observer.isMainTurnBusy(sessionId));
      expect(observer.isMainTurnBusy(sessionId), "the notification starts a main-turn follow-up").toBe(true);
      expect(observer.runningSubagents(sessionId)).toBeUndefined();
    } finally {
      await observer.close();
      await eventLog.close();
    }
  });

  it("removes compacted historical children from the live count and publishes their uncertain state", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-compact-tasks-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "session-compacted-child";
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    const children = join(paths.projects, sessionId, "subagents");
    const startedAt = Date.now() - 20_000;
    await Promise.all([mkdir(paths.sessions, { recursive: true }), mkdir(children, { recursive: true })]);
    await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId, cwd: root, startedAt: startedAt - 1_000, entrypoint: "claude-desktop-3p",
    }));
    await writeFile(transcript, `${JSON.stringify({ type: "user", uuid: "user", timestamp: new Date(startedAt).toISOString(), message: { role: "user", content: "Review" } })}\n`);
    await writeFile(join(children, "agent-old.meta.json"), JSON.stringify({ description: "Old child", toolUseId: "old-call" }));
    await writeFile(join(children, "agent-old.jsonl"), `${JSON.stringify({
      type: "assistant", timestamp: new Date(startedAt).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] },
    })}\n`);
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 20, catalogIntervalMs: 60_000 });
    try {
      await observer.start();
      expect(observer.runningSubagents(sessionId)?.count).toBe(1);
      await appendFile(transcript, `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(startedAt + 10_000).toISOString() })}\n`);
      await waitFor(() => !observer.runningSubagents(sessionId));
      const updated = eventLog.latestItem(sessionId, "tool.completed", "old-call");
      expect(updated?.data.subagent).toMatchObject({ state: "unknown", updatedAt: startedAt + 10_000 });
      expect(observer.runningSubagents(sessionId)).toBeUndefined();
    } finally {
      await observer.close();
      await eventLog.close();
    }
  });

  it.each([false, true])("ends an external subagent after process exit, deferring publication while SDK owns it (%s)", async (hostAuthority) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-dead-subagent-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "session-dead-subagent";
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    const subagents = join(paths.projects, sessionId, "subagents");
    await Promise.all([mkdir(paths.sessions, { recursive: true }), mkdir(subagents, { recursive: true })]);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await writeFile(join(paths.sessions, `${child.pid}.json`), JSON.stringify({
      pid: child.pid, sessionId, cwd: root, startedAt: Date.now() - 1_000, entrypoint: "claude-desktop-3p",
    }));
    await writeFile(transcript, [
      JSON.stringify({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "Check this" } }),
      JSON.stringify({ type: "assistant", uuid: "answer", parentUuid: "user-1", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }),
      "",
    ].join("\n"));
    await writeFile(join(subagents, "agent-orphan.meta.json"), JSON.stringify({ description: "Orphan", toolUseId: "agent-call" }));
    await writeFile(join(subagents, "agent-orphan.jsonl"), `${JSON.stringify({
      type: "assistant", uuid: "child-tool", timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "tool_use", id: "child-read", name: "Read", input: {} }] },
    })}\n`);
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 20, catalogIntervalMs: 40 });
    try {
      await observer.start();
      expect(observer.runningSubagents(sessionId)?.count).toBe(1);
      if (hostAuthority) {
        observer.setSessionAlias(sessionId, "logical-dead-session");
        observer.setHostTaskAuthority("logical-dead-session", true);
      }
      child.kill("SIGTERM");
      await exited;
      if (hostAuthority) {
        await waitFor(() => !observer.catalog.sessions.find((session) => session.sessionId === sessionId)?.processAlive);
        expect(eventLog.latestItem("logical-dead-session", "tool.completed", "agent-call"), "SDK task state owns publication").toBeUndefined();
        observer.setHostTaskAuthority("logical-dead-session", false);
        await waitFor(() => Boolean(eventLog.latestItem("logical-dead-session", "tool.completed", "agent-call")));
        expect((eventLog.latestItem("logical-dead-session", "tool.completed", "agent-call")?.data.subagent as { state?: string }).state).toBe("stopped");
        return;
      }
      await waitFor(() => Boolean(eventLog.latestItem(sessionId, "tool.completed", "agent-call")));
      expect((eventLog.latestItem(sessionId, "tool.completed", "agent-call")?.data.subagent as { state?: string }).state).toBe("stopped");
    } finally {
      child.kill("SIGTERM");
      await observer.close();
      await eventLog.close();
    }
  });

  it.each(["turn.completed", "turn.failed", "turn.interrupted"] as const)(
    "accepts a matched %s when the transcript has no final assistant message",
    async (terminal) => {
      const root = await mkdtemp(join(tmpdir(), "bridge-observer-settled-turn-"));
      directories.push(root);
      const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
      const sessionId = "session-empty-result";
      const transcript = join(paths.projects, `${sessionId}.jsonl`);
      const subagents = join(paths.projects, sessionId, "subagents");
      await Promise.all([mkdir(paths.sessions, { recursive: true }), mkdir(subagents, { recursive: true })]);
      await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
        pid: process.pid, sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
      }));
      await writeFile(transcript, [
        JSON.stringify({ type: "user", uuid: "bridge-user", parentUuid: null, message: { role: "user", content: "Continue" } }),
        JSON.stringify({ type: "attachment", uuid: "context", parentUuid: "bridge-user", attachment: { type: "mcp_instructions_delta" } }),
        "",
      ].join("\n"));
      await writeFile(join(subagents, "agent-old.meta.json"), JSON.stringify({ description: "Previous child", finished: false }));
      await writeFile(join(subagents, "agent-old.jsonl"), `${JSON.stringify({
        type: "assistant", uuid: "child-tool", timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "tool_use", id: "old-tool", name: "Read", input: {} }] },
      })}\n`);
      const eventLog = new SessionEventLog(join(root, "events.jsonl"));
      const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 20, catalogIntervalMs: 20 });
      try {
        await eventLog.append({ sessionId, turnId: "bridge-turn", itemId: "bridge-user", origin: "mobile", type: "user.message.accepted", data: { text: "Continue" } });
        await observer.start();
        expect(observer.isMainTurnBusy(sessionId)).toBe(true);
        expect(observer.runningSubagents(sessionId)?.count).toBe(1);
        await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
        await eventLog.append({ sessionId, turnId: "another-turn", origin: "claude-host", type: terminal, data: { result: "" } });
        expect(observer.isMainTurnBusy(sessionId), "an unrelated turn cannot settle the pending input").toBe(true);
        await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
        await eventLog.append({ sessionId, turnId: "bridge-turn", origin: "claude-host", type: terminal, data: { result: "" } });
        expect(observer.isMainTurnBusy(sessionId)).toBe(false);
        expect(observer.isDesktopBusy(sessionId)).toBe(false);
        await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
        await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
        await setDesktopExecutorAlive(observer, sessionId, join(paths.sessions, `${process.pid}.json`), false);
        await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(true);
        await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(true);
        await setDesktopExecutorAlive(observer, sessionId, join(paths.sessions, `${process.pid}.json`), true);

        await appendFile(transcript, `${JSON.stringify({ type: "user", uuid: "notification", parentUuid: "context", message: { role: "user", content: "<task-notification>Child finished</task-notification>" } })}\n`);
        await waitFor(() => observer.isMainTurnBusy(sessionId));
        await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
        const beforeFollowup = observer.session(sessionId)!.transcriptMtimeMs;
        await appendFile(transcript, `${JSON.stringify({ type: "assistant", uuid: "followup-tool", parentUuid: "notification", message: { role: "assistant", content: [{ type: "tool_use", id: "followup", name: "Read", input: {} }], stop_reason: "tool_use" } })}\n`);
        await waitFor(() => observer.session(sessionId)!.transcriptMtimeMs > beforeFollowup);
        expect(observer.isMainTurnBusy(sessionId)).toBe(true);
        await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
        const beforeDesktopInput = observer.externalWriteVersion(sessionId);
        await appendFile(transcript, `${JSON.stringify({ type: "user", uuid: "desktop-next", parentUuid: "followup-tool", message: { role: "user", content: "New Desktop input" } })}\n`);
        await waitFor(() => observer.externalWriteVersion(sessionId) > beforeDesktopInput);
        expect(observer.isMainTurnBusy(sessionId)).toBe(true);
        await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
        await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
      } finally {
        await observer.close();
        await eventLog.close();
      }
    },
  );

  it("keeps a Desktop tool turn running until the transcript reaches an end-turn boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-running-turn-"));
    directories.push(root);
    const desktopSessions = join(root, "desktop-sessions");
    const paths = {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    };
    await Promise.all([
      mkdir(paths.sessions, { recursive: true }),
      mkdir(paths.tasks, { recursive: true }),
      mkdir(paths.projects, { recursive: true }),
      mkdir(desktopSessions, { recursive: true }),
    ]);
    const sessionId = "session-running-turn";
    const cwd = join(root, "work");
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    const oldTimestamp = Date.now() - 60_000;
    await mkdir(cwd, { recursive: true });
    await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd,
      startedAt: oldTimestamp,
      entrypoint: "claude-desktop-3p",
    }));
    await writeFile(join(desktopSessions, "local_running-turn.json"), JSON.stringify({
      sessionId: "desktop-running-turn",
      cliSessionId: sessionId,
      cwd,
      createdAt: oldTimestamp,
      lastFocusedAt: oldTimestamp,
      lastActivityAt: oldTimestamp,
      title: "Running turn",
    }));
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        timestamp: new Date(oldTimestamp).toISOString(),
        message: { role: "user", content: "Run checks" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "tool-1",
        parentUuid: "user-1",
        timestamp: new Date(oldTimestamp + 1).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "npm test" } }],
          stop_reason: "tool_use",
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "result-1",
        parentUuid: "tool-1",
        timestamp: new Date(oldTimestamp + 2).toISOString(),
        toolUseResult: "passed",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "passed" }],
        },
      }),
      "",
    ].join("\n"));
    await utimes(transcript, oldTimestamp / 1_000, oldTimestamp / 1_000);

    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      platform: "linux",
      pollIntervalMs: 20,
      catalogIntervalMs: 20,
      idleGraceMs: 1,
    });
    await observer.start();
    await waitFor(() => observer.catalog.sessions.some((session) => session.sessionId === sessionId));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(observer.isDesktopBusy(sessionId)).toBe(true);
    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);

    await appendFile(transcript, `${JSON.stringify({
      type: "assistant",
      uuid: "assistant-final",
      parentUuid: "result-1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Finished", stop_reason: "end_turn" },
    })}\n`);
    await waitFor(() => !observer.isDesktopBusy(sessionId));

    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);
    await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
    await setDesktopExecutorAlive(observer, sessionId, join(paths.sessions, `${process.pid}.json`), false);
    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(true);
    await observer.close();
    await eventLog.close();
  });

  it("publishes an updated observed message when an assistant chain grows", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-"));
    directories.push(root);
    const desktopSessions = join(root, "desktop-sessions");
    const paths = {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    };
    await Promise.all([
      mkdir(paths.sessions, { recursive: true }),
      mkdir(paths.tasks, { recursive: true }),
      mkdir(paths.projects, { recursive: true }),
      mkdir(desktopSessions, { recursive: true }),
    ]);
    const sessionId = "session-observer";
    const cwd = join(root, "work");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(paths.sessions, `${sessionId}.json`), JSON.stringify({
      sessionId,
      cwd,
      startedAt: Date.now(),
    }));
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        timestamp: new Date().toISOString(),
        message: { content: "Start" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        timestamp: new Date().toISOString(),
        message: { content: "First" },
      }),
      "",
    ].join("\n"));

    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      platform: "linux",
      pollIntervalMs: 20,
    });
    await observer.start();
    expect(eventLog.replay()).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 30));
    await appendFile(transcript, `${JSON.stringify({
      type: "assistant",
      uuid: "assistant-2",
      parentUuid: "assistant-1",
      timestamp: new Date().toISOString(),
      message: { content: "Second" },
    })}\n`);
    await waitFor(() => eventLog.replay().filter((event) => event.itemId === "assistant-1").length === 1);

    expect(eventLog.latestItem(sessionId, "session.observed", "assistant-1")?.data.text)
      .toBe("First\n\nSecond");
    await observer.close();
    await eventLog.close();
  });

  it("primes an older session before Bridge writes to it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-older-session-"));
    directories.push(root);
    const desktopSessions = join(root, "desktop-sessions");
    const paths = {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    };
    await Promise.all([
      mkdir(paths.sessions, { recursive: true }),
      mkdir(paths.tasks, { recursive: true }),
      mkdir(paths.projects, { recursive: true }),
      mkdir(desktopSessions, { recursive: true }),
    ]);
    const now = Date.now();
    for (let index = 0; index < 24; index += 1) {
      await writeFile(join(desktopSessions, `local_newer-${index}.json`), JSON.stringify({
        sessionId: `desktop-newer-${index}`,
        cliSessionId: `session-newer-${index}`,
        cwd: root,
        createdAt: now - index,
        lastFocusedAt: now - index,
        lastActivityAt: now - index,
        title: `Newer ${index}`,
      }));
    }

    const sessionId = "session-older";
    const oldTimestamp = now - 60_000;
    await writeFile(join(desktopSessions, "local_older.json"), JSON.stringify({
      sessionId: "desktop-older",
      cliSessionId: sessionId,
      cwd: root,
      createdAt: oldTimestamp,
      lastFocusedAt: oldTimestamp,
      lastActivityAt: oldTimestamp,
      title: "Older",
    }));
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "older-user",
        parentUuid: null,
        timestamp: new Date(oldTimestamp).toISOString(),
        message: { role: "user", content: "Earlier work" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "older-assistant",
        parentUuid: "older-user",
        timestamp: new Date(oldTimestamp + 1).toISOString(),
        message: { role: "assistant", content: "Finished", stop_reason: "end_turn" },
      }),
      "",
    ].join("\n"));
    await utimes(transcript, oldTimestamp / 1_000, oldTimestamp / 1_000);

    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      platform: "linux",
      pollIntervalMs: 20,
      catalogIntervalMs: 20,
    });
    await observer.start();
    expect(observer.catalog.sessions.at(-1)?.sessionId).toBe(sessionId);
    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(true);

    await eventLog.append({
      sessionId,
      itemId: "bridge-user",
      timestamp: now,
      origin: "mobile",
      type: "user.message.accepted",
      data: { text: "Continue" },
    });
    await appendFile(transcript, `${JSON.stringify({
      type: "user",
      uuid: "bridge-user",
      parentUuid: "older-assistant",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Continue" },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(observer.externalWriteVersion(sessionId)).toBe(0);

    await observer.close();
    await eventLog.close();
  });

  it("upserts Desktop tool evidence idempotently and never treats thinking as chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-evidence-"));
    directories.push(root);
    const desktopSessions = join(root, "desktop-sessions");
    const paths = {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    };
    await Promise.all([
      mkdir(paths.sessions, { recursive: true }),
      mkdir(paths.tasks, { recursive: true }),
      mkdir(paths.projects, { recursive: true }),
      mkdir(desktopSessions, { recursive: true }),
    ]);
    const sessionId = "session-evidence";
    const cwd = join(root, "work");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(desktopSessions, "local_evidence.json"), JSON.stringify({
      sessionId: "desktop-evidence",
      cliSessionId: sessionId,
      cwd,
      createdAt: Date.now(),
      lastFocusedAt: Date.now(),
      lastActivityAt: Date.now(),
      title: "Evidence",
    }));
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Inspect" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "tool-node",
        parentUuid: "user-1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private analysis" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "report.txt" } },
          ],
          stop_reason: "tool_use",
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "result-1",
        parentUuid: "tool-node",
        timestamp: new Date().toISOString(),
        toolUseResult: "ok",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
        },
      }),
      "",
    ].join("\n"));
    const recovered: ObservedDesktopEvidence[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      platform: "linux",
      pollIntervalMs: 20,
      catalogIntervalMs: 20,
      evidence: {
        async upsertDesktopEvidence(input) {
          recovered.push(input);
        },
      },
    });
    await observer.start();
    await waitFor(() => recovered.length === 1);

    expect(recovered[0]).toMatchObject({
      sessionId,
      tools: [{ id: "tool-1", toolName: "Read" }],
      paths: ["report.txt"],
    });
    expect(JSON.stringify(recovered)).not.toContain("private analysis");
    await appendFile(transcript, `${JSON.stringify({
      type: "assistant",
      uuid: "thinking-only",
      parentUuid: "result-1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "thinking", thinking: "still private" }] },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recovered).toHaveLength(1);

    await observer.close();
    await eventLog.close();
  });
});
