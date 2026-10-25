import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeTranscriptEvidenceCursor,
  findClaudeTranscriptFile,
  isClaudeTranscriptAtTurnBoundary,
  parseClaudeTranscript,
  parseClaudeTranscriptEvidence,
  readClaudeSessionContextEstimate,
  readClaudeSessionHistory,
  readClaudeTranscriptSubagents,
  readClaudeTranscriptUserMessages,
} from "./claude-history.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function line(value: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: "session-1", timestamp: "2026-07-22T10:00:00.000Z", ...value });
}

describe("Claude transcript history", () => {
  it("rebuilds the latest branch and keeps only visible user and assistant text", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-"));
    directories.push(root);
    const projects = join(root, "projects");
    const project = join(projects, "-work-ega-pms");
    const transcript = join(project, "session-1.jsonl");
    await mkdir(project, { recursive: true });
    await writeFile(transcript, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "先检查当前实现" } }),
      line({ type: "assistant", uuid: "abandoned", parentUuid: "user-1", message: { role: "assistant", content: [{ type: "text", text: "旧分支" }] } }),
      line({ type: "assistant", uuid: "thinking-1", parentUuid: "user-1", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } }),
      line({ type: "assistant", uuid: "assistant-1", parentUuid: "thinking-1", message: { role: "assistant", content: [{ type: "text", text: "我先读取项目。" }] } }),
      line({ type: "assistant", uuid: "tool-1", parentUuid: "assistant-1", message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } }),
      line({ type: "user", uuid: "result-1", parentUuid: "tool-1", toolUseResult: { ok: true }, message: { role: "user", content: [{ type: "tool_result", content: "secret tool output" }] } }),
      line({ type: "assistant", uuid: "assistant-2", parentUuid: "result-1", message: { role: "assistant", content: [{ type: "text", text: "已经定位问题。" }] } }),
      line({ type: "user", uuid: "user-2", parentUuid: "assistant-2", message: { role: "user", content: "[来自手机 Bridge]\n\n继续修复\n\n<!-- bridge-command:phone-1 -->" } }),
      line({ type: "assistant", uuid: "assistant-3", parentUuid: "user-2", message: { role: "assistant", content: [{ type: "text", text: "修复完成。" }] } }),
    ].join("\n"), "utf8");

    expect(await findClaudeTranscriptFile(projects, "session-1", "/work/ega-pms")).toBe(transcript);
    expect(await parseClaudeTranscript(transcript)).toEqual({
      available: true,
      truncated: false,
      messages: [
        expect.objectContaining({ id: "user-1", role: "user", text: "先检查当前实现" }),
        expect.objectContaining({ id: "assistant-1", role: "assistant", text: "我先读取项目。\n\n已经定位问题。" }),
        expect.objectContaining({ id: "user-2", role: "user", text: "继续修复" }),
        expect.objectContaining({ id: "assistant-3", role: "assistant", text: "修复完成。" }),
      ],
    });
  });

  it("reports a missing local transcript without exposing another file", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-missing-"));
    directories.push(root);
    expect(await readClaudeSessionHistory(join(root, "projects"), "../settings", "/work/demo")).toEqual({
      available: false,
      messages: [],
      truncated: false,
    });
  });

  it("finds user writes on a non-terminal branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-branches-"));
    directories.push(root);
    const transcript = join(root, "branches.jsonl");
    await writeFile(transcript, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "Start" } }),
      line({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        message: { role: "assistant", content: "Working" },
      }),
      line({
        type: "user",
        uuid: "resume-meta",
        parentUuid: "assistant-1",
        isMeta: true,
        message: { role: "user", content: "Continue from where you left off." },
      }),
      line({
        type: "user",
        uuid: "desktop-user",
        parentUuid: "assistant-1",
        message: { role: "user", content: "Desktop input" },
      }),
      line({
        type: "assistant",
        uuid: "bridge-assistant",
        parentUuid: "assistant-1",
        message: { role: "assistant", content: "Bridge continued" },
      }),
    ].join("\n"), "utf8");

    await expect(parseClaudeTranscript(transcript)).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ id: "user-1" }),
        expect.objectContaining({ id: "assistant-1", text: "Working\n\nBridge continued" }),
      ],
    });
    expect((await parseClaudeTranscript(transcript)).messages.some((message) => (
      message.id === "desktop-user"
    ))).toBe(false);
    await expect(readClaudeTranscriptUserMessages(transcript)).resolves.toEqual([
      expect.objectContaining({ id: "user-1", text: "Start" }),
      expect.objectContaining({ id: "desktop-user", text: "Desktop input" }),
    ]);
  });

  it("hides Claude resume sentinels while preserving the surrounding conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-controls-"));
    directories.push(root);
    const transcript = join(root, "controls.jsonl");
    await writeFile(transcript, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "继续推进 P2" } }),
      line({
        type: "user",
        uuid: "interrupted-1",
        parentUuid: "user-1",
        message: { role: "user", content: "[Request interrupted by user]" },
      }),
      line({
        type: "assistant",
        uuid: "synthetic-1",
        parentUuid: "interrupted-1",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
          stop_reason: "stop_sequence",
        },
      }),
      line({
        type: "user",
        uuid: "user-2",
        parentUuid: "synthetic-1",
        message: { role: "user", content: "重新继续 P2" },
      }),
    ].join("\n"), "utf8");

    await expect(parseClaudeTranscript(transcript)).resolves.toMatchObject({
      available: true,
      messages: [
        { id: "user-1", role: "user", text: "继续推进 P2" },
        { id: "user-2", role: "user", text: "重新继续 P2" },
      ],
    });
  });

  it("hides Claude's internal compaction summary from the visible conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-compaction-"));
    directories.push(root);
    const transcript = join(root, "compaction.jsonl");
    await writeFile(transcript, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "先开始工作" } }),
      line({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        message: { role: "assistant", content: "已经完成前置检查。" },
      }),
      line({
        type: "user",
        uuid: "compact-summary",
        parentUuid: "assistant-1",
        isCompactSummary: true,
        message: {
          role: "user",
          content: "This session is being continued from a previous conversation that ran out of context.",
        },
      }),
      line({
        type: "assistant",
        uuid: "assistant-2",
        parentUuid: "compact-summary",
        message: { role: "assistant", content: "继续处理后续工作。" },
      }),
      line({
        type: "user",
        uuid: "user-2",
        parentUuid: "assistant-2",
        message: { role: "user", content: "继续完成剩余内容" },
      }),
    ].join("\n"), "utf8");

    const result = await parseClaudeTranscript(transcript);
    expect(result.messages).toEqual([
      expect.objectContaining({ id: "user-1", role: "user", text: "先开始工作" }),
      expect.objectContaining({
        id: "assistant-1",
        role: "assistant",
        text: "已经完成前置检查。\n\n继续处理后续工作。",
      }),
      expect.objectContaining({ id: "user-2", role: "user", text: "继续完成剩余内容" }),
    ]);
    await expect(readClaudeTranscriptUserMessages(transcript)).resolves.toEqual([
      expect.objectContaining({ id: "user-1", text: "先开始工作" }),
      expect.objectContaining({ id: "user-2", text: "继续完成剩余内容" }),
    ]);
  });

  it("bridges across compact_boundary and re-emitted preservedSegment nodes without losing earlier history", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-compact-boundary-"));
    directories.push(root);
    const transcript = join(root, "compact-boundary.jsonl");
    await writeFile(transcript, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "第一轮需求" } }),
      line({ type: "assistant", uuid: "assistant-1", parentUuid: "user-1", message: { role: "assistant", content: "第一轮回复" } }),
      line({ type: "user", uuid: "user-2", parentUuid: "assistant-1", message: { role: "user", content: "第二轮需求" } }),
      line({ type: "assistant", uuid: "assistant-2", parentUuid: "user-2", message: { role: "assistant", content: "第二轮回复" } }),
      line({
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary-1",
        parentUuid: null,
        logicalParentUuid: "ephemeral-attachment-id",
        compactMetadata: {
          trigger: "auto",
          preservedSegment: {
            headUuid: "user-2",
            anchorUuid: "compact-summary-1",
            tailUuid: "assistant-2",
          },
        },
      }),
      line({
        type: "user",
        uuid: "compact-summary-1",
        parentUuid: "boundary-1",
        isCompactSummary: true,
        message: { role: "user", content: "This session is being continued from a previous conversation." },
      }),
      // Re-emitted preserved segment on resume with headUuid.parentUuid rewritten to anchorUuid
      line({ type: "user", uuid: "user-2", parentUuid: "compact-summary-1", message: { role: "user", content: "第二轮需求" } }),
      line({ type: "assistant", uuid: "assistant-2", parentUuid: "user-2", message: { role: "assistant", content: "第二轮回复" } }),
      line({ type: "user", uuid: "user-3", parentUuid: "assistant-2", message: { role: "user", content: "压缩后的第三轮需求" } }),
      line({ type: "assistant", uuid: "assistant-3", parentUuid: "user-3", message: { role: "assistant", content: "第三轮回复" } }),
    ].join("\n"), "utf8");

    const result = await parseClaudeTranscript(transcript);
    expect(result.messages).toEqual([
      expect.objectContaining({ id: "user-1", role: "user", text: "第一轮需求" }),
      expect.objectContaining({ id: "assistant-1", role: "assistant", text: "第一轮回复" }),
      expect.objectContaining({ id: "user-2", role: "user", text: "第二轮需求" }),
      expect.objectContaining({ id: "assistant-2", role: "assistant", text: "第二轮回复" }),
      expect.objectContaining({ id: "user-3", role: "user", text: "压缩后的第三轮需求" }),
      expect.objectContaining({ id: "assistant-3", role: "assistant", text: "第三轮回复" }),
    ]);
  });

  it("hides a synthetic SDK failure while preserving normal assistant text", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-sdk-error-"));
    directories.push(root);
    const transcript = join(root, "sdk-error.jsonl");
    await writeFile(transcript, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "继续" } }),
      line({
        type: "assistant",
        uuid: "synthetic-error",
        parentUuid: "user-1",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "Prompt is too long" }],
          stop_reason: "model_context_window_exceeded",
        },
      }),
      line({
        type: "user",
        uuid: "user-2",
        parentUuid: "synthetic-error",
        message: { role: "user", content: "新会话继续" },
      }),
      line({
        type: "assistant",
        uuid: "assistant-2",
        parentUuid: "user-2",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "正常回复" }],
          stop_reason: "end_turn",
        },
      }),
    ].join("\n"), "utf8");

    await expect(parseClaudeTranscript(transcript)).resolves.toMatchObject({
      messages: [
        { id: "user-1", role: "user", text: "继续" },
        { id: "user-2", role: "user", text: "新会话继续" },
        { id: "assistant-2", role: "assistant", text: "正常回复" },
      ],
    });
  });

  it("only marks a completed assistant branch as a safe ownership boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-boundary-"));
    directories.push(root);
    const completed = join(root, "completed.jsonl");
    const waiting = join(root, "waiting.jsonl");
    const interrupted = join(root, "interrupted.jsonl");
    const toolInterrupted = join(root, "tool-interrupted.jsonl");
    await writeFile(completed, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "Run" } }),
      line({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        message: { role: "assistant", content: "Done", stop_reason: "end_turn" },
      }),
      line({ type: "attachment", uuid: "attachment-1", parentUuid: "assistant-1", attachment: { type: "summary" } }),
    ].join("\n"), "utf8");
    await writeFile(waiting, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "Run" } }),
      line({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Write" }], stop_reason: "tool_use" },
      }),
    ].join("\n"), "utf8");
    await writeFile(interrupted, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "Run" } }),
      line({
        type: "user",
        uuid: "interrupted-1",
        parentUuid: "user-1",
        message: { role: "user", content: "[Request interrupted by user]" },
      }),
    ].join("\n"), "utf8");
    await writeFile(toolInterrupted, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "Run" } }),
      line({
        type: "user",
        uuid: "interrupted-1",
        parentUuid: "user-1",
        message: { role: "user", content: "[Request interrupted by user for tool use]" },
      }),
    ].join("\n"), "utf8");

    await expect(isClaudeTranscriptAtTurnBoundary(completed)).resolves.toBe(true);
    await expect(isClaudeTranscriptAtTurnBoundary(waiting)).resolves.toBe(false);
    await expect(isClaudeTranscriptAtTurnBoundary(interrupted)).resolves.toBe(true);
    await expect(isClaudeTranscriptAtTurnBoundary(toolInterrupted)).resolves.toBe(true);
  });

  it("caps large histories below the encrypted relay frame budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-large-"));
    directories.push(root);
    const transcript = join(root, "large.jsonl");
    await writeFile(transcript, [
      line({ type: "user", uuid: "user-large", parentUuid: null, message: { role: "user", content: "检查长回复" } }),
      line({ type: "assistant", uuid: "assistant-large", parentUuid: "user-large", message: { role: "assistant", content: [{ type: "text", text: "长".repeat(20_000) }] } }),
    ].join("\n"), "utf8");

    const result = await parseClaudeTranscript(transcript);
    expect(result.available).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(60 * 1024);
    expect(result.messages.at(-1)?.text).toContain("已省略中间部分");
  });

  it("pages backward by the visible message cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-pages-"));
    directories.push(root);
    const transcript = join(root, "pages.jsonl");
    const rows: string[] = [];
    let parentUuid: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const uuid = `message-${index}`;
      const role = index % 2 === 0 ? "user" : "assistant";
      rows.push(line({
        type: role,
        uuid,
        parentUuid,
        timestamp: new Date(Date.UTC(2026, 6, 22, 10, 0, index)).toISOString(),
        message: { role, content: `Message ${index}` },
      }));
      parentUuid = uuid;
    }
    await writeFile(transcript, rows.join("\n"), "utf8");

    const newest = await parseClaudeTranscript(transcript, { limit: 4 });
    expect(newest.messages.map((message) => message.id))
      .toEqual(["message-4", "message-5", "message-6", "message-7"]);
    const older = await parseClaudeTranscript(transcript, {
      limit: 4,
      before: {
        createdAt: newest.messages[0]!.createdAt,
        id: newest.messages[0]!.id,
      },
    });
    expect(older.messages.map((message) => message.id))
      .toEqual(["message-0", "message-1", "message-2", "message-3"]);
  });

  it("reads the latest context usage without loading message bodies into memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-context-"));
    directories.push(root);
    const projects = join(root, "projects");
    const project = join(projects, "-work-demo");
    const transcript = join(project, "session-1.jsonl");
    await mkdir(project, { recursive: true });
    await writeFile(transcript, [
      line({
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          model: "wire-model",
          content: "first",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 270_000,
            cache_creation_input_tokens: 1_000,
          },
        },
      }),
      line({
        type: "assistant",
        uuid: "assistant-2",
        message: {
          role: "assistant",
          model: "wire-model",
          content: "after compact",
          usage: {
            input_tokens: 500,
            cache_read_input_tokens: 80_000,
            cache_creation_input_tokens: 500,
          },
        },
      }),
    ].join("\n"), "utf8");

    await expect(readClaudeSessionContextEstimate(projects, "session-1", "/work/demo")).resolves.toEqual({
      totalTokens: 81_000,
      model: "wire-model",
    });
  });

  it("recovers completed tool evidence without exposing thinking or duplicating tool results", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-evidence-"));
    directories.push(root);
    const transcript = join(root, "evidence.jsonl");
    await writeFile(transcript, [
      line({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        message: { role: "user", content: "Build the report" },
      }),
      line({
        type: "assistant",
        uuid: "assistant-tool",
        parentUuid: "user-1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden chain of thought" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "node ./scripts/build.js > ./dist/report.html" },
            },
          ],
          stop_reason: "tool_use",
        },
      }),
      line({
        type: "user",
        uuid: "result-1",
        parentUuid: "assistant-tool",
        toolUseResult: { exitCode: 0, stdout: "done" },
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: { exitCode: 0, stdout: "done" },
          }],
        },
      }),
      line({
        type: "assistant",
        uuid: "assistant-end",
        parentUuid: "result-1",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "still hidden" }],
          stop_reason: "end_turn",
        },
      }),
    ].join("\n"), "utf8");

    const evidence = await parseClaudeTranscriptEvidence(transcript);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      id: "user-1",
      tools: [{
        id: "tool-1",
        toolName: "Bash",
        output: {
          bodyOmitted: true,
          byteLength: 30,
          lineCount: 1,
          truncated: false,
          exitCode: 0,
        },
      }],
    });
    expect(evidence[0]?.paths).toEqual(expect.arrayContaining([
      "./scripts/build.js",
      "./dist/report.html",
    ]));
    expect(JSON.stringify(evidence)).not.toContain("hidden chain of thought");
  });

  it("incrementally survives duplicate scans, half-written records, truncation and rotation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-evidence-cursor-"));
    directories.push(root);
    const transcript = join(root, "cursor.jsonl");
    const cursor = new ClaudeTranscriptEvidenceCursor();
    const user = line({
      type: "user",
      uuid: "user-1",
      parentUuid: null,
      message: { role: "user", content: "Read" },
    });
    const tool = line({
      type: "assistant",
      uuid: "assistant-tool",
      parentUuid: "user-1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.txt" } }],
        stop_reason: "tool_use",
      },
    });
    const result = line({
      type: "user",
      uuid: "result-1",
      parentUuid: "assistant-tool",
      toolUseResult: "ok",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
    });
    await writeFile(transcript, `${user}\n${tool}\n${result.slice(0, 30)}`, "utf8");
    await expect(cursor.read(transcript)).resolves.toEqual([]);
    await appendFile(transcript, `${result.slice(30)}\n`, "utf8");
    const completed = await cursor.read(transcript);
    expect(completed).toHaveLength(1);
    await expect(cursor.read(transcript)).resolves.toEqual(completed);

    const replacement = [
      line({
        type: "user",
        uuid: "user-2",
        parentUuid: null,
        message: { role: "user", content: "Write" },
      }),
      line({
        type: "assistant",
        uuid: "tool-2-node",
        parentUuid: "user-2",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-2", name: "Write", input: { file_path: "b.txt" } }],
          stop_reason: "tool_use",
        },
      }),
      line({
        type: "user",
        uuid: "result-2",
        parentUuid: "tool-2-node",
        tool_use_result: "ok",
        message: { role: "user", content: [] },
      }),
    ].join("\n");
    await writeFile(transcript, replacement, "utf8");
    expect((await cursor.read(transcript))[0]?.id).toBe("user-2");

    await rename(transcript, `${transcript}.old`);
    await writeFile(transcript, replacement.replaceAll("user-2", "user-3"), "utf8");
    expect((await cursor.read(transcript))[0]?.id).toBe("user-3");
  });

  it("parses running and completed subagent progress and reports from subagents directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-subagents-"));
    directories.push(root);
    const transcript = join(root, "session-sub.jsonl");
    const subagentsDir = join(root, "session-sub", "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(transcript, line({
      type: "user",
      uuid: "user-1",
      parentUuid: null,
      message: { role: "user", content: "Run subagents" },
    }), "utf8");

    await writeFile(join(subagentsDir, "agent-a111.meta.json"), JSON.stringify({
      agentType: "Explore",
      description: "Scan repository layout",
      toolUseId: "toolu_sub_1",
      finished: false,
    }), "utf8");
    await writeFile(join(subagentsDir, "agent-a111.jsonl"), [
      line({
        type: "user",
        uuid: "sub1-u1",
        timestamp: "2026-07-22T10:00:01.000Z",
        message: { role: "user", content: "Find key files" },
      }),
      line({
        type: "assistant",
        uuid: "sub1-a1",
        timestamp: "2026-07-22T10:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Checking desktop broker and history parser..." },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "apps/desktop/src/claude-history.ts" } },
          ],
        },
      }),
    ].join("\n"), "utf8");

    await writeFile(join(subagentsDir, "agent-a222.meta.json"), JSON.stringify({
      agentType: "general-purpose",
      description: "Verify citation claims",
      toolUseId: "toolu_sub_2",
      finished: true,
    }), "utf8");
    await writeFile(join(subagentsDir, "agent-a222.jsonl"), [
      line({
        type: "user",
        uuid: "sub2-u1",
        timestamp: "2026-07-22T10:00:02.000Z",
        message: { role: "user", content: "Verify claims" },
      }),
      line({
        type: "assistant",
        uuid: "sub2-a1",
        timestamp: "2026-07-22T10:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "pytest tests/" } },
            { type: "tool_use", id: "t3", name: "SubagentHandback", input: { message: "## Verification Summary\nAll 12 claims verified." } },
          ],
        },
      }),
    ].join("\n"), "utf8");

    const subagents = await readClaudeTranscriptSubagents(transcript, true);
    expect(subagents).toHaveLength(2);
    expect(subagents[0]).toMatchObject({
      agentId: "a111",
      toolUseId: "toolu_sub_1",
      agentType: "Explore",
      description: "Scan repository layout",
      state: "running",
      toolCount: 1,
      recentTools: ["Read claude-history.ts"],
      latestText: "Checking desktop broker and history parser...",
    });
    expect(subagents[1]).toMatchObject({
      agentId: "a222",
      toolUseId: "toolu_sub_2",
      agentType: "general-purpose",
      description: "Verify citation claims",
      state: "completed",
      toolCount: 1,
      recentTools: ["Bash pytest"],
      reportText: "## Verification Summary\nAll 12 claims verified.",
    });
  });

  it("extracts interactive wrap-up and question cards and tracks selected user answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-interactive-"));
    directories.push(root);
    const transcript = join(root, "interactive.jsonl");
    await writeFile(transcript, [
      line({
        type: "user",
        uuid: "u-1",
        parentUuid: null,
        message: { role: "user", content: "审查第五章方案" },
      }),
      line({
        type: "assistant",
        uuid: "a-wrap-1",
        parentUuid: "u-1",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_wrap_1",
            name: "mcp__ccd_turn__wrap_up",
            input: {
              recap: "已完成第五章草案核查，尚未改动文件。",
              ask: "是否按草案冻结判读规则？",
              actions: [
                { label: "按草案冻结", message: "确认按草案冻结判读规则并继续。" },
                { label: "先改规则", message: "我想先调整几条规则。" },
              ],
            },
          }],
        },
      }),
      line({
        type: "user",
        uuid: "u-wrap-res-1",
        parentUuid: "a-wrap-1",
        toolUseResult: [{ type: "text", text: "Shown in the next-step box." }],
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_wrap_1", content: "Shown in the next-step box." }],
        },
      }),
      line({
        type: "assistant",
        uuid: "a-closing-1",
        parentUuid: "u-wrap-res-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "以上是第五章核查结论。" }],
          stop_reason: "end_turn",
        },
      }),
      line({
        type: "user",
        uuid: "u-2",
        parentUuid: "a-closing-1",
        message: { role: "user", content: "确认按草案冻结判读规则并继续。" },
      }),
      line({
        type: "assistant",
        uuid: "a-wrap-2",
        parentUuid: "u-2",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_wrap_2",
            name: "mcp__ccd_turn__wrap_up",
            input: {
              blocked: true,
              recap: "规则已冻结，准备写入正式稿。",
              ask: "是否立即写入正式稿并编译？",
              actions: [
                { label: "确认写入并编译", message: "请写入正式稿并运行编译检查。" },
              ],
            },
          }],
        },
      }),
      line({
        type: "assistant",
        uuid: "a-closing-2",
        parentUuid: "a-wrap-2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "对照表已就绪，请确认。" }],
          stop_reason: "end_turn",
        },
      }),
    ].join("\n"), "utf8");

    const parsed = await parseClaudeTranscript(transcript);
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[1]).toMatchObject({
      id: "a-closing-1",
      role: "assistant",
      text: "以上是第五章核查结论。",
      interactivePrompt: {
        kind: "wrap-up",
        recap: "已完成第五章草案核查，尚未改动文件。",
        ask: "是否按草案冻结判读规则？",
        answered: true,
        actions: [
          { label: "按草案冻结", message: "确认按草案冻结判读规则并继续。", recommended: true, selected: true },
          { label: "先改规则", message: "我想先调整几条规则。" },
        ],
      },
    });
    expect(parsed.messages[3]).toMatchObject({
      id: "a-closing-2",
      role: "assistant",
      text: "对照表已就绪，请确认。",
      interactivePrompt: {
        kind: "wrap-up",
        recap: "规则已冻结，准备写入正式稿。",
        ask: "是否立即写入正式稿并编译？",
        blocked: true,
        actions: [
          { label: "确认写入并编译", message: "请写入正式稿并运行编译检查。", recommended: true },
        ],
      },
    });
    expect(parsed.messages[3]?.interactivePrompt?.answered).toBeUndefined();
  });

  it("recognizes turn boundary on forked sessions after local /model, /compact, and attachment records", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-fork-boundary-"));
    directories.push(root);
    const transcript = join(root, "forked.jsonl");
    await writeFile(transcript, [
      line({
        type: "user",
        uuid: "u-1",
        parentUuid: null,
        message: { role: "user", content: "整理第四章叙事骨架" },
      }),
      line({
        type: "assistant",
        uuid: "a-1",
        parentUuid: "u-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "第四章叙事骨架已完成。" }],
          stop_reason: "end_turn",
        },
      }),
      line({
        type: "user",
        uuid: "u-cmd-caveat",
        parentUuid: "a-1",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>Command run locally</local-command-caveat>" },
      }),
      line({
        type: "user",
        uuid: "u-cmd-model",
        parentUuid: "u-cmd-caveat",
        message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>" },
      }),
      line({
        type: "user",
        uuid: "u-cmd-stdout",
        parentUuid: "u-cmd-model",
        message: { role: "user", content: "<local-command-stdout>Set model to `mythos-magpie`</local-command-stdout>" },
      }),
      line({
        type: "system",
        subtype: "compact_boundary",
        uuid: "sys-compact",
        parentUuid: null,
        logicalParentUuid: "u-cmd-stdout",
        content: "Conversation compacted",
      }),
      line({
        type: "user",
        uuid: "u-compact-summary",
        parentUuid: "sys-compact",
        isCompactSummary: true,
        message: { role: "user", content: "This session is being continued from a previous conversation..." },
      }),
      line({
        type: "user",
        uuid: "u-compact-cmd",
        parentUuid: "u-cmd-stdout",
        message: { role: "user", content: "<command-name>/compact</command-name>" },
      }),
      line({
        type: "user",
        uuid: "u-compact-out",
        parentUuid: "u-compact-cmd",
        message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" },
      }),
      line({
        type: "attachment",
        uuid: "att-fork-hook",
        parentUuid: "u-compact-out",
        attachment: {
          type: "hook_additional_context",
          content: ["## You are a session started from another session"],
        },
      }),
    ].join("\n"), "utf8");

    await expect(isClaudeTranscriptAtTurnBoundary(transcript)).resolves.toBe(true);
    const parsed = await parseClaudeTranscript(transcript);
    expect(parsed.messages.map((m) => m.id)).toEqual(["u-1", "a-1"]);
  });
});
