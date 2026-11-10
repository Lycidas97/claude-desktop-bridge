import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getClaudeSubagentsMtimeMs,
  readClaudeTranscriptBackgroundTasks,
  readClaudeTranscriptSubagents,
} from "./claude-history.js";

// Shapes mirror real Claude Code 2.1 session directories: the parent JSONL carries the
// Workflow / Bash launch results and <task-notification> records, `subagents/workflows/wf_*`
// holds the run's journal and agent transcripts, and `workflows/wf_*.json` is the run summary.

type Row = Record<string, unknown>;
const roots: string[] = [];
let sequence = 0;

function at(seconds: number): string {
  return new Date(1_800_000_000_000 + seconds * 1_000).toISOString();
}

function chain(rows: Row[]): string {
  let parentUuid: string | undefined;
  return rows.map((row) => {
    const uuid = `u-${sequence += 1}`;
    const line = JSON.stringify({ ...row, uuid, ...(parentUuid ? { parentUuid } : {}), isSidechain: false });
    parentUuid = uuid;
    return line;
  }).join("\n") + "\n";
}

function toolUse(seconds: number, id: string, name: string, input: Row): Row {
  return { type: "assistant", timestamp: at(seconds), message: {
    role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }],
  } };
}

function toolResult(seconds: number, id: string, text: string, toolUseResult: Row): Row {
  return { type: "user", timestamp: at(seconds), toolUseResult, message: {
    role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }],
  } };
}

