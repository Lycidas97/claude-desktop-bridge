import type { BridgeBackgroundTask, BridgeHistoryItem, BridgeSubagentSummary } from "@bridge/protocol";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskMarker, BackgroundTasksSheet, findBackgroundTask } from "./BackgroundTasks.js";
import { SubagentCard } from "./SubagentCard.js";

const hooks = vi.hoisted(() => ({ slots: [] as any[], index: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: any) => {
      hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value;
    }];
  },
}));

vi.mock("../mobile/MobileSheet.js", () => ({
  MobileSheet: ({ eyebrow, title, onClose, children, footer }: {
    eyebrow?: ReactNode;
    title: ReactNode;
    onClose(): void;
    children: ReactNode;
    footer?: ReactNode;
  }) => createElement("section", { "aria-label": String(title), "data-eyebrow": eyebrow, onClose }, children, footer),
}));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children), ...elements(element.props.footer)];
}

beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
});

function agent(agentId: string, extra: Partial<BridgeSubagentSummary> = {}): BridgeSubagentSummary {
  return { agentId, description: agentId, state: "running", toolCount: 0, startedAt: 1, updatedAt: 2, ...extra };
}

function item(subagent: BridgeSubagentSummary): BridgeHistoryItem {
  return { id: subagent.toolUseId ?? `subagent:${subagent.agentId}`, sessionId: "A", role: "tool", text: "", createdAt: 1, origin: "claude-desktop", subagent };
}

const workflow: BridgeBackgroundTask = {
  id: "wf-call", kind: "workflow", taskId: "wtask", toolUseId: "wf-call", description: "Draft and check figures",
  state: "running", startedAt: 1, updatedAt: 5,
  workflow: {
    runId: "wf_1", name: "figure-review", phases: ["Draft", "Check", "Revise"],
    agents: [
      agent("a1", { description: "Draft 2.1", workflowRunId: "wf_1", workflowPhase: "Draft", state: "completed", toolCount: 4 }),
      agent("a2", { description: "Draft 2.2", workflowRunId: "wf_1", workflowPhase: "Draft" }),
      agent("a3", { description: "Check 2.1", workflowRunId: "wf_1", workflowPhase: "Check" }),
    ],
  },
};
const shell: BridgeBackgroundTask = {
  id: "bash-call", kind: "bash", taskId: "bsh01", toolUseId: "bash-call", description: "Start dev server", state: "completed", startedAt: 3, updatedAt: 4,
};
const reviewer: BridgeBackgroundTask = {
  id: "agent-call", kind: "subagent", taskId: "ag01", toolUseId: "agent-call", description: "Audit the parser", state: "running", startedAt: 2, updatedAt: 6,
  subagent: agent("ag01", { toolUseId: "agent-call", description: "Audit the parser", toolCount: 7 }),
};

function sheet(focus?: BridgeHistoryItem, items: BridgeHistoryItem[] = [], tasks: BridgeBackgroundTask[] = [workflow, reviewer, shell]) {
  hooks.slots = [];
  hooks.index = 0;
  const rendered: BridgeHistoryItem[] = [];
  const html = renderToStaticMarkup(createElement(BackgroundTasksSheet, {
    sessionId: "A", tasks, items,
    ...(focus ? { focus } : {}),
    renderSubagent: (entry: BridgeHistoryItem) => {
      rendered.push(entry);
      return createElement("article", { "data-card": entry.subagent?.agentId }, entry.subagent?.reportText ?? "");
    },
    onClose: vi.fn(),
  }));
  return { html, rendered };
}

