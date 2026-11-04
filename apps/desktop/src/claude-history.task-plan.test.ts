import { execFile } from "node:child_process";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseClaudeTranscriptSnapshot, readClaudeSessionHistoryPage } from "./claude-history.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await promisify(execFile)("/usr/bin/trash", [directory]);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-task-plan-"));
  directories.push(directory);
  const path = join(directory, "plan-session.jsonl");
  await writeFile(path, "");
  const records: Array<Record<string, any>> = [];
  async function record(type: "user" | "assistant", content: unknown[], parentUuid = records.at(-1)?.uuid) {
    const value = {
      type, uuid: `message-${records.length}`, parentUuid: parentUuid ?? null,
      timestamp: new Date(1_700_000_000_000 + records.length * 1000).toISOString(),
      message: { role: type, content },
    };
    records.push(value);
    await appendFile(path, JSON.stringify(value) + "\n");
    return value;
  }
  await record("user", [{ type: "text", text: "Carry out this task" }]);
  return {
    directory, path, records, record,
    async plan(input: unknown, parentUuid?: string) {
      return record("assistant", [{ type: "tool_use", id: `tool-${records.length}`, name: "mcp__ccd_turn__update_plan", input }], parentUuid);
    },
    async wrap(input: unknown = { recap: "Finished" }) {
      return record("assistant", [{ type: "tool_use", id: `wrap-${records.length}`, name: "mcp__ccd_turn__wrap_up", input }]);
    },
    async plans() { return (await parseClaudeTranscriptSnapshot(path)).messages.filter(message => message.taskPlan); },
  };
}
const items = () => [
  { content: "Check the package", status: "in_progress" },
  { content: "Restart Bridge", status: "pending" },
  { content: "Verify the result", status: "pending" },
];

