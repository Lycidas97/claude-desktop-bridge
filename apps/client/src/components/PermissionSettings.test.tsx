import type { BridgeHostSnapshot, BridgeSessionConfiguration, BridgeSessionInfo } from "@bridge/protocol";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileBack, registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { SessionConfigurationDialog } from "./SessionConfigurationDialog.js";
import { SessionRewindDialog } from "./SessionRewindDialog.js";
import { MagpieModelQuota } from "../../../../plugins/magpie-quota/client.js";

// These components have no DOM test dependency; drive their hooks and public
// controls directly, including effect completion and back-handler cleanup.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>,
  effectIndex: 0,
  pending: [] as Array<() => void>,
  // What useContext reads: the Magpie quota provider's value, or none as on the desktop dashboard.
  context: undefined as unknown,
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useContext: () => hooks.context,
  useState(initial: unknown) {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.states[index], (next: unknown) => {
      hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
    }];
  },
  useMemo: (create: () => unknown) => create(),
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps && deps.length === previous.deps?.length
      && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));

function render(create: () => ReactElement): ReactElement {
  hooks.stateIndex = 0;
  hooks.effectIndex = 0;
  const root = create();
  const tree = (root.type as (props: unknown) => ReactElement)(root.props);
  hooks.pending.splice(0).forEach((effect) => effect());
  return tree;
}

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
  }
  return "";
}

function button(tree: ReactElement, text: string): ReactElement<Record<string, any>> {
  return elements(tree).find((element) => element.type === "button" && textContent(element.props.children).trim() === text)!;
}

