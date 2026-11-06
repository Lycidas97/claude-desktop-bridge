import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeTranscriptSubagents } from "./claude-history.js";

const roots: string[] = [];
type Row = Record<string, unknown>;

function call(name = "StructuredOutput", id = "output"): Row {
  return { type: "assistant", timestamp: new Date(2_000).toISOString(), message: {
    role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name, id, input: { verdict: "ok" } }],
  } };
}

function result(id = "output", extra: Row = {}): Row {
  return { type: "user", timestamp: new Date(3_000).toISOString(), message: {
    role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Structured output provided successfully", ...extra }],
  } };
}

function jsonl(rows: Row[]): string {
  return rows.map(row => JSON.stringify(row)).join("\n") + "\n";
}

async function fixture(rows: Row[], options: { nested?: boolean; metadata?: Row; parent?: Row[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "bridge-subagent-completion-"));
  roots.push(root);
  const transcript = join(root, "session.jsonl");
  await writeFile(transcript, jsonl(options.parent ?? [{ type: "user", message: { role: "user", content: "Run workflow" } }]));
  const dir = options.nested ? join(root, "session/subagents/workflows/wf-test") : join(root, "session/subagents");
  await mkdir(dir, { recursive: true });
  const child = join(dir, "agent-child.jsonl");
  const meta = join(dir, "agent-child.meta.json");
  await writeFile(child, jsonl([{ type: "user", timestamp: new Date(1_000).toISOString(), message: { role: "user", content: "Review" } }, ...rows]));
  await writeFile(meta, JSON.stringify({ description: "Review", agentType: "revision-factchecker", ...options.metadata }));
  return { transcript, child, meta };
}

