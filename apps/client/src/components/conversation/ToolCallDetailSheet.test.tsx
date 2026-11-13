import type { BridgeEvent, BridgeHistoryItem, BridgeResponse, BridgeToolCallDetail } from "@bridge/protocol";
import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationItems, groupTimelineTools, type ConversationItem } from "../../lib/conversation-timeline.js";
import { dispatchMobileBack } from "../../lib/mobile-back-navigation.js";
import { clearToolCallDetailCache, ToolCallDetailSheet, ToolCallGroupRows } from "./ToolCallDetailSheet.js";

const env = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  dirty: false,
  effects: [] as Array<{ deps?: unknown[]; cleanup?: (() => void) | undefined }>,
  pending: [] as Array<() => void>,
  effectIndex: 0,
  request: undefined as undefined | ReturnType<typeof vi.fn>,
}));

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const index = env.index++;
    if (!(index in env.slots)) {
      env.slots[index] = typeof initial === "function" ? initial() : initial;
    }
    return [env.slots[index], (value: any) => {
      const next = typeof value === "function" ? value(env.slots[index]) : value;
      if (!Object.is(next, env.slots[index])) env.dirty = true;
      env.slots[index] = next;
    }];
  },
  useCallback: <T extends (...args: any[]) => any>(fn: T) => fn,
  useRef(initial: any) {
    const index = env.index++;
    if (!(index in env.slots)) {
      env.slots[index] = { current: initial };
    }
    return env.slots[index];
  },
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = env.effectIndex++;
    const prev = env.effects[index];
    if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((v, i) => Object.is(v, prev.deps?.[i]))) {
      return;
    }
    env.pending.push(() => {
      prev?.cleanup?.();
      env.effects[index] = { ...(deps ? { deps } : {}), cleanup: effect() || undefined };
    });
  },
}));

vi.mock("../evidence/MediaPreviewProvider.js", () => ({
  useMediaRequest: () => env.request,
}));

vi.mock("../mobile/MobileSheet.js", () => ({
  MobileSheet: ({ eyebrow, title, closeLabel, onClose, children }: {
    eyebrow?: ReactNode;
    title: ReactNode;
    closeLabel?: string;
    onClose(): void;
    children: ReactNode;
  }) => createElement(
    "section",
    { role: "dialog", "aria-label": String(title) },
    createElement("header", null, eyebrow, createElement("h2", null, title), createElement("button", { type: "button", "aria-label": closeLabel ?? "关闭", onClick: onClose }, "×")),
    children,
  ),
}));

function expandTree(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expandTree);
  if (!node || typeof node !== "object" || !("type" in node)) return node;
  const element = node as ReactElement<Record<string, any>>;
  if (typeof element.type === "function") {
    const rendered = (element.type as (props: Record<string, any>) => ReactNode)(element.props);
    return expandTree(rendered);
  }
  if (element.props?.children !== undefined) {
    return { ...element, props: { ...element.props, children: expandTree(element.props.children) } };
  }
  return element;
}

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}

function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "object" && "props" in node) {
    return textContent((node as ReactElement<Record<string, any>>).props.children);
  }
  return "";
}

function createHarness(renderRoot: () => ReactNode) {
  return () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      env.index = 0;
      env.effectIndex = 0;
      env.dirty = false;
      const tree = expandTree(renderRoot());
      env.slots.length = env.index;
      for (const unmounted of env.effects.splice(env.effectIndex)) {
        unmounted?.cleanup?.();
      }
      const effects = env.pending.splice(0);
      for (const run of effects) run();
      if (!env.dirty) return tree;
    }
    throw new Error("Harness did not settle");
  };
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const keyListeners = new Set<(event: { key: string; stopPropagation(): void }) => void>();