function notification(seconds: number, taskId: string, status: string): Row {
  return { type: "user", timestamp: at(seconds), message: {
    role: "user",
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`,
  } };
}

function finishedAgent(seconds: number): Row[] {
  return [
    { type: "user", timestamp: at(seconds), message: { role: "user", content: "Do the step" } },
    { type: "assistant", timestamp: at(seconds + 1), message: { role: "assistant", stop_reason: "tool_use", content: [
      { type: "tool_use", id: `out-${seconds}`, name: "StructuredOutput", input: { verdict: "PASS" } },
    ] } },
    { type: "user", timestamp: at(seconds + 2), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: `out-${seconds}`, content: "Structured output provided successfully" },
    ] } },
  ];
}

function runningAgent(seconds: number): Row[] {
  return [
    { type: "user", timestamp: at(seconds), message: { role: "user", content: "Do the step" } },
    { type: "assistant", timestamp: at(seconds + 1), message: { role: "assistant", stop_reason: "tool_use", content: [
      { type: "tool_use", id: `read-${seconds}`, name: "Read", input: { file_path: "/tmp/figure.pdf" } },
    ] } },
  ];
}

function jsonl(rows: Row[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

const workflowLaunch: Row[] = [
  { type: "user", timestamp: at(0), message: { role: "user", content: "Review every figure" } },
  toolUse(1, "wf-call", "Workflow", { scriptPath: "/tmp/review.js", args: { batch: "/tmp/batch" } }),
  toolResult(2, "wf-call", "Workflow launched in background. Task ID: wtask01", {
    status: "async_launched", taskId: "wtask01", taskType: "local_workflow", workflowName: "figure-review",
    runId: "wf_abc123", summary: "Draft and check every figure", transcriptDir: "/tmp", scriptPath: "/tmp/review.js",
  }),
];

async function session(parentRows: Row[]) {
  const root = await mkdtemp(join(tmpdir(), "bridge-background-tasks-"));
  roots.push(root);
  const transcript = join(root, "session.jsonl");
  await writeFile(transcript, chain(parentRows));
  const runDir = join(root, "session", "subagents", "workflows", "wf_abc123");
  return { root, transcript, runDir };
}

async function writeWorkflowAgents(runDir: string): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "journal.jsonl"), jsonl([
    { type: "launched" },
    { type: "started", key: "v2:a", agentId: "a1", label: "Draft 2.1", phase: "Draft" },
    { type: "started", key: "v2:b", agentId: "a2", label: "Draft 2.2", phase: "Draft" },
    { type: "result", key: "v2:a", agentId: "a1", result: { verdict: "PASS" } },
    { type: "started", key: "v2:c", agentId: "a3", label: "Check 2.1", phase: "Check" },
  ]));
  await writeFile(join(runDir, "agent-a1.jsonl"), jsonl(finishedAgent(3)));
  await writeFile(join(runDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "drafter", description: "Draft 2.1", workflowPhase: "Draft" }));
  await writeFile(join(runDir, "agent-a2.jsonl"), jsonl(runningAgent(4)));
  await writeFile(join(runDir, "agent-a2.meta.json"), JSON.stringify({ agentType: "drafter", description: "Draft 2.2", workflowPhase: "Draft" }));
}

async function tasks(transcript: string, processAlive = true) {
  const liveSince = processAlive ? 0 : undefined;
  const subagents = await readClaudeTranscriptSubagents(transcript, liveSince);
  return readClaudeTranscriptBackgroundTasks(transcript, subagents, liveSince);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("workflow runs", () => {
  it("keeps the run directory and phase on workflow agents", async () => {
    const run = await session(workflowLaunch);
    await writeWorkflowAgents(run.runDir);
    expect(await readClaudeTranscriptSubagents(run.transcript, 0)).toMatchObject([
      { agentId: "a1", state: "completed", workflowRunId: "wf_abc123", workflowPhase: "Draft" },
      { agentId: "a2", state: "running", workflowRunId: "wf_abc123", workflowPhase: "Draft" },
    ]);
  });

  it("builds a live phase timeline from the journal before the run summary exists", async () => {
    const run = await session(workflowLaunch);
    await writeWorkflowAgents(run.runDir);
    const result = await tasks(run.transcript);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "wf-call", kind: "workflow", taskId: "wtask01", toolUseId: "wf-call",
      description: "Draft and check every figure", state: "running",
      workflow: { runId: "wf_abc123", name: "figure-review", phases: ["Draft", "Check"] },
    });
    const agents = result[0]!.workflow!.agents;
    expect(agents.map((agent) => [agent.agentId, agent.description, agent.workflowPhase, agent.state])).toEqual([
      ["a1", "Draft 2.1", "Draft", "completed"],
      ["a2", "Draft 2.2", "Draft", "running"],
      ["a3", "Check 2.1", "Check", "running"],
    ]);
    expect(agents.every((agent) => agent.reportText === undefined)).toBe(true);
  });

  it("takes the phase plan from the run summary and the run state from the parent transcript", async () => {
    const run = await session([...workflowLaunch, notification(60, "wtask01", "completed")]);
    await writeWorkflowAgents(run.runDir);
    await mkdir(join(run.root, "session", "workflows"), { recursive: true });
    await writeFile(join(run.root, "session", "workflows", "wf_abc123.json"), JSON.stringify({
      runId: "wf_abc123", taskId: "wtask01", workflowName: "figure-review-final", status: "completed",
      phases: [{ title: "Draft", model: "opus" }, { title: "Check", model: "sonnet" }, { title: "Revise", model: "opus" }],
    }));
    const [workflow] = await tasks(run.transcript);
    expect(workflow).toMatchObject({
      state: "completed",
      workflow: { name: "figure-review-final", phases: ["Draft", "Check", "Revise"] },
    });
    expect(workflow!.updatedAt).toBeGreaterThanOrEqual(Date.parse(at(60)));
  });

  it("does not treat a stale completed summary as the live state of a resumed run", async () => {
    const run = await session(workflowLaunch);
    await writeWorkflowAgents(run.runDir);
    await mkdir(join(run.root, "session", "workflows"), { recursive: true });
    await writeFile(join(run.root, "session", "workflows", "wf_abc123.json"), JSON.stringify({
      runId: "wf_abc123", status: "completed", phases: [{ title: "Draft" }, { title: "Check" }],
    }));
    expect((await tasks(run.transcript))[0]?.state).toBe("running");
  });

  it("reports a run whose process is gone as stopped", async () => {
    const run = await session(workflowLaunch);
    await writeWorkflowAgents(run.runDir);
    const [workflow] = await tasks(run.transcript, false);
    expect(workflow?.state).toBe("stopped");
    expect(workflow?.workflow?.agents.find((agent) => agent.agentId === "a3")?.state).toBe("stopped");
  });

  it("counts the journal in subagent change detection", async () => {
    const run = await session(workflowLaunch);
    await writeWorkflowAgents(run.runDir);
    const past = new Date(Date.now() - 60_000);
    for (const name of ["agent-a1.jsonl", "agent-a1.meta.json", "agent-a2.jsonl", "agent-a2.meta.json", "journal.jsonl"]) {
      await utimes(join(run.runDir, name), past, past);
    }
    const before = await getClaudeSubagentsMtimeMs(run.transcript);
    await appendFile(join(run.runDir, "journal.jsonl"), jsonl([{ type: "result", key: "v2:b", agentId: "a2", result: {} }]));
    expect(await getClaudeSubagentsMtimeMs(run.transcript)).toBeGreaterThan(before);
  });
});

describe("background shells and agents", () => {
  const shellLaunch: Row[] = [
    { type: "user", timestamp: at(0), message: { role: "user", content: "Start the dev server" } },
    toolUse(1, "bash-call", "Bash", { command: "npm run dev", description: "Start dev server", run_in_background: true }),
    toolResult(2, "bash-call", "Command running in background with ID: bsh01", { stdout: "", stderr: "", backgroundTaskId: "bsh01" }),
    toolUse(3, "fg-call", "Bash", { command: "ls", description: "List files" }),
    toolResult(4, "fg-call", "README.md", { stdout: "README.md", stderr: "" }),
  ];

  it("lists only backgrounded Bash commands, with their description", async () => {
    const run = await session(shellLaunch);
    expect(await tasks(run.transcript)).toEqual([expect.objectContaining({
      id: "bash-call", kind: "bash", taskId: "bsh01", description: "Start dev server", state: "running",
    })]);
  });

  it("ends a shell at its task notification", async () => {
    const run = await session([...shellLaunch, notification(30, "bsh01", "failed")]);
    expect((await tasks(run.transcript))[0]).toMatchObject({ state: "failed", updatedAt: Date.parse(at(30)) });
  });

  it("ends shells and agents delivered as queued notification attachments", async () => {
    const run = await session([
      ...shellLaunch,
      toolUse(20, "agent-call", "Agent", { description: "Audit the parser", prompt: "Audit" }),
      toolResult(21, "agent-call", "Async agent launched successfully. agentId: ag01", {}),
      { type: "attachment", timestamp: at(30), attachment: {
        type: "queued_command", commandMode: "task-notification",
        origin: { kind: "task-notification", producer: "session-task" },
        prompt: "<task-notification>\n<task-id>bsh01</task-id>\n<task-id>ag01</task-id>\n<status>completed</status>\n</task-notification>",
      } },
    ]);
    expect((await tasks(run.transcript)).map(task => [task.kind, task.state])).toEqual([
      ["subagent", "completed"], ["bash", "completed"],
    ]);
  });

  it("ends a shell stopped through TaskStop", async () => {
    const run = await session([
      ...shellLaunch,
      toolUse(10, "stop-call", "TaskStop", { task_id: "bsh01" }),
      toolResult(11, "stop-call", "Stopped", { task_id: "bsh01", message: "Successfully stopped task: bsh01" }),
    ]);
    expect((await tasks(run.transcript))[0]?.state).toBe("stopped");
  });

  it("lists agents outside workflows next to shells, newest first", async () => {
    const run = await session([
      ...shellLaunch,
      toolUse(20, "agent-call", "Agent", { description: "Audit the parser", prompt: "Audit", subagent_type: "plan-reviewer" }),
      toolResult(21, "agent-call", "Async agent launched successfully. agentId: ag01", {}),
    ]);
    expect((await tasks(run.transcript)).map((task) => [task.id, task.kind, task.state])).toEqual([
      ["agent-call", "subagent", "running"],
      ["bash-call", "bash", "running"],
    ]);
  });
});