async function state(transcript: string, liveSince: number | undefined = 0) {
  return (await readClaudeTranscriptSubagents(transcript, liveSince)).find(agent => agent.agentId === "child")?.state;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("structured-output subagent completion boundaries", () => {
  it.each([undefined, false, true])("requires an accepted matching result (is_error=%s)", async isError => {
    const run = await fixture([call(), result("output", isError === undefined ? {} : { is_error: isError })]);
    expect(await state(run.transcript)).toBe(isError === true ? "running" : "completed");
  });

  it.each([
    { name: "no tool result", rows: [call()] },
    { name: "a different tool ID", rows: [call(), result("different")] },
    { name: "no tool invocation", rows: [result()] },
    { name: "an ordinary tool with the same success text", rows: [call("Read"), result()] },
    { name: "a rejected result with success-looking text", rows: [call(), result("output", { is_error: true })] },
    { name: "a quoted result in plain user text", rows: [call(), { type: "user", message: { role: "user", content: "Structured output provided successfully" } }] },
    { name: "a result before the invocation", rows: [result(), call()] },
    { name: "a successful result followed by schema rejection", rows: [call(), result(), result("output", { is_error: true })] },
  ])("keeps running for $name", async ({ rows }) => {
    const run = await fixture(rows);
    expect(await state(run.transcript)).toBe("running");
  });

  it("accepts a result with content blocks", async () => {
    const run = await fixture([call(), result("output", { content: [{ type: "text", text: "Structured output provided successfully" }] })]);
    expect(await state(run.transcript)).toBe("completed");
  });

  it("recognizes a nested workflow agent without a parent Agent tool or finished metadata", async () => {
    const run = await fixture([call(), result()], { nested: true });
    expect(await readClaudeTranscriptSubagents(run.transcript, 0)).toMatchObject([
      { agentId: "child", description: "Review", state: "completed", toolCount: 1, recentTools: ["StructuredOutput"] },
    ]);
  });

  it.each(["attachment", "system", "api-request", "api-request-blob"])("keeps completion through trailing %s records", async type => {
    const run = await fixture([call(), result(), { type, timestamp: new Date(4_000).toISOString(), attachment: { type: "queued_command" } }]);
    expect(await state(run.transcript)).toBe("completed");
  });

  it.each([
    { name: "new tool work", row: call("Read", "next-read") },
    { name: "new user instructions", row: { type: "user", message: { role: "user", content: "Review the next chapter" } } },
  ])("becomes running again after $name", async ({ row }) => {
    const run = await fixture([call(), result()]);
    expect(await state(run.transcript)).toBe("completed");
    await appendFile(run.child, jsonl([row]));
    expect(await state(run.transcript)).toBe("running");
  });

  it("does not confuse a delayed sibling tool result with new work", async () => {
    const launch = call();
    (launch.message as { content: Row[] }).content.push({ type: "tool_use", name: "Read", id: "sibling-read", input: {} });
    const run = await fixture([launch, result(), result("sibling-read", { content: "File contents" })]);
    expect(await state(run.transcript)).toBe("completed");
  });

  it.each([false, true])("accepts mixed tool results in either order (outputFirst=%s)", async outputFirst => {
    const output = (result().message as { content: Row[] }).content[0]!;
    const sibling = { type: "tool_result", tool_use_id: "read", content: "File contents" };
    const run = await fixture([call(), { type: "user", message: { role: "user", content: outputFirst ? [output, sibling] : [sibling, output] } }]);
    expect(await state(run.transcript)).toBe("completed");
  });

  it("clears completion for a new user message in content-block format", async () => {
    const run = await fixture([call(), result(), { type: "user", message: {
      role: "user", content: [{ type: "text", text: "Review the next chapter" }],
    } }]);
    expect(await state(run.transcript)).toBe("running");
  });

  it("requires a new result when a completed agent submits output again", async () => {
    const run = await fixture([call(), result()]);
    expect(await state(run.transcript)).toBe("completed");
    await appendFile(run.child, jsonl([call("StructuredOutput", "second-output")]));
    expect(await state(run.transcript)).toBe("running");
    await appendFile(run.child, jsonl([result("second-output")]));
    expect(await state(run.transcript)).toBe("completed");
  });

  it("supports rejection followed by a corrected output", async () => {
    const run = await fixture([call(), result("output", { is_error: true })]);
    expect(await state(run.transcript)).toBe("running");
    await appendFile(run.child, jsonl([call("StructuredOutput", "retry-output"), result("retry-output")]));
    expect(await state(run.transcript)).toBe("completed");
  });

  it("waits for a partially written result and rereads it after the append completes", async () => {
    const run = await fixture([call()]);
    const row = JSON.stringify(result());
    await appendFile(run.child, row.slice(0, -12));
    expect(await state(run.transcript)).toBe("running");
    await appendFile(run.child, row.slice(-12));
    expect(await state(run.transcript)).toBe("completed");
  });

  it("rereads an atomically replaced child transcript", async () => {
    const run = await fixture([call()]);
    expect(await state(run.transcript)).toBe("running");
    await writeFile(run.child + ".tmp", jsonl([call(), result()]));
    await rename(run.child + ".tmp", run.child);
    expect(await state(run.transcript)).toBe("completed");
  });

  it("keeps accepted completion when the process exits, but stops an unfinished child", async () => {
    const done = await fixture([call(), result()]);
    const pending = await fixture([call()]);
    expect((await readClaudeTranscriptSubagents(done.transcript))[0]?.state).toBe("completed");
    expect((await readClaudeTranscriptSubagents(pending.transcript))[0]?.state).toBe("stopped");
    expect(await state(pending.transcript, 0)).toBe("running");
    expect(await state(pending.transcript, 5_000)).toBe("stopped");
  });

  it("retains completed status across compaction", async () => {
    const run = await fixture([call(), result()]);
    await appendFile(run.transcript, jsonl([{ type: "system", subtype: "compact_boundary", timestamp: new Date(10_000).toISOString() }]));
    expect(await state(run.transcript)).toBe("completed");
  });

  it("updates an existing card instead of creating a second child beside the parent call", async () => {
    const run = await fixture([call(), result()], {
      metadata: { toolUseId: "launch-tool" },
      parent: [
        { type: "assistant", timestamp: new Date(500).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "launch-tool", name: "Agent", input: { description: "Review" } }] } },
        { type: "user", timestamp: new Date(501).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "launch-tool", content: "Async agent launched successfully.\nagentId: child" }] } },
      ],
    });
    const summaries = await readClaudeTranscriptSubagents(run.transcript, 0);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ toolUseId: "launch-tool", agentId: "child", state: "completed" });
  });

  it("retains the latest readable report after completion", async () => {
    const run = await fixture([
      { type: "assistant", timestamp: new Date(1_500).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "核查完成：两处引用需要修正。" }] } },
      call(), result(),
    ]);
    expect((await readClaudeTranscriptSubagents(run.transcript, 0))[0]).toMatchObject({ state: "completed", reportText: "核查完成：两处引用需要修正。" });
  });

  it("isolates output IDs across agents", async () => {
    const run = await fixture([call(), result()], { nested: true });
    await writeFile(join(run.child, "..", "agent-other.jsonl"), jsonl([call("Read"), result()]));
    expect((await readClaudeTranscriptSubagents(run.transcript, 0)).map(agent => [agent.agentId, agent.state])).toEqual([
      ["child", "completed"], ["other", "running"],
    ]);
  });
});