beforeEach(() => {
  clearToolCallDetailCache();
  env.slots = [];
  env.effects = [];
  env.pending = [];
  env.request = vi.fn();
  keyListeners.clear();
  vi.stubGlobal("document", {
    addEventListener: vi.fn((type: string, fn: any) => {
      if (type === "keydown") keyListeners.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: any) => {
      if (type === "keydown") keyListeners.delete(fn);
    }),
    createElement: vi.fn(() => ({
      value: "",
      readOnly: false,
      style: {},
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    })),
    body: { appendChild: vi.fn() },
    execCommand: vi.fn(() => true),
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
  for (const effect of env.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
});

describe("conversationItems toolUseId tracking", () => {
  it("preserves stable toolUseId for history and itemId-backed live events without mistaking missing itemIds", () => {
    const historyItem: BridgeHistoryItem = {
      id: "toolu_hist_1",
      sessionId: "s1",
      role: "tool",
      toolName: "Read",
      text: "/src/index.ts",
      createdAt: 10,
      origin: "claude-desktop",
    };
    const liveWithItemId: BridgeEvent = {
      eventId: "evt_live_1",
      seq: 1,
      timestamp: 20,
      sessionId: "s1",
      itemId: "toolu_live_1",
      origin: "claude-desktop",
      type: "tool.completed",
      data: { toolName: "Bash", text: "npm test", isError: true },
    };
    const liveWithoutItemId: BridgeEvent = {
      eventId: "evt_fallback_only",
      seq: 2,
      timestamp: 30,
      sessionId: "s1",
      origin: "claude-host",
      type: "tool.started",
      data: { toolName: "Glob", text: "*.ts" },
    };

    const items = conversationItems("s1", { status: "ready", hasMore: false, items: [historyItem] }, [liveWithItemId, liveWithoutItemId], []);
    const grouped = groupTimelineTools(items.map((item) => ({ kind: "message" as const, item })));
    expect(grouped).toHaveLength(1);
    const tools = (grouped[0] as { kind: "tool-group"; tools: ConversationItem[] }).tools;
    expect(tools.map((t) => ({ id: t.id, toolUseId: t.toolUseId, isError: t.isError }))).toEqual([
      { id: "tool:toolu_hist_1", toolUseId: "toolu_hist_1", isError: undefined },
      { id: "tool:toolu_live_1", toolUseId: "toolu_live_1", isError: true },
      { id: "tool:evt_fallback_only", toolUseId: undefined, isError: undefined },
    ]);
  });
});

describe("ToolCallGroupRows and ToolCallDetailSheet", () => {
  const sampleTools: ConversationItem[] = [
    {
      id: "tool:toolu_bash",
      toolUseId: "toolu_bash",
      sessionId: "s1",
      role: "tool",
      toolName: "Bash",
      text: "Check status · git status",
      createdAt: 1,
      origin: "claude-desktop",
      state: "completed",
    },
    {
      id: "tool:toolu_read",
      toolUseId: "toolu_read",
      sessionId: "s1",
      role: "tool",
      toolName: "Read",
      text: "/project/README.md",
      createdAt: 2,
      origin: "claude-desktop",
      state: "completed",
    },
  ];

  it("opens on row click, renders Bash command/description + output, copies text, and caches completed results", async () => {
    const detail: BridgeToolCallDetail = {
      sessionId: "s1",
      toolUseId: "toolu_bash",
      toolName: "Bash",
      input: { command: "git status --short", description: "Show working tree status" },
      status: "completed",
      outputText: " M apps/client/src/components/MobileWorkspace.tsx\n",
      truncated: false,
      totalBytes: 50,
    };
    env.request!.mockResolvedValue({ ok: true, result: { detail } } satisfies Partial<BridgeResponse>);

    const draw = createHarness(() => createElement(ToolCallGroupRows, {
      hostId: "host_1",
      sessionId: "s1",
      tools: sampleTools,
      supportsToolDetail: true,
    }));

    let tree = draw();
    const rowButtons = elements(tree).filter((el) => el.type === "button" && String(el.props.className ?? "").includes("conversation-tool-row"));
    expect(rowButtons).toHaveLength(2);
    expect(env.request).not.toHaveBeenCalled();

    // Click Bash row
    rowButtons[0]!.props.onClick();
    tree = draw();
    expect(textContent(tree)).toContain("正在加载工具详情");
    expect(env.request).toHaveBeenCalledTimes(1);
    expect(env.request).toHaveBeenCalledWith(
      "session.tool.detail",
      { sessionId: "s1", toolUseId: "toolu_bash" },
      { wait: true, timeoutMs: 30_000 },
    );

    await flushPromises();
    tree = draw();
    const rendered = textContent(tree);
    expect(rendered).toContain("已完成");
    expect(rendered).toContain("Show working tree status");
    expect(rendered).toContain("git status --short");
    expect(rendered).toContain("M apps/client/src/components/MobileWorkspace.tsx");

    // Copy command and output
    const copyCmd = elements(tree).find((el) => el.type === "button" && el.props["aria-label"] === "复制命令");
    const copyOut = elements(tree).find((el) => el.type === "button" && el.props["aria-label"] === "复制输出");
    expect(copyCmd).toBeDefined();
    expect(copyOut).toBeDefined();
    copyCmd!.props.onClick();
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("git status --short");
    copyOut!.props.onClick();
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(" M apps/client/src/components/MobileWorkspace.tsx\n");

    // Close via mobile back handler and reopen: hits in-memory cache without another RPC
    expect(dispatchMobileBack()).toBe(true);
    tree = draw();
    expect(elements(tree).find((el) => el.props.role === "dialog")).toBeUndefined();

    const reopenedBtn = elements(tree).filter((el) => el.type === "button" && String(el.props.className ?? "").includes("conversation-tool-row"))[0]!;
    reopenedBtn.props.onClick();
    tree = draw();
    expect(env.request).toHaveBeenCalledTimes(1);
    expect(textContent(tree)).toContain("git status --short");
  });

  it("re-fetches running tools on reopen and supports error retry, omitted non-text notices, and truncation labels", async () => {
    let callCount = 0;
    env.request!.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          result: {
            detail: {
              sessionId: "s1",
              toolUseId: "toolu_live",
              toolName: "Read",
              input: { file_path: "/project/plot.png", limit: 100 },
              status: "running",
              truncated: false,
              totalBytes: 0,
            } satisfies BridgeToolCallDetail,
          },
        };
      }
      if (callCount === 2) {
        return { ok: false, error: { code: "DISCONNECTED", message: "连接暂时中断", retryable: true } };
      }
      return {
        ok: true,
        result: {
          detail: {
            sessionId: "s1",
            toolUseId: "toolu_live",
            toolName: "Read",
            input: { file_path: "/project/plot.png", limit: 100 },
            status: "error",
            isError: true,
            outputText: "Error: Image corrupt",
            omittedBlocks: [{ type: "image", mimeType: "image/png", count: 1 }],
            truncated: true,
            totalBytes: 300 * 1024,
          } satisfies BridgeToolCallDetail,
        },
      };
    });

    const liveTools: ConversationItem[] = [{
      id: "tool:toolu_live",
      toolUseId: "toolu_live",
      sessionId: "s1",
      role: "tool",
      toolName: "Read",
      text: "/project/plot.png",
      createdAt: 1,
      origin: "claude-desktop",
      state: "running",
    }];

    const draw = createHarness(() => createElement(ToolCallGroupRows, {
      hostId: "host_1",
      sessionId: "s1",
      tools: liveTools,
      supportsToolDetail: true,
    }));

    // 1st open -> running
    let tree = draw();
    elements(tree).find((el) => el.type === "button")!.props.onClick();
    draw();
    await flushPromises();
    tree = draw();
    expect(textContent(tree)).toContain("工具正在执行，尚未返回输出");

    // Close via Escape, then reopen -> must NOT stick to cached running state; 2nd call fails
    for (const listener of keyListeners) listener({ key: "Escape", stopPropagation: () => {} });
    tree = draw();
    elements(tree).find((el) => el.type === "button")!.props.onClick();
    draw();
    await flushPromises();
    tree = draw();
    expect(callCount).toBe(2);
    expect(textContent(tree)).toContain("连接暂时中断");

    // Click Retry -> 3rd call returns error + omitted image block + truncation metadata
    const retryBtn = elements(tree).find((el) => el.type === "button" && textContent(el) === "重试")!;
    retryBtn.props.onClick();
    draw();
    await flushPromises();
    tree = draw();
    const finalText = textContent(tree);
    expect(callCount).toBe(3);
    expect(finalText).toContain("执行出错");
    expect(finalText).toContain("错误输出");
    expect(finalText).toContain("已截断（共 300 KiB，展示前 256 KiB）");
    expect(finalText).toContain("已省略 1 个图片内容块 (image/png)");
    expect(finalText).toContain("Error: Image corrupt");
    expect(finalText).toContain('"file_path": "/project/plot.png"');
  });

  it("falls back to local summary without invoking RPC when host lacks transcript.toolDetail.v1", () => {
    const draw = createHarness(() => createElement(ToolCallDetailSheet, {
      hostId: "host_old",
      sessionId: "s1",
      toolUseId: "toolu_bash",
      toolName: "Bash",
      fallbackText: "ls -la",
      supportsToolDetail: false,
      onClose: vi.fn(),
    }));

    const tree = draw();
    expect(env.request).not.toHaveBeenCalled();
    expect(textContent(tree)).toContain("ls -la");
    expect(textContent(tree)).toContain("电脑端版本较旧");
  });
});
