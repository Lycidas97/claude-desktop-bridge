import type { BridgeEvent, BridgePendingPrompt, BridgePrAutoFixState, BridgeSessionInfo } from "@bridge/protocol";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativePromptCard } from "./NativePromptCard.js";
import { SessionPrBar } from "./SessionPrBar.js";

const harness = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], effectIndex: 0, effects: [] as unknown[][], pending: [] as Array<() => void> }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = harness.index++;
    if (!(index in harness.slots)) harness.slots[index] = initial;
    return [harness.slots[index], (value: unknown) => {
      harness.slots[index] = typeof value === "function" ? value(harness.slots[index]) : value;
    }];
  },
  useEffect(effect: () => void, deps: unknown[]) {
    const index = harness.effectIndex++;
    const previous = harness.effects[index];
    if (previous && deps.length === previous.length && deps.every((value, index) => Object.is(value, previous[index]))) return;
    harness.effects[index] = deps;
    harness.pending.push(effect);
  },
}));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

function renderPr(props: Parameters<typeof SessionPrBar>[0]): ReturnType<typeof SessionPrBar> {
  harness.index = 0;
  harness.effectIndex = 0;
  SessionPrBar(props);
  for (const effect of harness.pending.splice(0)) effect();
  harness.index = 0;
  harness.effectIndex = 0;
  return SessionPrBar(props);
}

function open(element: ReactElement<Record<string, any>>): void {
  const target = { open: true };
  element.props.onToggle({ currentTarget: target, target });
}

const prompt: BridgePendingPrompt = {
  kind: "refusal-fallback", promptId: "prompt-1", sessionId: "session-1", title: "切换模型", canRespond: true,
  choices: [{ value: "retry_fallback", label: "使用备用模型" }, { value: "edit_prompt", label: "修改问题" }],
};
const pr = { repo: "owner/project", prNumber: 42, url: "https://github.com/owner/project/pull/42", state: "OPEN", autoFix: false };
const session = { sessionId: "session-1", prs: [pr] } as BridgeSessionInfo;
const state: BridgePrAutoFixState = {
  sessionId: "session-1", prs: [pr], onlyOwnPrs: false, nextOwnPrArmed: false,
  capabilities: { bound: true, onlyOwnPrs: true, nextPr: true, checks: true },
};

beforeEach(() => { harness.index = 0; harness.slots = []; harness.effectIndex = 0; harness.effects = []; harness.pending = []; });

describe("Native prompt choices", () => {
  it("submits the Native choice string rather than a tool permission decision", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const tree = NativePromptCard({ prompt, onResolve });
    const button = elements(tree).find(element => element.type === "button" && text(element) === "修改问题")!;
    button.props.onClick();
    await Promise.resolve();
    expect(onResolve).toHaveBeenCalledWith("session-1", "prompt-1", "edit_prompt");
  });

  it("keeps unsupported Native dialogs and disconnected clients read only", () => {
    const onResolve = vi.fn();
    for (const props of [{ prompt: { ...prompt, canRespond: false }, onResolve }, { prompt, online: false, onResolve }, { prompt }]) {
      harness.index = 0;
      const tree = NativePromptCard(props);
      expect(elements(tree).filter(element => element.type === "button").every(button => button.props.disabled)).toBe(true);
    }
    expect(onResolve).not.toHaveBeenCalled();
  });
});

