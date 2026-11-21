import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import * as platform from "../app/platform.js";
import { createControllerFixture } from "../controller/controller-fixture.js";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixture } from "./claude-desktop-bridge-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

describe("native background tasks", () => {
  it("reads only the selected session metadata on sequential task polls", async () => {
    const f = await fixture(false, undefined, true);
    const paths = platform.claudeRuntimePaths("darwin", {}, f.directory);
    const resolvePaths = vi.spyOn(platform, "claudeRuntimePaths").mockReturnValue(paths);
    const reads = vi.mocked(readFile);
    reads.mockClear();
    vi.stubEnv("BRIDGE_DISABLE_PROCESS_SCAN", "1");
    try {
      const desktopRoot = paths.desktopSessions[0]!;
      const sessionId = "local-native";
      const sessionDir = join(desktopRoot, "profile", "account");
      const target = join(sessionDir, `${sessionId}.json`);
      const cwd = f.directory;
      await Promise.all([mkdir(sessionDir, { recursive: true }), mkdir(paths.projects, { recursive: true })]);
      await Promise.all([
        writeFile(target, JSON.stringify({ sessionId, cliSessionId: "target-cli", cwd })),
        ...Array.from({ length: 12 }, (_, index) => {
          const otherId = `local_11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
          return writeFile(join(sessionDir, `${otherId}.json`), JSON.stringify({ sessionId: otherId, cliSessionId: `other-${index}`, cwd }));
        }),
      ]);
      const transcript = join(paths.projects, "target-cli.jsonl");
      await writeFile(transcript, [
        { type: "assistant", uuid: "use", timestamp: new Date(10_000).toISOString(), message: { content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Inspect", prompt: "Inspect" } }] } },
        { type: "user", uuid: "result", parentUuid: "use", timestamp: new Date(11_000).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "agent", content: "Async agent launched successfully. agentId: ag-1" }] } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");

      expect(await f.bridge.backgroundTaskDetails(sessionId)).toMatchObject([{ id: "agent", state: "stopped" }]);
      await appendFile(transcript, JSON.stringify({
        type: "user", uuid: "done", parentUuid: "result", timestamp: new Date(12_000).toISOString(),
        message: { role: "user", content: "<task-notification>\n<task-id>ag-1</task-id>\n<status>completed</status>\n</task-notification>" },
      }) + "\n");
      expect(await f.bridge.backgroundTaskDetails(sessionId)).toMatchObject([{ id: "agent", state: "completed" }]);
      expect(reads.mock.calls.map(([path]) => path).filter(path => typeof path === "string" && path.startsWith(desktopRoot) && path.endsWith(".json"))).toEqual([target, target]);
    } finally {
      reads.mockClear();
      resolvePaths.mockRestore();
      vi.unstubAllEnvs();
      await f.close();
    }
  });

  it("keeps task detail reads optional and lets conversation opening finish independently", async () => {
    const f = await fixture();
    try {
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const tasks = [{ id: "shell", kind: "bash" as const, description: "Build", state: "completed" as const, startedAt: 1, updatedAt: 2 }];
      let release!: (value: typeof tasks) => void;
      const details = vi.spyOn(f.bridge, "backgroundTaskDetails").mockImplementation(() => new Promise<typeof tasks>(resolve => { release = resolve; }));
      const history = vi.spyOn(f.bridge, "history");
      const request = { kind: "request" as const, requestId: "configuration", idempotencyKey: "configuration", method: "session.configuration" as const, params: { sessionId: "local-native" } };
      await controller.handleRequest(request, "mobile", "phone");
      expect(details).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      const pending = controller.handleRequest({ ...request, params: { ...request.params, includeBackgroundTasks: true } }, "mobile", "phone");
      await vi.waitFor(() => expect(details).toHaveBeenCalledExactlyOnceWith("local-native"));
      const opened = await controller.handleRequest({ ...request, method: "session.open" }, "mobile", "phone");
      expect(opened).toHaveProperty("history.items", []);
      release(tasks);
      expect(await pending).toHaveProperty("session.backgroundTasks", tasks);
      expect(history).toHaveBeenCalledTimes(1);
      expect(f.bridge.listSessions()[0]?.backgroundTasks).toBeUndefined();
    } finally { await f.close(); }
  });

  it("caches transcript background tasks by native Desktop ID and uses process lifetime independently of the main turn", async () => {
    const f = await fixture();
    try {
      const transcript = join(f.options.settingsPath, "..", "cli-session.jsonl");
      const rows = [
        { type: "assistant", message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: { command: "fixture-only", description: "Watch build", run_in_background: true } }] } },
        { type: "user", toolUseResult: { backgroundTaskId: "shell-task" }, message: { content: [{ type: "tool_result", tool_use_id: "shell", content: "Background task" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Read fixtures", prompt: "Read" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent", content: "Async agent launched successfully. agentId: agent-task" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "workflow", name: "Workflow", input: { scriptPath: "/fixture.js" } }] } },
        { type: "user", toolUseResult: { status: "async_launched", taskId: "workflow-task", taskType: "local_workflow", workflowName: "Review", runId: "wf_fixture", summary: "Check fixtures" }, message: { content: [{ type: "tool_result", tool_use_id: "workflow", content: "Workflow launched" }] } },
      ];
      await writeFile(transcript, rows.map((row, index) => JSON.stringify({ ...row, uuid: `row-${index}`, ...(index ? { parentUuid: `row-${index - 1}` } : {}), timestamp: new Date(10_000 + index * 1_000).toISOString(), isSidechain: false })).join("\n") + "\n");
      await mkdir(join(transcript.replace(/\.jsonl$/u, ""), "subagents", "workflows", "wf_fixture"), { recursive: true });
      await writeFile(join(transcript.replace(/\.jsonl$/u, ""), "subagents", "workflows", "wf_fixture", "journal.jsonl"), JSON.stringify({ type: "started", agentId: "workflow-agent", phase: "Check", label: "Check sources" }) + "\n");
      const observed = {
        ...f.bridge.session("local-native")!, sessionId: "cli-session", desktopSessionId: "local-native", transcriptPath: transcript,
        transcriptMtimeMs: 0, processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false, processOverlap: false, activeTask: false,
        activeProcesses: [
          { startedAt: 1_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" as const },
          { startedAt: 30_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" as const },
        ],
      };
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [observed, { ...observed, sessionId: "foreign-cli", desktopSessionId: "foreign-native" }], observedAt: 0 });
      await f.bridge.refreshRuntime();
      const taskDetails = await f.bridge.backgroundTaskDetails("local-native");
      const snapshot = f.bridge.session("local-native")!;
      expect(snapshot.turnState).toBe("idle");
      expect(snapshot.runningSubagents?.count).toBe(1);
      expect(taskDetails).toMatchObject([
        { id: "workflow", kind: "workflow", state: "running", workflow: { runId: "wf_fixture", phases: ["Check"], agents: [{ agentId: "workflow-agent", state: "running" }] } },
        { id: "agent", kind: "subagent", state: "running" },
        { id: "shell", kind: "bash", state: "running" },
      ]);
      expect(f.bridge.listSessions()).toHaveLength(1);
      f.options.scanCatalog.mockClear();
      expect(snapshot.backgroundTasks).toBeUndefined();
      expect(f.bridge.listSessions()[0]?.backgroundTasks).toBeUndefined();
      expect(f.options.scanCatalog).not.toHaveBeenCalled();
      f.native.sessions[0]!.turnRunning = true;
      observed.activeProcesses = [];
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.turnState).toBe("running");
      expect((await f.bridge.backgroundTaskDetails("local-native")).every(task => task.state === "stopped")).toBe(true);
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
    } finally { await f.close(); }
  });

  it("coalesces overlapping backgroundTaskDetails and subagent enrichment catalog reads while keeping subsequent reads fresh", async () => {
    const f = await fixture();
    try {
      const transcript = join(f.options.settingsPath, "..", "coalesce-session.jsonl");
      await writeFile(transcript, [
        JSON.stringify({ type: "assistant", uuid: "a1", timestamp: new Date(10_000).toISOString(), isSidechain: false, message: { content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { description: "First agent", prompt: "Inspect" } }] } }),
        JSON.stringify({ type: "user", uuid: "u1", parentUuid: "a1", timestamp: new Date(11_000).toISOString(), isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: "agent-1", content: "Async agent launched successfully. agentId: ag-1" }] } }),
      ].join("\n") + "\n");
      const observed = {
        ...f.bridge.session("local-native")!, sessionId: "coalesce-cli", desktopSessionId: "local-native", transcriptPath: transcript,
        transcriptMtimeMs: 0, processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false, processOverlap: false, activeTask: false,
        activeProcesses: [{ startedAt: 1_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" as const }],
      };
      let releaseCatalog!: () => void;
      f.options.scanCatalog.mockClear();
      f.options.scanCatalog.mockImplementationOnce(() => new Promise(resolve => {
        releaseCatalog = () => resolve({ projects: [], sessions: [observed], observedAt: 0 });
      }));
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [{ ...observed, activeProcesses: [] }], observedAt: 1 });

      const overlapping = [
        f.bridge.backgroundTaskDetails("local-native"),
        f.bridge.backgroundTaskDetails("local-native"),
        f.bridge.backgroundTaskDetails("local-native"),
        f.message({ type: "system", subtype: "task_started", task_id: "ag-1", tool_use_id: "agent-1", description: "First agent", timestamp: 11_000 }),
      ] as const;
      await vi.waitFor(() => expect(f.options.scanCatalog).toHaveBeenCalledTimes(1));
      releaseCatalog();
      const [first, second, third] = await Promise.all(overlapping);
      expect(f.options.scanCatalog).toHaveBeenCalledTimes(1);
      expect(first).toEqual(second);
      expect(second).toEqual(third);
      expect(first[0]).toMatchObject({ id: "agent-1", state: "running" });

      const afterExit = await f.bridge.backgroundTaskDetails("local-native");
      expect(f.options.scanCatalog).toHaveBeenCalledTimes(2);
      expect(afterExit[0]).toMatchObject({ id: "agent-1", state: "stopped" });
    } finally { await f.close(); }
  });

  it.each([undefined, "older-page"])("adds local actual child models to native history (%s), events and tray", async (cursor) => {
    const f = await fixture();
    try {
      const transcript = join(f.options.settingsPath, "..", "model-session.jsonl");
      await writeFile(transcript, "");
      const childDir = join(transcript.replace(/\.jsonl$/u, ""), "subagents");
      await mkdir(childDir, { recursive: true });
      const child = join(childDir, "agent-child-task.jsonl");
      await writeFile(join(childDir, "agent-child-task.meta.json"), JSON.stringify({ toolUseId: "agent-call" }));
      await writeFile(child, JSON.stringify({ type: "assistant", timestamp: new Date(1000).toISOString(), message: { model: "codex/gpt-6.1-sol", content: [], stop_reason: "tool_use" } }) + "\n");
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [{
        ...f.bridge.session("local-native")!, sessionId: "model-session", desktopSessionId: "local-native", transcriptPath: transcript,
        transcriptMtimeMs: 0, processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false, processOverlap: false, activeTask: false,
        activeProcesses: [{ startedAt: 1, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }],
      }], observedAt: 0 });
      const started = { type: "system", subtype: "task_started", task_id: "child-task", tool_use_id: "agent-call", description: "Inspect sources", timestamp: 1000 };
      const call = { type: "assistant", uuid: "call", message: { model: "parent-model", content: [{ type: "tool_use", id: "agent-call", name: "Agent", input: { model: "haiku" } }] } };
      f.native.page.messages = [call, started];
      expect((await f.bridge.history("local-native", cursor)).items.find(item => item.id === "agent-call")?.subagent).toMatchObject({ model: "codex/gpt-6.1-sol", state: "running" });
      // A page containing just the launch tool can still associate the child file by toolUseId.
      f.native.page.messages = [call];
      expect((await f.bridge.history("local-native", cursor)).items.find(item => item.id === "agent-call")?.subagent?.model).toBe("codex/gpt-6.1-sol");
      await f.message(started);
      expect(f.eventLog.latestItem("local-native", "tool.progress", "agent-call")?.data.subagent).toMatchObject({ model: "codex/gpt-6.1-sol", state: "running" });
      await writeFile(child, JSON.stringify({ type: "assistant", timestamp: new Date(2000).toISOString(), message: { model: "antigravity/gemini-4-carbon", content: [], stop_reason: "end_turn" } }) + "\n");
      await f.message({ type: "system", subtype: "task_notification", task_id: "child-task", status: "completed", summary: "Done", timestamp: 2000 });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "agent-call")?.data.subagent).toMatchObject({ model: "antigravity/gemini-4-carbon", state: "completed" });
      expect((await f.bridge.backgroundTaskDetails("local-native"))[0]?.subagent).toMatchObject({ model: "antigravity/gemini-4-carbon", state: "completed" });
      // Once observed, subsequent native progress without a child file keeps the actual model.
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [], observedAt: 0 });
      await f.message({ type: "system", subtype: "task_notification", task_id: "child-task", status: "completed", timestamp: 3000 });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "agent-call")?.data.subagent).toMatchObject({ model: "antigravity/gemini-4-carbon", state: "completed" });
      expect(f.native.calls.some(call => ["sendMessage", "subscribeToSession", "stopTask"].includes(call.method))).toBe(false);
    } finally { await f.close(); }
  });

  it("keeps native task IDs for individual task stopping", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "system", subtype: "task_started", task_id: "native-task", tool_use_id: "tool-call", description: "Read sources", timestamp: 10 });
      expect(f.eventLog.latestItem("local-native", "tool.progress", "tool-call")?.data.subagent).toMatchObject({ agentId: "native-task", state: "running" });
      expect(f.bridge.session("local-native")?.runningSubagents?.count).toBe(1);
      await f.bridge.stopSubagent("local-native", "native-task");
      expect(f.native.calls.at(-1)).toEqual({ method: "stopTask", args: ["local-native", "native-task"] });
      await f.message({ type: "system", subtype: "task_notification", task_id: "native-task", status: "completed", summary: "Done", timestamp: 20 });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "tool-call")?.data.subagent).toMatchObject({ agentId: "native-task", state: "completed", reportText: "Done" });
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
    } finally { await f.close(); }
  });

  it("projects a native task stop on the next detail read while the session process stays alive", async () => {
    const f = await fixture();
    try {
      const transcriptPath = join(f.directory, "stop-session.jsonl");
      const childDir = join(f.directory, "stop-session", "subagents");
      await mkdir(childDir, { recursive: true });
      await writeFile(transcriptPath, "");
      await writeFile(join(childDir, "agent-native-task.jsonl"), JSON.stringify({
        type: "assistant", timestamp: new Date(10_000).toISOString(), message: { stop_reason: null, content: [] },
      }) + "\n");
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [{
        ...f.bridge.session("local-native")!, sessionId: "stop-session", desktopSessionId: "local-native", transcriptPath,
        transcriptMtimeMs: 0, processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false,
        processOverlap: false, activeTask: false,
        activeProcesses: [{ startedAt: 1_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }],
      }], observedAt: 0 });
      const nativeCall = f.native.call.bind(f.native);
      const call = vi.spyOn(f.native, "call").mockImplementation(async (method, args) => {
        if (method === "stopTask") await writeFile(join(childDir, "agent-native-task.meta.json"), JSON.stringify({ stoppedByUser: true }));
        return nativeCall(method, args);
      });
      expect(await f.bridge.backgroundTaskDetails("local-native")).toMatchObject([{ taskId: "native-task", state: "running" }]);
      expect(f.bridge.session("local-native")?.runningSubagents?.count).toBe(1);

      await f.bridge.stopSubagent("local-native", "native-task");
      expect(call).toHaveBeenCalledWith("stopTask", ["local-native", "native-task"]);
      const changed = vi.fn();
      f.bridge.on("changed", changed);
      expect(await f.bridge.backgroundTaskDetails("local-native")).toMatchObject([{ taskId: "native-task", state: "stopped" }]);
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("preserves full multi-thousand-character subagent reports without truncation over short native summaries", async () => {
    const f = await fixture();
    try {
      const transcript = join(f.options.settingsPath, "..", "cli-session.jsonl");
      const childDir = join(transcript.replace(/\.jsonl$/u, ""), "subagents");
      await mkdir(childDir, { recursive: true });
      const childPath = join(childDir, "agent-child-task.jsonl");
      const fullReport = `## Subagent Audit Report 🧪\n\n${"- Verified invariant and full markdown detail line with emoji 🔍\n".repeat(180)}\n### Final Verdict\nPASS`;
      expect([...fullReport].length).toBeGreaterThan(8_000);
      await writeFile(transcript, `${JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "Audit" } })}\n`);
      await writeFile(join(childDir, "agent-child-task.meta.json"), JSON.stringify({ toolUseId: "agent-call", agentType: "verifier", description: "Audit sources", finished: true }));
      await writeFile(childPath, `${JSON.stringify({
        type: "assistant",
        timestamp: new Date(2_000).toISOString(),
        message: { model: "codex/gpt-6.1-sol", role: "assistant", content: [{ type: "text", text: fullReport }], stop_reason: "end_turn" },
      })}\n`);
      f.options.scanCatalog.mockResolvedValue({
        projects: [],
        sessions: [{
          ...f.bridge.session("local-native")!,
          sessionId: "cli-session",
          desktopSessionId: "local-native",
          transcriptPath: transcript,
          transcriptMtimeMs: 0,
          processAlive: true,
          desktopProcessAlive: true,
          bridgeProcessAlive: false,
          processOverlap: false,
          activeTask: false,
          activeProcesses: [{ startedAt: 1, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }],
        }],
        observedAt: 0,
      });

      const call = { type: "assistant", uuid: "call", message: { model: "parent-model", content: [{ type: "tool_use", id: "agent-call", name: "Agent", input: { description: "Audit sources" } }] } };
      const shortNotification = { type: "system", subtype: "task_notification", task_id: "child-task", tool_use_id: "agent-call", status: "completed", summary: "Done", timestamp: 2_000 };
      f.native.page.messages = [call, shortNotification];
      const page = await f.bridge.history("local-native", "older-cursor");
      const historySubagent = page.items.find(item => item.id === "agent-call")?.subagent;
      expect(historySubagent).toMatchObject({
        agentId: "child-task",
        model: "codex/gpt-6.1-sol",
        agentType: "verifier",
        state: "completed",
        latestText: "Done",
        reportText: fullReport,
      });

      await f.message(shortNotification);
      expect(f.eventLog.latestItem("local-native", "tool.completed", "agent-call")?.data.subagent).toMatchObject({
        agentId: "child-task",
        model: "codex/gpt-6.1-sol",
        state: "completed",
        reportText: fullReport,
      });

      // Resuming the same agentId under a new toolUseId keeps the running resume call separate from the completed call's report.
      const resumeCall = { type: "assistant", uuid: "resume-msg", message: { model: "parent-model", content: [{ type: "tool_use", id: "resume-call", name: "Agent", input: { resume: "child-task", description: "Follow-up audit" } }] } };
      const resumeStarted = { type: "system", subtype: "task_started", task_id: "child-task", tool_use_id: "resume-call", description: "Follow-up audit", timestamp: 3_000 };
      f.native.page.messages = [call, shortNotification, resumeCall, resumeStarted];
      const resumedPage = await f.bridge.history("local-native", "older-cursor");
      expect(resumedPage.items.find(item => item.id === "agent-call")?.subagent).toMatchObject({
        agentId: "child-task",
        toolUseId: "agent-call",
        state: "completed",
        reportText: fullReport,
      });
      const runningResumed = resumedPage.items.find(item => item.id === "resume-call")?.subagent;
      expect(runningResumed).toMatchObject({
        agentId: "child-task",
        toolUseId: "resume-call",
        model: "codex/gpt-6.1-sol",
        state: "running",
      });
      expect(runningResumed?.reportText).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("projects background subagent state from native hasBackgroundWork, refines on history and backgroundTaskDetails, and ignores orphaned tasks on dead sessions", async () => {
    const f = await fixture();
    try {
      f.native.sessions = [
        { sessionId: "local-native", cwd: "/project", title: "Active background", isRunning: false, turnRunning: false, hasBackgroundWork: true, lastActivityAt: 12_345, permissionMode: "default", model: "native-model", pendingToolPermissions: [] },
        { sessionId: "dead-native", cwd: "/project", title: "Dead session", isRunning: false, turnRunning: false, hasBackgroundWork: false, lastActivityAt: 5_000, permissionMode: "default", model: "native-model", pendingToolPermissions: [] },
      ];
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({
        turnState: "idle",
        runningSubagents: { count: 1, lastUpdatedAt: 12_345 },
      });
      expect(f.bridge.session("dead-native")?.runningSubagents).toBeUndefined();

      let changed = 0;
      f.bridge.on("changed", () => { changed += 1; });
      f.native.pages.set("", {
        messages: [
          { type: "system", subtype: "task_started", task_id: "bg-1", tool_use_id: "call-1", description: "Run local CI", timestamp: 20_000 },
          { type: "system", subtype: "task_started", task_id: "bg-2", tool_use_id: "call-2", description: "Audit report", timestamp: 25_000 },
        ],
        hasMore: false,
      });
      await f.bridge.history("local-native");
      expect(changed).toBe(1);
      expect(f.bridge.session("local-native")?.runningSubagents).toEqual({ count: 2, lastUpdatedAt: 25_000 });

      // Opening a dead historical session with an orphaned task_started must not revive runningSubagents.
      await f.bridge.history("dead-native");
      expect(f.bridge.session("dead-native")?.runningSubagents).toBeUndefined();

      // backgroundTaskDetails emits "changed" when local transcript subagent state changes.
      const transcript = join(f.options.settingsPath, "..", "bg-session.jsonl");
      await writeFile(
        transcript,
        [
          { type: "assistant", uuid: "row-0", timestamp: new Date(10_000).toISOString(), isSidechain: false, message: { content: [{ type: "tool_use", id: "call-1", name: "Agent", input: { description: "Run local CI", prompt: "Run" } }] } },
          { type: "user", uuid: "row-1", parentUuid: "row-0", timestamp: new Date(11_000).toISOString(), isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "Async agent launched successfully. agentId: bg-1" }] } },
        ].map(row => JSON.stringify(row)).join("\n") + "\n",
      );
      f.options.scanCatalog.mockResolvedValue({
        projects: [],
        sessions: [{
          ...f.bridge.session("local-native")!,
          sessionId: "bg-session",
          desktopSessionId: "local-native",
          transcriptPath: transcript,
          transcriptMtimeMs: 0,
          processAlive: true,
          desktopProcessAlive: true,
          bridgeProcessAlive: false,
          processOverlap: false,
          activeTask: false,
          activeProcesses: [{ startedAt: 1_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }],
        }],
        observedAt: 0,
      });
      changed = 0;
      await f.bridge.backgroundTaskDetails("local-native");
      expect(changed).toBe(1);
      expect(f.bridge.session("local-native")?.runningSubagents).toEqual({ count: 1, lastUpdatedAt: 10_000 });

      f.native.sessions[0]!.hasBackgroundWork = false;
      f.options.scanCatalog.mockResolvedValue({
        projects: [],
        sessions: [{
          ...f.bridge.session("local-native")!,
          sessionId: "bg-session",
          desktopSessionId: "local-native",
          transcriptPath: transcript,
          transcriptMtimeMs: 0,
          processAlive: false,
          desktopProcessAlive: false,
          bridgeProcessAlive: false,
          processOverlap: false,
          activeTask: false,
          activeProcesses: [],
        }],
        observedAt: 0,
      });
      await f.bridge.refreshRuntime();
      changed = 0;
      await f.bridge.backgroundTaskDetails("local-native");
      expect(changed).toBe(1);
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
    } finally { await f.close(); }
  });
});
