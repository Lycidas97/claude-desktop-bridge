import { describe, expect, it } from "vitest";
import { nativeHistoryItems, nativeItemEventDraft, type NativeMessageProjection } from "./native-history-projection.js";

describe("native session proposal history", () => {
  const name = "mcp__ccd_session__start_session";
  const title = '#457 fork "日历告警"';
  const background = "检查旧版告警\n\n在隔离夹具重放。";
  const proposed = `Proposed "${title}" (task_id: task_d6c18845). The user sees a card and nothing runs until they start it.`;

  it("preserves proposal context and confirmation independently across pages", () => {
    const [call] = nativeHistoryItems("session", [{ type: "assistant", timestamp: 10, message: { content: [{
      type: "tool_use", id: "call", name, input: { title, background, prompt: "Wait for the brief", initiation: "own_initiative" },
    }] } }]);
    const proposalResults: string[] = [];
    const resultItems = nativeHistoryItems("session", [{ type: "user", timestamp: 20, message: { content: [{
      type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: proposed }],
    }] } }], {}, proposalResults);
    expect(call).toMatchObject({ id: "call", createdAt: 10, toolName: name, sessionProposal: { title, background } });
    expect(resultItems).toEqual([]); // Older clients render only items, so no blank row or overwrite.
    expect(proposalResults).toEqual(["call"]);
    expect(nativeItemEventDraft("session", call!, undefined)).toMatchObject({ type: "tool.started", itemId: "call", data: {
      sessionProposal: { title, background },
    } });
  });

  it("uses the brief for a fork without background, preserves redaction and leaves ordinary starts as tools", () => {
    const native = (id: string, input: Record<string, unknown>) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const [fork, start, accept] = nativeHistoryItems("session", [
      native("fork", { title, prompt: "token ghp_" + "f".repeat(32), context: "fork", initiation: "own_initiative" }),
      native("start", { title, background, initiation: "user_asked" }),
      native("accept", { proposal_id: "task_d6c18845" }),
    ]);
    expect(fork?.sessionProposal).toEqual({ title, background: "token [已隐藏令牌]" });
    expect(start).toMatchObject({ role: "tool", toolName: name });
    expect(accept).toMatchObject({ role: "tool", toolName: name });
    expect(start?.sessionProposal).toBeUndefined();
    expect(accept?.sessionProposal).toBeUndefined();
  });

  it.each([
    { content: proposed, is_error: true },
    { content: `Started session "${title}" (session_id: local-test).` },
    { content: `Tool printed: ${proposed}` },
  ])("does not project a confirmation from $content with is_error=$is_error", (result) => {
    const proposalResults: string[] = [];
    nativeHistoryItems("session", [{ type: "user", message: { content: [{
      type: "tool_result", tool_use_id: "call", ...result,
    }] } }], {}, proposalResults);
    expect(proposalResults).toEqual([]);
  });
});

const questions = [
  { question: "选择检查项目", multiSelect: true, options: [{ label: "构建" }, { label: "类型检查" }, { label: "回归测试" }, { label: "构建, 打包" }] },
  { question: "选择执行范围", options: [{ label: "仅本机" }, { label: "所有设备" }] },
];

function ask(id: string, toolUseId: string, questionList = questions) {
  return { type: "assistant", uuid: id, timestamp: 10, message: { content: [
    { type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions: questionList } },
  ] } };
}

function answer(toolUseId: string, checks: string | string[]) {
  return { type: "user", uuid: `result-${toolUseId}`, timestamp: 20,
    toolUseResult: { answers: { "选择检查项目": checks, "选择执行范围": "仅本机" } },
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "User has answered your questions." }] },
  };
}

function expectSelected(items: ReturnType<typeof nativeHistoryItems>, id: string) {
  expect(items.find(item => item.id === id)).toMatchObject({ id, createdAt: 10, interactivePrompt: {
    kind: "question", answered: true,
    questions: [
      { question: "选择检查项目", answer: "类型检查, 回归测试", options: [{ label: "构建" }, { label: "类型检查", selected: true }, { label: "回归测试", selected: true }, { label: "构建, 打包" }] },
      { question: "选择执行范围", answer: "仅本机", options: [{ label: "仅本机", selected: true }, { label: "所有设备" }] },
    ],
  } });
  expect(items.find(item => item.id === id)?.interactivePrompt?.questions?.[0]?.options[0]?.selected).toBeUndefined();
}

describe("native user code examples", () => {
  const text = "    <ci-monitor-event>example</ci-monitor-event>";
  it.each([{ content: text }, { content: [{ type: "text", text }] }, { content: `[来自手机 Bridge]\n\n${text}\n\n<!-- bridge-command:phone-code -->` }])("preserves Markdown indentation from $content before client notice classification", ({ content }) => {
    expect(nativeHistoryItems("session", [{ type: "user", uuid: "code-example", timestamp: 1, message: { content } }]))
      .toMatchObject([{ id: "code-example", role: "user", text }]);
  });
});

describe("native task-plan cards", () => {
  it("projects native task-plan updates and wrap-up onto one stable card", () => {
    const tool = (id: string, name: string, input: unknown) => ({ type: "assistant", uuid: id, timestamp: 1, message: { content: [{ type: "tool_use", id, name, input }] } });
    const items = nativeHistoryItems("native", [
      tool("plan", "mcp__ccd_turn__update_plan", { items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }),
      tool("advance", "mcp__ccd_turn__update_plan", { advance: true }),
      tool("wrap", "mcp__ccd_turn__wrap_up", { recap: "Done" }),
    ]);
    const plans = items.filter(item => item.taskPlan);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe("plan:plan");
    expect(plans[0]?.taskPlan?.items.map(item => item.status)).toEqual(["completed", "completed"]);
  });
});