function confirmation(tree: ReactElement): ReactElement<Record<string, any>> {
  return elements(tree).find((element) => element.type === ConfirmationDialog)!;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  hooks.states = [];
  hooks.effects = [];
  hooks.pending = [];
  hooks.context = undefined;
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

const session = {
  sessionId: "session-1", title: "Task", runtimeId: "claude-desktop", transport: "claude-desktop-native", turnState: "idle",
} as BridgeSessionInfo;
const configuration: BridgeSessionConfiguration = {
  sessionId: session.sessionId,
  model: "current-model",
  modelSource: "default",
  effortSource: "default",
  availableModels: [{ value: "current-model", displayName: "Current" }],
  availableEffortLevels: ["medium"],
  modelsComplete: true,
  appliesAfterTurn: false,
  permissionPolicy: { hostMode: "full-access", effectiveMode: "full-access", source: "host" },
};

describe("session effort", () => {
  it("shows and saves the nearest level the model supports instead of an unsupported current effort", async () => {
    const gemini = {
      ...configuration,
      model: "gemini[1m]",
      effort: "xhigh" as const,
      availableModels: [
        { value: "gemini[1m]", displayName: "Gemini", supportedEffortLevels: ["low", "medium", "high"] },
        { value: "claude", displayName: "Claude", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      ],
      availableEffortLevels: ["low", "medium", "high"] as const,
    } as BridgeSessionConfiguration;
    const props = {
      session, onLoad: vi.fn().mockResolvedValue(gemini), onSave: vi.fn().mockResolvedValue(gemini), onClose: vi.fn(),
    };
    const draw = () => render(() => <SessionConfigurationDialog {...props} />);
    draw();
    await settle();
    let tree = draw();
    expect(button(tree, "高").props["aria-pressed"]).toBe(true);
    expect(button(tree, "极高")).toBeUndefined();
    expect(textContent(tree)).toContain("这个模型不支持「极高」");
    button(tree, "保存配置").props.onClick();
    await settle();
    expect(props.onSave).toHaveBeenCalledWith({ model: "gemini[1m]", reasoningEffort: "high" });

    elements(tree).find((element) => element.type === "select" && element.props.value === "gemini[1m]")!
      .props.onChange({ target: { value: "claude" } });
    tree = draw();
    expect(button(tree, "极高").props["aria-pressed"], "a model that supports it gets it back").toBe(true);
  });
});

describe("native Claude session configuration", () => {
  it("loads and displays quota for the selected native Claude model without changing its execution ID", async () => {
    const model = { value: "mythos-magpie-1234567890", displayName: "Opus", resolvedModel: "claude/claude-opus-5-5" };
    const request = vi.fn().mockReturnValue(vi.fn());
    hooks.context = {
      enabled: true, loading: false, request, refresh: vi.fn(),
      snapshot: { status: "available", fetchedAt: 1_000, accounts: [{ provider: "claude", windows: [{ name: "5 hours", remaining: 80 }] }] },
    };
    const native = { ...configuration, model: model.value, availableModels: [model], availableEffortLevels: [] };
    const props = { session: { ...session, runtimeId: "claude-desktop" as const, transport: "claude-desktop-native" as const },
      onLoad: vi.fn().mockResolvedValue(native), onSave: vi.fn().mockResolvedValue(native), onClose: vi.fn() };
    const draw = () => render(() => <SessionConfigurationDialog {...props} />);
    draw(); await settle();
    const tree = draw();
    expect(request).toHaveBeenCalledOnce();
    expect(textContent(tree)).toContain("单账号最高可用 80%");
    expect(elements(tree).find(element => element.type === MagpieModelQuota)?.props.model).toEqual(model);
    button(tree, "保存配置").props.onClick(); await settle();
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith({ model: model.value });
  });

  it("saves native permissionMode through session.configure and confirms bypassPermissions", async () => {
    const native = { ...configuration, nativePermissionMode: "default", availableModels: [], availableEffortLevels: [] } as BridgeSessionConfiguration;
    const props = { session: { ...session, runtimeId: "claude-desktop" as const, transport: "claude-desktop-native" as const },
      onLoad: vi.fn().mockResolvedValue(native), onSave: vi.fn().mockResolvedValue(native), onClose: vi.fn() };
    const draw = () => render(() => <SessionConfigurationDialog {...props} />);
    draw(); await settle();
    let tree = draw();
    const select = elements(tree).find(element => element.props["aria-label"] === "Desktop 授权模式")!;
    select.props.onChange({ target: { value: "bypassPermissions" } }); tree = draw();
    button(tree, "保存配置").props.onClick(); tree = draw();
    expect(confirmation(tree).props.open).toBe(true);
    expect(props.onSave).not.toHaveBeenCalled();
    confirmation(tree).props.onConfirm(); await settle();
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith({ permissionMode: "bypassPermissions" });
  });

  it("closes native full-access confirmation before the workspace on mobile back and keeps the draft", async () => {
    const native = { ...configuration, nativePermissionMode: "default", availableModels: [], availableEffortLevels: [] } as BridgeSessionConfiguration;
    const props = { session, onLoad: vi.fn().mockResolvedValue(native), onSave: vi.fn(), onClose: vi.fn() };
    const workspaceBack = vi.fn(() => true);
    const removeWorkspace = registerMobileBackHandler(workspaceBack, 100);
    try {
      const draw = () => render(() => <SessionConfigurationDialog {...props} />);
      draw(); await settle();
      let tree = draw();
      elements(tree).find(element => element.props["aria-label"] === "Desktop 授权模式")!
        .props.onChange({ target: { value: "bypassPermissions" } });
      tree = draw();
      button(tree, "保存配置").props.onClick();
      tree = draw();
      expect(confirmation(tree).props.open).toBe(true);
      expect(dispatchMobileBack()).toBe(true);
      expect(workspaceBack).not.toHaveBeenCalled();
      tree = draw();
      expect(confirmation(tree).props.open).toBe(false);
      expect(elements(tree).find(element => element.props["aria-label"] === "Desktop 授权模式")!.props.value).toBe("bypassPermissions");
      expect(props.onSave).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
      expect(dispatchMobileBack()).toBe(true);
      expect(workspaceBack).toHaveBeenCalledOnce();
      expect(props.onSave).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
    } finally {
      removeWorkspace();
    }
  });

  it("shows only native configuration options and ignores legacy Bridge permission policies", async () => {
    const props = { session: { ...session, runtimeId: "claude-desktop" as const, transport: "claude-desktop-native" as const },
      onLoad: vi.fn().mockResolvedValue({ ...configuration, availableModels: [], availableEffortLevels: [], supportsFastMode: false }),
      onSave: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionConfigurationDialog {...props} />);
    draw(); await settle();
    const tree = draw();
    expect(elements(tree).some(element => element.props["aria-label"] === "授权等级")).toBe(false);
    expect(elements(tree).some(element => element.type === "select")).toBe(false);
    expect(button(tree, "保存配置").props.disabled).toBe(true);
    expect(textContent(tree)).not.toContain("Host");
    expect(elements(tree).some(element => element.type === MagpieModelQuota)).toBe(false);
  });
});

describe("session rewind confirmation", () => {
  beforeEach(() => vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const messages = [{ id: "user-uuid", sessionId: "session-1", role: "user" as const, text: "Rewrite this request", createdAt: 1, origin: "claude-desktop" as const }];
  const preview = { sessionId: "session-1", messageId: "user-uuid", canRewindConversation: true, canRewindFiles: true, filesChanged: ["src/app.ts"] };

  it("previews without changing anything and executes the exact target and chosen scope only after confirmation", async () => {
    const result = { sessionId: "session-1", messageId: "user-uuid", scope: "both" as const, prefill: "Rewrite this request" };
    const props = { messages, disabled: false, onPreview: vi.fn().mockResolvedValue(preview), onRewind: vi.fn().mockResolvedValue(result), onComplete: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionRewindDialog {...props} />);
    draw(); await settle(); let tree = draw();
    expect(props.onPreview).toHaveBeenCalledExactlyOnceWith("user-uuid");
    expect(props.onRewind).not.toHaveBeenCalled();
    elements(tree).find(element => element.props["aria-label"] === "回退范围")!.props.onChange({ target: { value: "both" } });
    tree = draw();
    expect(textContent(tree)).toContain("src/app.ts");
    expect(textContent(tree)).toContain("附件需重新添加");
    button(tree, "确认回退").props.onClick(); await settle();
    expect(props.onRewind).toHaveBeenCalledExactlyOnceWith("user-uuid", "both");
    expect(props.onComplete).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("allows file restoration when native Desktop rejects conversation rewind", async () => {
    const props = { messages, disabled: false, onPreview: vi.fn().mockResolvedValue({ ...preview, canRewindConversation: false }), onRewind: vi.fn(), onComplete: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionRewindDialog {...props} />);
    draw(); await settle(); const tree = draw();
    expect(elements(tree).find(element => element.props["aria-label"] === "回退范围")?.props.value).toBe("files");
    expect(elements(tree).find(element => element.type === "option" && element.props.value === "conversation")?.props.disabled).toBe(true);
    expect(button(tree, "确认回退").props.disabled).toBe(false);
    button(tree, "取消").props.onClick();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onRewind).not.toHaveBeenCalled();
  });

  it("[boundary] ignores an older preview after switching the selected native target", async () => {
    let finishFirst!: (value: typeof preview) => void;
    const first = new Promise<typeof preview>(resolve => { finishFirst = resolve; });
    const next = { ...messages[0]!, id: "second-user", text: "Second request" };
    const props = { messages: [...messages, next], initialMessageId: "user-uuid", disabled: false,
      onPreview: vi.fn((id: string) => id === "user-uuid" ? first : Promise.resolve({ ...preview, messageId: id, canRewindFiles: false })),
      onRewind: vi.fn().mockResolvedValue({ sessionId: "session-1", messageId: next.id, scope: "conversation" }), onComplete: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionRewindDialog {...props} />);
    draw();
    elements(draw()).find(element => element.props["aria-label"] === "回退目标消息")!.props.onChange({ target: { value: next.id } });
    draw(); await settle();
    finishFirst({ ...preview, canRewindConversation: false }); await settle();
    const tree = draw();
    expect(elements(tree).find(element => element.props["aria-label"] === "回退范围")!.props.value).toBe("conversation");
    expect(button(tree, "确认回退").props.disabled).toBe(false);
    button(tree, "确认回退").props.onClick(); await settle();
    expect(props.onRewind).toHaveBeenCalledExactlyOnceWith(next.id, "conversation");
  });

  it("[boundary] discards a preview completed while disconnected and checks again after reconnect", async () => {
    let finish!: (value: typeof preview) => void;
    const held = new Promise<typeof preview>(resolve => { finish = resolve; });
    const props = { messages, disabled: false, onPreview: vi.fn().mockReturnValueOnce(held).mockResolvedValue({ ...preview, canRewindConversation: false, canRewindFiles: false }),
      onRewind: vi.fn(), onComplete: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionRewindDialog {...props} />);
    draw(); props.disabled = true; draw();
    finish(preview); await settle();
    let tree = draw(); expect(button(tree, "确认回退").props.disabled).toBe(true);
    button(tree, "确认回退").props.onClick(); expect(props.onRewind).not.toHaveBeenCalled();
    props.disabled = false; draw(); await settle(); tree = draw();
    expect(props.onPreview).toHaveBeenCalledTimes(2);
    expect(button(tree, "确认回退").props.disabled).toBe(true);
    expect(textContent(tree)).toContain("Desktop 无法回退");
    expect(props.onRewind).not.toHaveBeenCalled();
  });

  it("[boundary] rejects confirmation while Native has neither a conversation anchor nor available files", async () => {
    const props = { messages, disabled: false, onPreview: vi.fn().mockResolvedValue({ ...preview, canRewindConversation: false, canRewindFiles: false, filesChanged: [], fileError: "Session is busy" }),
      onRewind: vi.fn(), onComplete: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionRewindDialog {...props} />);
    draw(); await settle(); const tree = draw();
    expect(button(tree, "确认回退").props.disabled).toBe(true);
    button(tree, "确认回退").props.onClick(); await settle();
    expect(textContent(tree)).toContain("Session is busy");
    expect(props.onRewind).not.toHaveBeenCalled();
  });

  it("[boundary] sends one rewind while pending and blocks back navigation until Native returns", async () => {
    const result = { sessionId: "session-1", messageId: "user-uuid", scope: "conversation" as const, prefill: "Original" };
    let finish!: (value: typeof result) => void;
    const props = { messages, disabled: false, onPreview: vi.fn().mockResolvedValue(preview), onRewind: vi.fn(() => new Promise<typeof result>(resolve => { finish = resolve; })), onComplete: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionRewindDialog {...props} />);
    draw(); await settle(); button(draw(), "确认回退").props.onClick();
    const tree = draw();
    expect(button(tree, "正在回退").props.disabled).toBe(true);
    expect(elements(tree).filter(element => element.type === "select").every(element => element.props.disabled)).toBe(true);
    button(tree, "正在回退").props.onClick();
    expect(dispatchMobileBack()).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled(); expect(props.onRewind).toHaveBeenCalledTimes(1);
    finish(result); await settle(); draw();
    expect(props.onComplete).toHaveBeenCalledExactlyOnceWith(result);
    dispatchMobileBack(); expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("[boundary] lets the user retry a rejected rewind without treating the first attempt as completed", async () => {
    const result = { sessionId: "session-1", messageId: "user-uuid", scope: "conversation" as const, prefill: "Original" };
    const props = { messages, disabled: false, onPreview: vi.fn().mockResolvedValue(preview), onRewind: vi.fn().mockRejectedValueOnce(new Error("Checkpoint changed")).mockResolvedValue(result), onComplete: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionRewindDialog {...props} />);
    draw(); await settle(); button(draw(), "确认回退").props.onClick(); await settle();
    let tree = draw(); expect(textContent(tree)).toContain("Checkpoint changed");
    expect(props.onComplete).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    expect(button(tree, "确认回退").props.disabled).toBe(false);
    button(tree, "确认回退").props.onClick(); await settle(); tree = draw();
    expect(props.onRewind.mock.calls).toEqual([["user-uuid", "conversation"], ["user-uuid", "conversation"]]);
    expect(props.onComplete).toHaveBeenCalledExactlyOnceWith(result);
    expect(textContent(tree)).not.toContain("Checkpoint changed");
  });

  it("[boundary] never previews or rewinds a local-only or synthetic queued placeholder", async () => {
    const props = { messages: ["local:request", "queued:command"].map(id => ({ ...messages[0]!, id })), disabled: false,
      onPreview: vi.fn(), onRewind: vi.fn(), onComplete: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionRewindDialog {...props} />);
    draw(); await settle(); const tree = draw();
    expect(textContent(tree)).toContain("当前没有可选择的已发送消息");
    expect(button(tree, "确认回退").props.disabled).toBe(true);
    button(tree, "确认回退").props.onClick();
    expect(props.onPreview).not.toHaveBeenCalled(); expect(props.onRewind).not.toHaveBeenCalled();
  });

  it("shows native execution failures and keeps the confirmation open", async () => {
    const props = { messages, disabled: false, onPreview: vi.fn().mockResolvedValue(preview), onRewind: vi.fn().mockRejectedValue(new Error("Native rewind refused")), onComplete: vi.fn(), onClose: vi.fn() };
    const draw = () => render(() => <SessionRewindDialog {...props} />);
    draw(); await settle(); button(draw(), "确认回退").props.onClick(); await settle();
    expect(textContent(draw())).toContain("Native rewind refused");
    expect(props.onComplete).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
