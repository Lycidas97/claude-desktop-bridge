import type { BridgeBackgroundTask, BridgeHistoryItem, BridgeSubagentSummary } from "@bridge/protocol";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BackgroundTaskMarker, BackgroundTasksSheet, findBackgroundTask } from "./BackgroundTasks.js";

vi.mock("../mobile/MobileSheet.js", () => ({
  MobileSheet: ({ title, children }: { title: string; children: ReactNode }) => createElement("section", { "aria-label": title }, children),
}));

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

function sheet(focus?: BridgeHistoryItem, items: BridgeHistoryItem[] = []) {
  const rendered: BridgeHistoryItem[] = [];
  const html = renderToStaticMarkup(createElement(BackgroundTasksSheet, {
    sessionId: "A", tasks: [workflow, reviewer, shell], items,
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
    expect(html).not.toContain("%");
  });

  it("opens a focused subagent with the stream's full report and the tray's state", () => {
    const streamItem = item(agent("ag01", { toolUseId: "agent-call", state: "completed", reportText: "Full report" }));
    const { rendered } = sheet(streamItem, [streamItem]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.subagent).toMatchObject({ agentId: "ag01", reportText: "Full report", state: "running" });
  });

  it("shows the stream item's own card when its task aged out of the tray", () => {
    const old = item(agent("old", { toolUseId: "old-call", state: "completed", reportText: "Earlier" }));
    const { html, rendered } = sheet(old);
    expect(rendered).toEqual([old]);
    expect(html).toContain("Earlier");
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
    const render = vi.fn((_entry: BridgeHistoryItem) => null);
    const html = renderToStaticMarkup(createElement(BackgroundTasksSheet, {
      sessionId: "A", tasks: [updated], items: [stream], focus: stream, onClose: vi.fn(), renderSubagent: render,
    }));
    expect(html).toContain("codex/gpt-6.1-sol");
    expect(render.mock.calls[0]?.[0].subagent).toMatchObject({ model: "codex/gpt-6.1-sol", reportText: "Full report" });
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