describe("native question answers", () => {
  it("filters control messages and preserves native question cards", () => {
    const items = nativeHistoryItems("native", [{ type: "user", uuid: "hidden", message: { content: "[Request interrupted by user]" } }, { type: "assistant", uuid: "question", message: { content: [{ type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] } }] } }]);
    expect(items.some(item => item.text.includes("Request interrupted"))).toBe(false);
    expect(items.find(item => item.interactivePrompt)?.interactivePrompt?.kind).toBe("question");
  });

  it.each([{ checks: "类型检查, 回归测试" }, { checks: ["类型检查", "回归测试"] }])("restores every selection from a native history tool result ($checks)", ({ checks }) => {
    expectSelected(nativeHistoryItems("session", [ask("question", "ask-1"), answer("ask-1", checks)]), "question");
  });

  it("reprojects the same question when its answer arrives in a later live event", () => {
    const projection: NativeMessageProjection = {};
    expect(nativeHistoryItems("session", [ask("question", "ask-1")], projection)[0]?.interactivePrompt?.answered).toBeUndefined();
    expectSelected(nativeHistoryItems("session", [answer("ask-1", "类型检查, 回归测试")], projection), "question");
  });

  it.each([
    { checks: "已归档到共享目录, 类型检查", text: "已归档到共享目录, 类型检查", selected: [] },
    { checks: "类型检查, 也检查共享目录", text: "类型检查, 也检查共享目录", selected: [] },
    { checks: ["类型检查", "也检查共享目录"], text: "类型检查, 也检查共享目录", selected: ["类型检查"], freeText: "也检查共享目录" },
    { checks: "构建, 打包", text: "构建, 打包", selected: ["构建, 打包"] },
    { checks: "构建, 打包, 回归测试", text: "构建, 打包, 回归测试", selected: ["回归测试", "构建, 打包"] },
    { checks: ["构建, 打包", "回归测试"], text: "构建, 打包, 回归测试", selected: ["回归测试", "构建, 打包"] },
  ])("preserves the full answer and marks only preset labels ($checks)", ({ checks, text, selected, freeText }) => {
    const request = ask("question", "ask-1");
    const result = answer("ask-1", checks);
    const projection: NativeMessageProjection = {};
    nativeHistoryItems("session", [request], projection);
    const live = nativeHistoryItems("session", [result], projection);
    const history = nativeHistoryItems("session", [request, result]);
    expect(live.find(item => item.id === "question")).toEqual(history.find(item => item.id === "question"));
    const question = history.find(item => item.id === "question")?.interactivePrompt?.questions?.[0];
    expect(question?.answer).toBe(text);
    expect(question?.options.filter(option => option.selected).map(option => option.label)).toEqual(selected);
    expect(question?.freeTextAnswer).toBe(freeText);
  });

  it("restores selections when the submitted labels have surrounding whitespace", () => {
    const request = ask("question", "ask-1", [{
      question: "选择检查项目", multiSelect: true, options: [{ label: "构建 " }, { label: " 打包" }],
    }]);
    const [item] = nativeHistoryItems("session", [request, answer("ask-1", "构建 ,  打包")]);
    expect(item?.interactivePrompt?.questions?.[0]?.options).toEqual([
      { label: "构建", selected: true }, { label: "打包", selected: true },
    ]);
  });

  it.each([
    { checks: "构建, 打包", selected: [] },
    { checks: ["构建", "打包"], selected: ["构建", "打包"] },
    { checks: ["构建, 打包"], selected: ["构建, 打包"] },
  ])("uses option boundaries only when the answer is unambiguous ($checks)", ({ checks, selected }) => {
    const request = ask("question", "ask-1", [{
      question: "选择检查项目", multiSelect: true, options: ["构建", "打包", "构建, 打包"].map(label => ({ label })),
    }]);
    const [item] = nativeHistoryItems("session", [request, answer("ask-1", checks)]);
    const question = item?.interactivePrompt?.questions?.[0];
    expect(question?.answer).toBe("构建, 打包");
    expect(question?.options.filter(option => option.selected).map(option => option.label)).toEqual(selected);
  });

  it.each([
    { checks: "类型检查", selected: ["类型检查"], text: "类型检查" },
    { checks: "(notes only)", selected: [], text: undefined },
  ])("retains native notes when the answer is $checks", ({ checks, selected, text }) => {
    const request = ask("question", "ask-1");
    const result = answer("ask-1", checks);
    const notes = "请检查这些目录, 包括共享目录";
    const annotated = { ...result, toolUseResult: { ...result.toolUseResult, annotations: { "选择检查项目": { notes } } } };
    const projection: NativeMessageProjection = {};
    nativeHistoryItems("session", [request], projection);
    const live = nativeHistoryItems("session", [annotated], projection);
    const history = nativeHistoryItems("session", [request, annotated]);
    expect(live.find(item => item.id === "question")).toEqual(history.find(item => item.id === "question"));
    const question = history.find(item => item.id === "question")?.interactivePrompt?.questions?.[0];
    expect(question?.notes).toBe(notes);
    expect(question?.answer).toBe(text);
    expect(question?.options.filter(option => option.selected).map(option => option.label)).toEqual(selected);
  });

  it("matches the tool ID when two question cards have the same text", () => {
    const items = nativeHistoryItems("session", [ask("first", "ask-1"), ask("second", "ask-2"), answer("ask-1", "类型检查, 回归测试")]);
    expectSelected(items, "first");
    expect(items.find(item => item.id === "second")?.interactivePrompt?.answered).toBeUndefined();
  });
});
