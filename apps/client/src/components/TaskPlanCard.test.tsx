import type { BridgeTaskPlan } from "@bridge/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskPlanCard } from "./TaskPlanCard.js";

const plan: BridgeTaskPlan = { id: "plan:task-1", updatedAt: 100, items: [
  { content: "Inspect client", status: "completed" },
  { content: "Implement sync", status: "in_progress" },
  { content: "Verify client", status: "pending" },
] };

describe("TaskPlanCard", () => {
  it("renders ordered task text and accessible statuses with an expanded running card", () => {
    const html = renderToStaticMarkup(createElement(TaskPlanCard, { plan }));
    expect(html).toContain('<details class="task-plan-card" open="">');
    expect(html).toContain("1/3 已完成");
    for (const [status, label, content] of [
      ["completed", "已完成", "Inspect client"], ["in_progress", "进行中", "Implement sync"], ["pending", "待处理", "Verify client"],
    ]) {
      expect(html).toContain(`class="task-plan-row ${status}"`);
      expect(html).toContain(`role="img" aria-label="${label}"`);
      expect(html).toContain(content);
    }
    expect(html.indexOf("Inspect client")).toBeLessThan(html.indexOf("Implement sync"));
    expect(html.indexOf("Implement sync")).toBeLessThan(html.indexOf("Verify client"));
    expect(html).toContain("<summary>");
    expect(html).not.toContain("aria-expanded=");
  });

  it("collapses a completed revision and expands a resumed or pending plan", () => {
    const completed = { ...plan, updatedAt: 200, items: plan.items.map((item) => ({ ...item, status: "completed" as const })) };
    expect(TaskPlanCard({ plan }).props.open).toBe(true);
    expect(TaskPlanCard({ plan: completed }).props.open).toBe(false);
    const html = renderToStaticMarkup(createElement(TaskPlanCard, { plan: completed }));
    expect(html).toContain('<details class="task-plan-card is-complete">');
    expect(html).toContain("3/3 已完成");
    expect(html).toContain("Verify client");
    expect(TaskPlanCard({ plan: { ...completed, items: [{ content: "More work", status: "pending" }] } }).props.open).toBe(true);
    expect(TaskPlanCard({ plan: { ...plan, items: [] } }).props.open).toBe(true);
  });

  it("escapes plan text instead of interpreting HTML or Markdown", () => {
    const html = renderToStaticMarkup(createElement(TaskPlanCard, { plan: { ...plan, items: [
      { content: '<img src=x onerror="alert(1)"> **task** [link](https://example.com)', status: "pending" },
    ] } }));
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; **task** [link](https://example.com)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
  });
});
