import type { BridgeSessionInfo } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import {
  archivedForkGroupKey,
  archivedForkGroupLabel,
  forkGroupToggleLabel,
  partitionSessionForks,
} from "./conversation-timeline.js";
import {
  collapseProjects,
  expandAllProjects,
  expandProject,
  getSessionAncestorIds,
  groupProjectSessionFamilies,
  moveProject,
  orderProjects,
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
      forks: f.forks.map((child) => child.primary.sessionId),
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

  it("keeps four levels of forks under their direct parents regardless of input order", () => {
    const sessions = [
      { sessionId: "great-grandchild", parentSessionId: "grandchild", lastActivityAt: 900 },
      { sessionId: "child", parentSessionId: "root", lastActivityAt: 200 },
      { sessionId: "root", lastActivityAt: 100 },
      { sessionId: "grandchild", parentSessionId: "child", lastActivityAt: 300 },
    ];

    expect(groupProjectSessionFamilies(sessions)).toEqual([{
      primary: sessions[2],
      lastActivityAt: 900,
      forks: [{
        primary: sessions[1],
        lastActivityAt: 900,
        forks: [{
          primary: sessions[3],
          lastActivityAt: 900,
          forks: [{ primary: sessions[0], lastActivityAt: 900, forks: [] }],
        }],
      }],
    }]);
  });

  it("promotes an active fork with an archived or missing parent to a root", () => {
    const sessions = [
      { sessionId: "root", lastActivityAt: 100 },
      { sessionId: "archived-parent", parentSessionId: "root", lastActivityAt: 200, archivedAt: 250 },
      { sessionId: "active-child", parentSessionId: "archived-parent", lastActivityAt: 300 },
      { sessionId: "grandchild", parentSessionId: "active-child", lastActivityAt: 500 },
      { sessionId: "orphan", parentSessionId: "missing", lastActivityAt: 400 },
    ];

    expect(groupProjectSessionFamilies(sessions.filter((session) => !session.archivedAt))).toEqual([
      {
        primary: sessions[2],
        lastActivityAt: 500,
        forks: [{ primary: sessions[3], lastActivityAt: 500, forks: [] }],
      },
      { primary: sessions[4], lastActivityAt: 400, forks: [] },
      { primary: sessions[0], lastActivityAt: 100, forks: [] },
    ]);
    expect(groupProjectSessionFamilies(sessions.filter((session) => session.archivedAt))).toEqual([
      { primary: sessions[1], lastActivityAt: 200, forks: [] },
    ]);
  });

  it("sorts roots and sibling branches by the latest activity in each subtree", () => {
    const sessions = [
      { sessionId: "root", lastActivityAt: 100 },
      { sessionId: "recent-child", parentSessionId: "root", lastActivityAt: 600 },
      { sessionId: "older-child", parentSessionId: "root", lastActivityAt: 200 },
      { sessionId: "older-grandchild", parentSessionId: "older-child", lastActivityAt: 300 },
      { sessionId: "latest-grandchild", parentSessionId: "older-child", lastActivityAt: 900 },
      { sessionId: "other-root", lastActivityAt: 800 },
    ];
    const originalOrder = sessions.map((session) => session.sessionId);
    const families = groupProjectSessionFamilies(sessions);

    expect(families.map((family) => family.primary.sessionId)).toEqual(["root", "other-root"]);
    expect(families[0]!.forks.map((family) => family.primary.sessionId)).toEqual([
      "older-child", "recent-child",
    ]);
    expect(families[0]!.forks[0]!.forks.map((family) => family.primary.sessionId)).toEqual([
      "latest-grandchild", "older-grandchild",
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(originalOrder);
    expect(sessions[0]!.lastActivityAt).toBe(100);
  });

  it("counts only roots for previews while retaining their nested branches", () => {
    const sessions = [
      { sessionId: "root", lastActivityAt: 100 },
      { sessionId: "child", parentSessionId: "root", lastActivityAt: 200 },
      { sessionId: "grandchild", parentSessionId: "child", lastActivityAt: 900 },
      { sessionId: "root-2", lastActivityAt: 800 },
      { sessionId: "root-3", lastActivityAt: 700 },
      { sessionId: "root-4", lastActivityAt: 600 },
    ];
    const preview = previewProjectSessionFamilies(sessions);

    expect(preview.totalCount).toBe(4);
    expect(preview.hiddenCount).toBe(1);
    expect(preview.preview.map((family) => family.primary.sessionId)).toEqual(["root", "root-2", "root-3"]);
    expect(preview.preview[0]!.forks[0]!.forks[0]!.primary.sessionId).toBe("grandchild");
    expect(previewProjectSessionFamilies(sessions, 0)).toEqual({ preview: [], totalCount: 4, hiddenCount: 4 });
  });

  it("finds every available ancestor for selection, activity, and new-fork expansion", () => {
    const sessions = [
      { sessionId: "root", lastActivityAt: 100 },
      { sessionId: "child", parentSessionId: "root", lastActivityAt: 200 },
      { sessionId: "grandchild", parentSessionId: "child", lastActivityAt: 300 },
      { sessionId: "great-grandchild", parentSessionId: "grandchild", lastActivityAt: 400 },
      { sessionId: "orphan", parentSessionId: "missing", lastActivityAt: 500 },
      { sessionId: "orphan-child", parentSessionId: "orphan", lastActivityAt: 600 },
    ];

    expect(getSessionAncestorIds(sessions, "great-grandchild")).toEqual(["grandchild", "child", "root"]);
    expect(getSessionAncestorIds(sessions, "root")).toEqual([]);
    expect(getSessionAncestorIds(sessions, "orphan-child")).toEqual(["orphan"]);
    expect(getSessionAncestorIds(sessions, "orphan")).toEqual([]);
  });

  it("does not let an archived sidechat boost an active parent above newer active sessions", () => {
    const sessions = [
      { sessionId: "older-parent", lastActivityAt: 100 },
      { sessionId: "archived-btw", parentSessionId: "older-parent", lastActivityAt: 900, archivedAt: 950 },
      { sessionId: "newer-active", lastActivityAt: 300 },
    ];
    const families = groupProjectSessionFamilies(sessions);
    expect(families.map((family) => family.primary.sessionId)).toEqual(["newer-active", "older-parent"]);
    expect(families[1]!.lastActivityAt).toBe(100);
    expect(families[1]!.forks.map((fork) => fork.primary.sessionId)).toEqual(["archived-btw"]);
  });
});

describe("project order the user sets", () => {
  it("keeps placed projects in place and leads with projects not placed yet", () => {
    expect(orderProjects(["new", "b", "a", "c"], ["a", "b", "c"])).toEqual(["new", "a", "b", "c"]);
  });

  it("drops placed projects that no longer have visible sessions", () => {
    expect(orderProjects(["c", "a"], ["a", "gone", "c"])).toEqual(["a", "c"]);
  });

  it("follows the given order until anything is placed", () => {
    expect(orderProjects(["b", "a"], [])).toEqual(["b", "a"]);
  });

  it("moves a project to the top, up or down", () => {
    const order = ["a", "b", "c", "d"];
    expect(moveProject(order, "c", 0)).toEqual(["c", "a", "b", "d"]);
    expect(moveProject(order, "c", 1)).toEqual(["a", "c", "b", "d"]);
    expect(moveProject(order, "b", 2)).toEqual(["a", "c", "b", "d"]);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });
});

describe("session order inside a project", () => {
  it("supports an explicit recency selector for sessions and fork families", () => {
    const sessions = [
      { sessionId: "replied", lastActivityAt: 500 },
      { sessionId: "opened-on-phone", lastActivityAt: 100 },
      { sessionId: "fork-opened", parentSessionId: "replied", lastActivityAt: 50 },
    ];
    const opened: Record<string, number> = { "opened-on-phone": 900, "fork-opened": 700 };
    const recency = (session: { sessionId: string; lastActivityAt: number }) => Math.max(session.lastActivityAt, opened[session.sessionId] ?? 0);
    expect(sortProjectSessionsByRecent(sessions, recency).map((session) => session.sessionId))
      .toEqual(["opened-on-phone", "fork-opened", "replied"]);
    const families = groupProjectSessionFamilies(sessions, recency);
    expect(families.map((family) => [family.primary.sessionId, family.lastActivityAt])).toEqual([
      ["opened-on-phone", 900], ["replied", 700],
    ]);
    expect(previewProjectSessionFamilies(sessions, 1, recency).preview[0]!.primary.sessionId).toBe("opened-on-phone");
  });
});

describe("partitionSessionForks", () => {
  const baseParent: BridgeSessionInfo = {
    sessionId: "parent",
    projectId: "proj-1",
    projectName: "Bridge",
    cwd: "/tmp/bridge",
    title: "Parent session",
    source: "desktop",
    ownership: "DESKTOP_NATIVE_IDLE",
    transport: "claude-desktop-native",
    turnState: "idle",
    lastActivityAt: 1000,
    pendingCount: 0,
  };

  it("separates active forks from archived sidechats and supplements same-project archived regular forks", () => {
    const activeFork: BridgeSessionInfo = { ...baseParent, sessionId: "fork-active", title: "Active fork", parentSessionId: "parent", lastActivityAt: 800 };
    const archivedSidechat: BridgeSessionInfo = { ...baseParent, sessionId: "btw-archived", title: "btw: archived", parentSessionId: "parent", sidechat: true, archivedAt: 700, lastActivityAt: 700 };
    const archivedFork: BridgeSessionInfo = { ...baseParent, sessionId: "fork-archived", title: "Archived fork", parentSessionId: "parent", archivedAt: 900, lastActivityAt: 900 };
    const otherProjectArchivedFork: BridgeSessionInfo = { ...baseParent, sessionId: "fork-other-proj", projectId: "proj-2", title: "Other project fork", parentSessionId: "parent", archivedAt: 950, lastActivityAt: 950 };
    const [family] = groupProjectSessionFamilies([baseParent, activeFork, archivedSidechat]);

    const partitioned = partitionSessionForks(
      baseParent,
      family!.forks,
      [baseParent, activeFork, archivedSidechat, archivedFork, otherProjectArchivedFork],
      false,
    );

    expect(partitioned.activeForks.map((f) => f.primary.sessionId)).toEqual(["fork-active"]);
    expect(partitioned.archivedForks.map((f) => f.primary.sessionId)).toEqual(["fork-archived", "btw-archived"]);
    expect(forkGroupToggleLabel(partitioned.activeForks)).toBe("1 个 Fork 分支");
    expect(archivedForkGroupLabel(partitioned.archivedForks)).toBe("2 个已归档分支与侧聊");
    expect(archivedForkGroupLabel([partitioned.archivedForks[0]!])).toBe("1 个已归档分支");
    expect(archivedForkGroupLabel([partitioned.archivedForks[1]!])).toBe("1 个已结束侧聊");
    expect(archivedForkGroupKey("parent")).toBe("archived:parent");
  });

  it("keeps a live fork below an archived sidechat in the active bucket without duplicating it in history", () => {
    const archivedSidechat: BridgeSessionInfo = { ...baseParent, sessionId: "btw-archived", parentSessionId: "parent", sidechat: true, archivedAt: 700 };
    const liveFork: BridgeSessionInfo = { ...baseParent, sessionId: "live-fork", parentSessionId: "btw-archived", turnState: "running", lastActivityAt: 1100 };
    const sessions = [baseParent, archivedSidechat, liveFork];
    const [family] = groupProjectSessionFamilies(sessions);
    const partitioned = partitionSessionForks(baseParent, family!.forks, sessions, false);

    expect(partitioned.activeForks.map(fork => fork.primary.sessionId)).toEqual(["live-fork"]);
    expect(forkGroupToggleLabel(partitioned.activeForks)).toBe("1 个 Fork 分支");
    expect(partitioned.archivedForks.map(fork => fork.primary.sessionId)).toEqual(["btw-archived"]);
    expect(partitioned.archivedForks[0]!.forks).toEqual([]);
    expect(family!.forks[0]!.forks[0]!.primary).toBe(liveFork);
  });

  it("keeps archived children inline without a secondary bucket in archived list views and honors search queries", () => {
    const archivedParent: BridgeSessionInfo = { ...baseParent, archivedAt: 500 };
    const archivedSidechat: BridgeSessionInfo = { ...baseParent, sessionId: "btw-archived", title: "btw: DNS rule", parentSessionId: "parent", sidechat: true, archivedAt: 700, lastActivityAt: 700 };
    const archivedFork: BridgeSessionInfo = { ...baseParent, sessionId: "fork-archived", title: "IPv6 routing", parentSessionId: "parent", archivedAt: 900, lastActivityAt: 900 };
    const [archivedFamily] = groupProjectSessionFamilies([archivedParent, archivedSidechat, archivedFork]);

    const inline = partitionSessionForks(archivedParent, archivedFamily!.forks, [archivedParent, archivedSidechat, archivedFork], true);
    expect(inline.activeForks.map((f) => f.primary.sessionId)).toEqual(["fork-archived", "btw-archived"]);
    expect(inline.archivedForks).toEqual([]);

    const filtered = partitionSessionForks(baseParent, [], [baseParent, archivedSidechat, archivedFork], false, "ipv6");
    expect(filtered.activeForks).toEqual([]);
    expect(filtered.archivedForks.map((f) => f.primary.sessionId)).toEqual(["fork-archived"]);
  });
});
