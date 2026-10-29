import { describe, expect, it } from "vitest";
import {
  collapseProjects,
  expandAllProjects,
  expandProject,
  groupProjectSessionFamilies,
  previewProjectSessionFamilies,
  previewProjectSessions,
  sortProjectSessionsByRecent,
  toggleCollapsedProject,
} from "./project-groups.js";

describe("project group collapse state", () => {
  it("collapses and expands projects independently", () => {
    const first = toggleCollapsedProject(new Set<string>(), "project-a");
    const second = toggleCollapsedProject(first, "project-b");

    expect([...second]).toEqual(["project-a", "project-b"]);
    expect([...toggleCollapsedProject(second, "project-a")]).toEqual(["project-b"]);
  });

  it("expands a newly selected project without changing other groups", () => {
    const collapsed = new Set(["project-a", "project-b"]);

    expect([...expandProject(collapsed, "project-a")]).toEqual(["project-b"]);
    expect(expandProject(collapsed, "project-c")).toBe(collapsed);
  });

  it("collapses and expands every visible project in one action", () => {
    expect([...collapseProjects(["project-a", "project-b"])]).toEqual(["project-a", "project-b"]);
    expect(expandAllProjects()).toEqual(new Set());
  });

  it("limits inline group preview to the 3 most recent sessions and reports remaining count", () => {
    const sessions = [
      { id: "s1", lastActivityAt: 100 },
      { id: "s2", lastActivityAt: 500 },
      { id: "s3", lastActivityAt: 300 },
      { id: "s4", lastActivityAt: 400 },
      { id: "s5", lastActivityAt: 200 },
    ];

    const result = previewProjectSessions(sessions);
    expect(result.preview.map((item) => item.id)).toEqual(["s2", "s4", "s3"]);
    expect(result.totalCount).toBe(5);
    expect(result.hiddenCount).toBe(2);
    expect(sortProjectSessionsByRecent(sessions).map((item) => item.id)).toEqual([
      "s2",
      "s4",
      "s3",
      "s5",
      "s1",
    ]);
  });

  it("nests forked sessions under their primary parent and counts families for preview", () => {
    const sessions = [
      { sessionId: "main-1", lastActivityAt: 100 },
      { sessionId: "fork-1a", parentSessionId: "main-1", lastActivityAt: 500 },
      { sessionId: "fork-1b", parentSessionId: "main-1", lastActivityAt: 300 },
      { sessionId: "main-2", lastActivityAt: 400 },
      { sessionId: "orphan-fork", parentSessionId: "missing-parent", lastActivityAt: 200 },
    ];

    const families = groupProjectSessionFamilies(sessions);
    expect(families.map((f) => ({
      primary: f.primary.sessionId,
      forks: f.forks.map((child) => child.sessionId),
      lastActivityAt: f.lastActivityAt,
    }))).toEqual([
      { primary: "main-1", forks: ["fork-1a", "fork-1b"], lastActivityAt: 500 },
      { primary: "main-2", forks: [], lastActivityAt: 400 },
      { primary: "orphan-fork", forks: [], lastActivityAt: 200 },
    ]);

    const preview = previewProjectSessionFamilies(sessions, 2);
    expect(preview.totalCount).toBe(3);
    expect(preview.hiddenCount).toBe(1);
    expect(preview.preview.map((f) => f.primary.sessionId)).toEqual(["main-1", "main-2"]);
  });
});