describe("Desktop task plan history", () => {
  it("keeps a plan with no assistant text as a standalone stable history item", async () => {
    const f = await fixture();
    await f.plan({ scope: "first_task", items: items() });
    const plans = await f.plans();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ role: "assistant", text: "", taskPlan: { items: items(), updatedAt: 1_700_000_001_000 } });
    expect(plans[0]!.id).toBe((await f.plans())[0]!.id);
  });

  it("advances the same card without changing its placement or creating another item", async () => {
    const f = await fixture();
    await f.plan({ items: items() });
    const original = (await f.plans())[0]!;
    await f.plan({ advance: true });
    const plans = await f.plans();
    expect(plans).toHaveLength(1);
    expect(plans[0]!.id).toBe(original.id);
    expect(plans[0]!.createdAt).toBe(original.createdAt);
    expect(plans[0]!.taskPlan!.items.map(item => item.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(plans[0]!.taskPlan!.updatedAt).toBeGreaterThan(original.taskPlan!.updatedAt);
  });

  it("replaces a continuation list and applies one-based done/start updates", async () => {
    const f = await fixture();
    await f.plan({ items: items() });
    const id = (await f.plans())[0]!.id;
    await f.plan({ scope: "continuation", items: [...items(), { content: "Deliver", status: "pending" }] });
    await f.plan({ done: [1, 2], start: 4 });
    const plans = await f.plans();
    expect(plans).toHaveLength(1);
    expect(plans[0]!.id).toBe(id);
    expect(plans[0]!.taskPlan!.items.map(item => item.status)).toEqual(["completed", "completed", "pending", "in_progress"]);
  });

  it("checks off every item on wrap-up and starts a fresh card for the next task", async () => {
    const f = await fixture();
    await f.plan({ items: items() });
    await f.wrap();
    expect((await f.plans())[0]!.taskPlan!.items.every(item => item.status === "completed")).toBe(true);
    await f.record("user", [{ type: "text", text: "Next task" }]);
    await f.plan({ scope: "continuation", items: [{ content: "New work", status: "in_progress" }] });
    const plans = await f.plans();
    expect(plans).toHaveLength(2);
    expect(plans[0]!.id).not.toBe(plans[1]!.id);
    expect(plans[0]!.taskPlan!.items.every(item => item.status === "completed")).toBe(true);
    expect(plans[1]!.taskPlan!.items[0]!.content).toBe("New work");
  });

  it("preserves surrounding assistant text and interactive wrap-up actions", async () => {
    const f = await fixture();
    await f.record("assistant", [{ type: "text", text: "Starting work" }]);
    await f.plan({ items: items() });
    await f.record("assistant", [{ type: "text", text: "The result is ready" }]);
    await f.wrap({ recap: "Ready", ask: "Install?", actions: [{ label: "Install" }] });
    const snapshot = await parseClaudeTranscriptSnapshot(f.path);
    expect(snapshot.messages.some(message => message.text === "Starting work")).toBe(true);
    expect(snapshot.messages.find(message => message.text === "The result is ready")?.interactivePrompt?.ask).toBe("Install?");
    expect(snapshot.messages.filter(message => message.taskPlan)).toHaveLength(1);
  });

  it("does not merge a distinct new_task into the old plan", async () => {
    const f = await fixture();
    await f.plan({ items: items() });
    await f.plan({ scope: "new_task", items: [{ content: "Separate work", status: "in_progress" }] });
    const plans = await f.plans();
    expect(plans).toHaveLength(2);
    expect(plans[0]!.taskPlan!.items).toEqual(items());
    expect(plans[1]!.taskPlan!.items[0]!.content).toBe("Separate work");
  });

  it("does not double-advance when a physical assistant record is duplicated", async () => {
    const f = await fixture();
    await f.plan({ items: items() });
    const update = await f.plan({ advance: true });
    await appendFile(f.path, JSON.stringify(update) + "\n");
    expect((await f.plans())[0]!.taskPlan!.items.map(item => item.status)).toEqual(["completed", "in_progress", "pending"]);
  });

  it("replays only the selected transcript branch", async () => {
    const f = await fixture();
    const originalUser = f.records[0]!.uuid;
    await f.plan({ items: [{ content: "Abandoned branch", status: "in_progress" }] });
    await f.plan({ items: [{ content: "Selected branch", status: "in_progress" }] }, originalUser);
    const plans = await f.plans();
    expect(plans).toHaveLength(1);
    expect(plans[0]!.taskPlan!.items[0]!.content).toBe("Selected branch");
  });

  it.each([
    { items: [{ content: "Invalid", status: "running" }] },
    { items: [{ content: "Invalid", status: ["pending"] }] },
    { items: [] },
    { items: [{ content: "", status: "pending" }] },
    { items: [null] },
    { items: "not-a-list" },
    { done: [0, -1, 999], start: 999 },
  ])("ignores malformed or out-of-range changes without losing the current list: %j", async input => {
    const f = await fixture();
    await f.plan({ items: items() });
    await f.plan(input);
    expect((await f.plans())[0]!.taskPlan!.items).toEqual(items());
  });

  it("ignores incremental updates without a preceding list", async () => {
    const f = await fixture();
    await f.plan({ advance: true });
    await f.wrap();
    expect(await f.plans()).toEqual([]);
  });

  it("orders multiple plan changes recorded in the same millisecond", async () => {
    const f = await fixture();
    await f.plan({ items: items() });
    const initial = (await f.plans())[0]!.taskPlan!;
    const update = await f.plan({ advance: true });
    update.timestamp = f.records[1]!.timestamp;
    await writeFile(f.path, f.records.map(row => JSON.stringify(row)).join("\n") + "\n");
    const advanced = (await f.plans())[0]!.taskPlan!;
    expect(advanced.updatedAt).toBeGreaterThan(initial.updatedAt);
    const wrap = await f.wrap();
    wrap.timestamp = update.timestamp;
    await writeFile(f.path, f.records.map(row => JSON.stringify(row)).join("\n") + "\n");
    const completed = (await f.plans())[0]!.taskPlan!;
    expect(completed.updatedAt).toBeGreaterThan(advanced.updatedAt);
    expect(completed.items.every(item => item.status === "completed")).toBe(true);
  });

  it("carries plan state through the public history-page API", async () => {
    const f = await fixture();
    await f.plan({ items: items() });
    await f.plan({ advance: true });
    const page = await readClaudeSessionHistoryPage(f.directory, "plan-session");
    expect(page.items.find(item => item.taskPlan)?.taskPlan?.items[1]?.status).toBe("in_progress");
  });
});
