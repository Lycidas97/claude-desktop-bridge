import { describe, expect, it } from "vitest";
import { nativeHistoryItems, type NativeMessageProjection } from "./native-history-projection.js";

const questions = [
  { question: "选择检查项目", multiSelect: true, options: [{ label: "稍后处理" }, { label: "类型检查" }, { label: "回归测试" }] },
  { question: "选择执行范围", options: [{ label: "仅本机" }, { label: "所有设备" }] },
];

function ask(id: string, toolUseId: string) {
  return { type: "assistant", uuid: id, timestamp: 10, message: { content: [
    { type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } },
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
      { question: "选择检查项目", answer: "类型检查, 回归测试", options: [{ label: "稍后处理" }, { label: "类型检查", selected: true }, { label: "回归测试", selected: true }] },
      { question: "选择执行范围", answer: "仅本机", options: [{ label: "仅本机", selected: true }, { label: "所有设备" }] },
    ],
  } });
  expect(items.find(item => item.id === id)?.interactivePrompt?.questions?.[0]?.options[0]?.selected).toBeUndefined();
}

describe("native question answers", () => {
  it.each([{ checks: "类型检查, 回归测试" }, { checks: ["类型检查", "回归测试"] }])("restores every selection from a native history tool result ($checks)", ({ checks }) => {
    expectSelected(nativeHistoryItems("session", [ask("question", "ask-1"), answer("ask-1", checks)]), "question");
  });

  it("reprojects the same question when its answer arrives in a later live event", () => {
    const projection: NativeMessageProjection = {};
    expect(nativeHistoryItems("session", [ask("question", "ask-1")], projection)[0]?.interactivePrompt?.answered).toBeUndefined();
    expectSelected(nativeHistoryItems("session", [answer("ask-1", "类型检查, 回归测试")], projection), "question");
  });

  it("matches the tool ID when two question cards have the same text", () => {
    const items = nativeHistoryItems("session", [ask("first", "ask-1"), ask("second", "ask-2"), answer("ask-1", "类型检查, 回归测试")]);
    expectSelected(items, "first");
    expect(items.find(item => item.id === "second")?.interactivePrompt?.answered).toBeUndefined();
  });
});