describe("background task tray", () => {
  it("matches stream items to tray entries by workflow run, tool use, then task id", () => {
    const tasks = [workflow, reviewer, shell];
    expect(findBackgroundTask(tasks, agent("a2", { workflowRunId: "wf_1" }))).toBe(workflow);
    expect(findBackgroundTask(tasks, agent("other", { toolUseId: "agent-call" }))).toBe(reviewer);
    expect(findBackgroundTask(tasks, agent("bsh01"))).toBe(shell);
    expect(findBackgroundTask(tasks, agent("missing"))).toBeUndefined();
  });

  it("groups tasks by kind, collapsed until opened", () => {
    const { html, rendered } = sheet();
    expect(html.indexOf("工作流")).toBeLessThan(html.indexOf("子代理"));
    expect(html.indexOf("子代理")).toBeLessThan(html.indexOf("后台命令"));
    expect(html).toContain("figure-review");
    expect(html).toContain("1/3");
    expect(html).not.toContain("workflow-timeline");
    expect(rendered).toEqual([]);
  });

  it("opens the workflow phase timeline when focused from its stream line", () => {
    const { html } = sheet(item(agent("a1", { workflowRunId: "wf_1" })));
    expect(html).toContain("workflow-timeline");
    expect(html).toMatch(/workflow-phase is-running[^]*Draft[^]*1\/2/u);
    expect(html).toMatch(/workflow-phase is-running[^]*Check[^]*0\/1/u);
    expect(html).toMatch(/workflow-phase is-pending[^]*Revise/u);
    expect(html).not.toContain("Audit the parser");
    expect(html).not.toContain("Start dev server");
    expect(html).not.toContain("%");
  });

  it("opens a focused subagent directly into its detail view without unrelated task groups", () => {
    const streamItem = item(agent("ag01", { toolUseId: "agent-call", state: "completed", reportText: "Full report" }));
    const { html, rendered } = sheet(streamItem, [streamItem]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.subagent).toMatchObject({ agentId: "ag01", reportText: "Full report", state: "running" });
    expect(html).not.toContain("figure-review");
    expect(html).not.toContain("Start dev server");
    expect(html).toContain("全部后台任务");
  });

  it("shows the stream item's own card when its task aged out of the tray", () => {
    const old = item(agent("old", { toolUseId: "old-call", state: "completed", reportText: "Earlier" }));
    const { html, rendered } = sheet(old);
    expect(rendered).toEqual([old]);
    expect(html).toContain("Earlier");
    expect(html).not.toContain("figure-review");
    expect(sheet(old, [old], []).html).not.toContain("全部后台任务");
  });

  it("opens a focused bash marker directly without listing other background tasks", () => {
    const bashFocus = item(agent("bsh01", { toolUseId: "bash-call", description: "Start dev server", taskKind: "bash" }));
    const { html, rendered } = sheet(bashFocus);
    expect(rendered).toEqual([]);
    expect(html).toContain("Start dev server");
    expect(html).not.toContain("figure-review");
    expect(html).not.toContain("Audit the parser");
  });

  it("updates a focused subagent live across stream and tray updates, and returns to the full list or closes", () => {
    const initialFocus = item(agent("ag01", { toolUseId: "agent-call", description: "Audit the parser", updatedAt: 2 }));
    const onClose = vi.fn();
    let currentItems: BridgeHistoryItem[] = [initialFocus];
    let currentTasks: BridgeBackgroundTask[] = [workflow, reviewer, shell];
    const render = () => {
      hooks.index = 0;
      return BackgroundTasksSheet({
        sessionId: "A",
        tasks: currentTasks,
        items: currentItems,
        focus: initialFocus,
        renderSubagent: (entry) => createElement("article", { "data-card": entry.subagent?.agentId }, entry.subagent?.reportText ?? ""),
        onClose,
      });
    };

    let tree = render();
    const firstCard = elements(tree).find((el) => el.props["data-card"] === "ag01")!;
    expect(firstCard).toBeDefined();
    expect(elements(tree).some((el) => el.type === "section" && el.props.className === "background-task-group")).toBe(false);

    currentTasks = [
      workflow,
      { ...reviewer, state: "completed", subagent: agent("ag01", { toolUseId: "agent-call", description: "Audit the parser", state: "completed", toolCount: 9, recentTools: ["Read parser.ts"], updatedAt: 10 }) },
      shell,
    ];
    currentItems = [item(agent("ag01", { toolUseId: "agent-call", description: "Audit the parser", state: "completed", reportText: "Verified parser invariants", updatedAt: 8 }))];
    tree = render();
    const updatedHtml = renderToStaticMarkup(tree);
    expect(updatedHtml).toContain("Verified parser invariants");

    const backToList = elements(tree).find((el) => el.type === "button" && el.props.children === "全部后台任务")!;
    backToList.props.onClick();
    tree = render();
    const listHtml = renderToStaticMarkup(tree);
    expect(listHtml).toContain("figure-review");
    expect(listHtml).toContain("Audit the parser");
    expect(listHtml).toContain("Start dev server");

    elements(tree)[0]!.props.onClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("subagent actual model rendering", () => {
  it("shows the raw model in markers and keeps it in the accessible name", () => {
    const html = renderToStaticMarkup(createElement(BackgroundTaskMarker, {
      item: item(agent("ag01", { toolUseId: "agent-call", model: "codex/gpt-6.1-sol" })), task: reviewer, onOpen: vi.fn(),
    }));
    expect(html).toContain('class="subagent-model"');
    expect(html).toContain("模型：codex/gpt-6.1-sol");
    expect(html).not.toContain("默认模型");
  });

  it("uses a newer stream observation ahead of a stale tray model", () => {
    const html = renderToStaticMarkup(createElement(BackgroundTaskMarker, {
      item: item(agent("ag01", { model: "new-model", updatedAt: 20 })),
      task: { ...reviewer, subagent: { ...reviewer.subagent!, model: "old-model", updatedAt: 10 } }, onOpen: vi.fn(),
    }));
    expect(html).toContain("模型：new-model");
    expect(html).not.toContain("old-model");
  });

  it("omits the model when unknown and on Workflow aggregate markers", () => {
    const missing = renderToStaticMarkup(createElement(BackgroundTaskMarker, { item: item(agent("x")), onOpen: vi.fn() }));
    const aggregate = renderToStaticMarkup(createElement(BackgroundTaskMarker, {
      item: item(agent("a1", { workflowRunId: "wf_1", model: "claude/claude-opus-5-5" })), task: workflow, onOpen: vi.fn(),
    }));
    expect(missing).not.toContain('class="subagent-model"');
    expect(aggregate).not.toContain("claude/claude-opus-5-5");
  });

  it("keeps the latest tray model when merging an older full stream report", () => {
    const stream = item(agent("ag01", { toolUseId: "agent-call", updatedAt: 1, model: "old-model", reportText: "Full report" }));
    const updated: BridgeBackgroundTask = { ...reviewer, subagent: { ...reviewer.subagent!, model: "codex/gpt-6.1-sol", updatedAt: 10 } };
    const render = vi.fn((entry: BridgeHistoryItem) => createElement(SubagentCard, { item: entry }));
    const html = renderToStaticMarkup(createElement(BackgroundTasksSheet, {
      sessionId: "A", tasks: [updated], items: [stream], focus: stream, onClose: vi.fn(), renderSubagent: render,
    }));
    expect(html).toContain("codex/gpt-6.1-sol");
    expect(render.mock.calls[0]?.[0].subagent).toMatchObject({ model: "codex/gpt-6.1-sol", reportText: "Full report", toolCount: 7 });
  });

  it("shows each Workflow member's model without labelling the aggregate", () => {
    const models = ["codex/gpt-6.1-sol", "claude/claude-opus-5-5", undefined];
    const run = { ...workflow, workflow: { ...workflow.workflow!, agents: workflow.workflow!.agents.map((child, index) => ({ ...child, ...(models[index] ? { model: models[index] } : {}) })) } };
    const html = renderToStaticMarkup(createElement(BackgroundTasksSheet, {
      sessionId: "A", tasks: [run], items: [], focus: item(agent("a1", { workflowRunId: "wf_1" })), onClose: vi.fn(), renderSubagent: () => null,
    }));
    expect(html.match(/class="subagent-model"/gu)).toHaveLength(2);
    expect(html).toContain("codex/gpt-6.1-sol");
    expect(html).toContain("claude/claude-opus-5-5");
  });
});

describe("background task markers", () => {
  it("labels a workflow member line with its run", () => {
    const html = renderToStaticMarkup(createElement(BackgroundTaskMarker, {
      item: item(agent("a1", { workflowRunId: "wf_1", description: "Draft 2.1" })), task: workflow, onOpen: vi.fn(),
    }));
    expect(html).toContain("figure-review");
    expect(html).not.toContain("Draft 2.1");
    expect(html).toContain("is-running");
  });

  it("falls back to the stream item without a tray entry", () => {
    const html = renderToStaticMarkup(createElement(BackgroundTaskMarker, {
      item: item(agent("x", { description: "Check links", state: "failed", taskKind: "bash" })), onOpen: vi.fn(),
    }));
    expect(html).toContain("后台命令：Check links，失败");
    expect(html).toContain("is-failed");
  });
});
