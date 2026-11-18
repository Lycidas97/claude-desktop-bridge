import { describe, expect, it } from "vitest";
import { nativeHistoryItems, type NativeMessageProjection } from "./native-history-projection.js";

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

describe("native question answers", () => {
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
    { checks: "构建, 打包", text: "构建, 打包", selected: ["构建, 打包"] },
    { checks: "构建, 打包, 回归测试", text: "构建, 打包, 回归测试", selected: ["回归测试", "构建, 打包"] },
    { checks: ["构建, 打包", "回归测试"], text: "构建, 打包, 回归测试", selected: ["回归测试", "构建, 打包"] },
  ])("preserves the full answer and marks only preset labels ($checks)", ({ checks, text, selected }) => {
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