describe("PR Auto-fix disclosure", () => {
  it("reads only after expansion and fetches checks only for the selected PR", async () => {
    const onRead = vi.fn().mockResolvedValue(state);
    const onSet = vi.fn();
    function render() { return renderPr({ session, supported: true, online: true, onRead, onSet }); }
    let tree = render();
    expect(onRead).not.toHaveBeenCalled();
    open(tree);
    await Promise.resolve();
    expect(onRead).toHaveBeenCalledExactlyOnceWith("session-1", undefined, false);
    tree = render();
    const disclosure = elements(tree).find(element => element.type === "details" && element.props.className === "session-pr-entry")!;
    const target = { open: true };
    disclosure.props.onToggle({ currentTarget: target, target });
    await Promise.resolve();
    expect(onRead).toHaveBeenLastCalledWith("session-1", pr, true);
    expect(onSet).not.toHaveBeenCalled();
  });

  it("review regression: reads checks once after an already-open PR finishes waiting for preferences", async () => {
    let finish!: (value: BridgePrAutoFixState) => void;
    const onRead = vi.fn().mockImplementationOnce(() => new Promise<BridgePrAutoFixState>(resolve => { finish = resolve; }))
      .mockRejectedValue(new Error("Owned checks failure"));
    const props = { session, supported: true, online: true, onRead, onSet: vi.fn() };
    open(renderPr(props));
    open(elements(renderPr(props)).find(element => element.props.className === "session-pr-entry")!);
    expect(onRead).toHaveBeenCalledTimes(1);
    finish(state);
    await Promise.resolve();
    renderPr(props);
    await Promise.resolve();
    renderPr(props);
    expect(onRead).toHaveBeenNthCalledWith(2, "session-1", pr, true);
    expect(text(renderPr(props))).toContain("Owned checks failure");
    renderPr(props);
    await Promise.resolve();
    renderPr(props);
    expect(onRead).toHaveBeenCalledTimes(2);
  });

  it("keeps failed writes at the last Native state and exposes the failure", async () => {
    const onRead = vi.fn().mockResolvedValue(state);
    const onSet = vi.fn().mockRejectedValue(new Error("Desktop 拒绝布防"));
    function render() { return renderPr({ session, supported: true, online: true, onRead, onSet }); }
    open(render());
    await Promise.resolve();
    let tree = render();
    elements(tree).find(element => element.type === "button" && text(element) === "布防下一个 PR")!.props.onClick();
    await Promise.resolve();
    tree = render();
    expect(onSet).toHaveBeenCalledWith({ sessionId: "session-1", target: "next-pr", enabled: true });
    expect(elements(tree).find(element => element.type === "button" && text(element) === "布防下一个 PR")!.props.disabled).toBe(false);
    expect(text(tree)).toContain("Desktop 拒绝布防");
  });

  it("shows failed check names and never queries older hosts", async () => {
    const onRead = vi.fn().mockResolvedValue({ ...state, checks: [{ name: "Windows build", state: "fail" }] });
    const onSet = vi.fn();
    function render(supported = true) { return renderPr({ session, supported, online: true, onRead, onSet }); }
    open(render(false));
    expect(onRead).not.toHaveBeenCalled();
    open(render());
    await Promise.resolve();
    const disclosure = elements(render()).find(element => element.type === "details" && element.props.className === "session-pr-entry")!;
    const target = { open: true };
    disclosure.props.onToggle({ currentTarget: target, target });
    await Promise.resolve();
    const failed = elements(render()).find(element => element.type === "li" && element.props.className === "is-failed")!;
    expect(text(failed)).toContain("Windows build");
    expect(text(failed)).toContain("fail");
  });

  it("clears an armed latch from the Native session projection without querying GitHub", async () => {
    const onRead = vi.fn().mockResolvedValue({ ...state, nextOwnPrArmed: true });
    const onSet = vi.fn();
    const props = { session, supported: true, online: true, onRead, onSet };
    open(renderPr(props));
    await Promise.resolve();
    expect(elements(renderPr(props)).find(element => element.type === "button" && text(element) === "已布防下一个 PR")!.props.disabled).toBe(true);
    const next = renderPr({ ...props, session: { ...session, prAutoFix: { onlyOwnPrs: true, nextOwnPrArmed: false } } });
    expect(elements(next).find(element => element.type === "button" && text(element) === "布防下一个 PR")!.props.disabled).toBe(false);
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onSet).not.toHaveBeenCalled();
  });

  it("shows settlement errors and applies the Native result carried by the event", async () => {
    const onRead = vi.fn().mockResolvedValue({ ...state, nextOwnPrArmed: true });
    const onSet = vi.fn();
    const props = { session, supported: true, online: true, onRead, onSet };
    open(renderPr(props));
    await Promise.resolve();
    const event: BridgeEvent = {
      eventId: "settled", seq: 4, timestamp: 4, origin: "claude-desktop", sessionId: "session-1", type: "pr.autoFix.updated",
      data: { error: "Native 布防已失效", state },
    };
    const next = renderPr({ ...props, events: [event] });
    expect(elements(next).find(element => element.type === "button" && text(element) === "布防下一个 PR")!.props.disabled).toBe(false);
    expect(text(next)).toContain("Native 布防已失效");
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onSet).not.toHaveBeenCalled();
  });
});
