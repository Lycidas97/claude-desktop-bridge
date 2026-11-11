import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeDesktopProfileForPath, findClaudeDesktopSessionId, listClaudeDesktopSessions, listClaudeDesktopSessionState } from "./claude-desktop-sessions.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Claude Desktop session catalog", () => {
  it("reads session metadata without opening or controlling Claude", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-desktop-session-"));
    directories.push(root);
    const nested = join(root, "profile", "project");
    await mkdir(nested, { recursive: true });
    await Promise.all([
      writeFile(join(nested, "local_old.json"), JSON.stringify({
        sessionId: "local_old",
        cliSessionId: "cli-session",
        cwd: "/work/project",
        lastFocusedAt: 100,
      })),
      writeFile(join(nested, "local_current.json"), JSON.stringify({
        sessionId: "local_current",
        cliSessionId: "cli-session",
        cwd: "/work/project",
        lastFocusedAt: 200,
        model: "claude-fable-5[1m]",
        effort: "high",
      })),
    ]);

    await expect(findClaudeDesktopSessionId([root], "cli-session")).resolves.toBe("local_current");
    const sessions = await listClaudeDesktopSessions([root]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      sessionId: "local_current",
      model: "claude-fable-5[1m]",
      effort: "high",
    });
  });

  it("preserves profile provenance and ultracode without exposing a profile path", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-desktop-profiles-"));
    directories.push(root);
    const official = join(root, "Application Support", "Claude", "claude-code-sessions");
    const thirdParty = join(root, "Application Support", "Claude-3p", "claude-code-sessions");
    await Promise.all([mkdir(official, { recursive: true }), mkdir(thirdParty, { recursive: true })]);
    await Promise.all([
      writeFile(join(official, "local_official.json"), JSON.stringify({
        sessionId: "local_official",
        cliSessionId: "official-session",
        cwd: "/work/official",
        lastFocusedAt: 200,
        model: "claude-opus-5",
        sessionSettings: { ultracode: true },
      })),
      writeFile(join(thirdParty, "local_3p.json"), JSON.stringify({
        sessionId: "local_3p",
        cliSessionId: "third-party-session",
        cwd: "/work/third-party",
        lastFocusedAt: 100,
        sessionSettings: { ultracode: false },
      })),
    ]);

    const sessions = await listClaudeDesktopSessions([official, thirdParty]);
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "local_official",
        profile: "claude",
        ultracode: true,
      }),
      expect.objectContaining({
        sessionId: "local_3p",
        profile: "claude-3p",
        ultracode: false,
      }),
    ]);
    expect(JSON.stringify(sessions)).not.toContain(root);
    expect(claudeDesktopProfileForPath("C:\\Users\\test\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude-code-sessions\\local_1.json")).toBe("claude");
    expect(claudeDesktopProfileForPath("C:\\Users\\test\\AppData\\Local\\Claude-3p\\claude-code-sessions\\local_2.json")).toBe("claude-3p");
  });

  it.each(["flag", "index"])("keeps active nested forks visible when their intermediate parent is archived by %s", async (archiveSource) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-desktop-nested-forks-"));
    directories.push(root);
    const records = [
      { sessionId: "local_root", cliSessionId: "root-cli", title: "第四章" },
      { sessionId: "local_archived", cliSessionId: "archived-cli", isArchived: true, forkedFromSessionId: "local_root" },
      { sessionId: "local_archived2", cliSessionId: "archived2-cli", isArchived: true, forkedFromSessionId: "local_archived" },
      { sessionId: "local_gemini", cliSessionId: "gemini-cli", title: "Gemini 绘图", forkedFromSessionId: "local_archived2", spawnedFrom: { name: "fork-2" } },
      { sessionId: "local_leaf", cliSessionId: "leaf-cli", forkedFromSessionId: "local_gemini" },
      { sessionId: "local_orphan", cliSessionId: "orphan-cli", forkedFromSessionId: "local_archived_orphan" },
      { sessionId: "local_archived_orphan", cliSessionId: "archived-orphan-cli", isArchived: true },
    ];
    if (archiveSource === "index") {
      await writeFile(join(root, "archived-sessions.idx"), JSON.stringify({ archived: records.filter((record) => record.isArchived).map((record) => record.sessionId) }));
    }
    await Promise.all(records.map((record) => writeFile(join(root, `${record.sessionId}.json`), JSON.stringify({
      cwd: "/work/thesis",
      ...record,
      ...(archiveSource === "index" ? { isArchived: false } : {}),
    }))));

    const state = await listClaudeDesktopSessionState([root]);
    expect(state.sessions.find((session) => session.cliSessionId === "gemini-cli")).toMatchObject({
      title: "Gemini 绘图",
      parentSessionId: "root-cli",
      forkLabel: "fork-2",
    });
    expect(state.sessions.find((session) => session.cliSessionId === "leaf-cli")?.parentSessionId).toBe("gemini-cli");
    expect(state.sessions.find((session) => session.cliSessionId === "orphan-cli")?.parentSessionId).toBe("archived-orphan-cli");
    expect(state.archivedCliSessionIds.has("gemini-cli")).toBe(false);
    expect(state.archivedCliSessionIds.has("archived-cli")).toBe(true);
  });

  it("resolves fork parent cliSessionId and forkLabel while respecting detached sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-desktop-forks-"));
    directories.push(root);
    await Promise.all([
      writeFile(join(root, "local_parent.json"), JSON.stringify({
        sessionId: "local_parent_desktop_id",
        cliSessionId: "parent-cli-uuid",
        cwd: "/work/thesis",
        title: "第四章叙事与分析设计讨论",
        lastFocusedAt: 100,
      })),
      writeFile(join(root, "local_fork1.json"), JSON.stringify({
        sessionId: "local_fork1",
        cliSessionId: "fork1-cli-uuid",
        cwd: "/work/thesis",
        title: "第四章叙事与分析设计讨论",
        lastFocusedAt: 200,
        forkedFromSessionId: "local_parent_desktop_id",
        spawnedFrom: {
          sessionId: "local_parent_desktop_id",
          title: "第四章叙事与分析设计讨论 (fork)",
          sideSession: true,
          userFork: true,
          name: "fork-2",
        },
      })),
      writeFile(join(root, "local_detached.json"), JSON.stringify({
        sessionId: "local_detached",
        cliSessionId: "detached-cli-uuid",
        cwd: "/work/thesis",
        title: "独立出来的会话",
        lastFocusedAt: 150,
        forkedFromSessionId: "local_parent_desktop_id",
        detached: true,
      })),
    ]);

    const sessions = await listClaudeDesktopSessions([root]);
    const forkSession = sessions.find((s) => s.cliSessionId === "fork1-cli-uuid");
    const detachedSession = sessions.find((s) => s.cliSessionId === "detached-cli-uuid");
    expect(forkSession).toMatchObject({
      cliSessionId: "fork1-cli-uuid",
      parentSessionId: "parent-cli-uuid",
      forkLabel: "fork-2",
      title: "第四章叙事与分析设计讨论 (fork)",
    });
    expect(forkSession?.sidechat).toBeUndefined();
    expect(detachedSession?.parentSessionId).toBeUndefined();
  });

  it("exposes /btw sidechats with sidechat flag, native forkLabel, direct parent, and raw title", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-desktop-btw-"));
    directories.push(root);
    await Promise.all([
      writeFile(join(root, "local_grandparent.json"), JSON.stringify({
        sessionId: "local_grandparent",
        cliSessionId: "grandparent-cli",
        cwd: "/work/server",
        title: "244 透明网关多拨架构",
        lastFocusedAt: 100,
      })),
      writeFile(join(root, "local_archived_parent.json"), JSON.stringify({
        sessionId: "local_archived_parent",
        cliSessionId: "archived-parent-cli",
        cwd: "/work/server",
        title: "244 透明网关多拨架构 (fork)",
        isArchived: true,
        forkedFromSessionId: "local_grandparent",
        lastFocusedAt: 150,
      })),
      writeFile(join(root, "local_btw_named.json"), JSON.stringify({
        sessionId: "local_btw_named",
        cliSessionId: "btw-named-cli",
        cwd: "/work/server",
        title: "btw: 能不能把 ipv6 的转发也搞回来",
        lastFocusedAt: 300,
        forkedFromSessionId: "local_grandparent",
        spawnedFrom: {
          sessionId: "local_grandparent",
          title: "244 透明网关多拨架构 (fork)",
          sideSession: true,
          userFork: true,
          btw: true,
          name: "fork-4",
        },
      })),
      writeFile(join(root, "local_btw_archived.json"), JSON.stringify({
        sessionId: "local_btw_archived",
        cliSessionId: "btw-archived-cli",
        cwd: "/work/server",
        title: "Side chat",
        isArchived: true,
        lastFocusedAt: 200,
        forkedFromSessionId: "local_archived_parent",
        spawnedFrom: {
          sessionId: "local_archived_parent",
          sideSession: true,
          userFork: true,
          btw: true,
        },
      })),
      writeFile(join(root, "local_btw_active_under_archived.json"), JSON.stringify({
        sessionId: "local_btw_active_under_archived",
        cliSessionId: "btw-active-under-archived-cli",
        cwd: "/work/server",
        title: "",
        isArchived: false,
        lastFocusedAt: 250,
        forkedFromSessionId: "local_archived_parent",
        spawnedFrom: {
          sessionId: "local_archived_parent",
          title: "244 透明网关多拨架构 (fork)",
          sideSession: true,
          userFork: true,
          btw: true,
        },
      })),
      writeFile(join(root, "local_btw_detached.json"), JSON.stringify({
        sessionId: "local_btw_detached",
        cliSessionId: "btw-detached-cli",
        cwd: "/work/server",
        title: "btw: 已脱离父会话的侧聊",
        isArchived: false,
        detached: true,
        lastFocusedAt: 180,
        forkedFromSessionId: "local_grandparent",
        spawnedFrom: {
          sessionId: "local_grandparent",
          sideSession: true,
          userFork: true,
          btw: true,
        },
      })),
    ]);

    const state = await listClaudeDesktopSessionState([root]);
    expect(state.sessions.find((s) => s.cliSessionId === "btw-named-cli")).toMatchObject({
      cliSessionId: "btw-named-cli",
      parentSessionId: "grandparent-cli",
      forkLabel: "fork-4",
      sidechat: true,
      title: "btw: 能不能把 ipv6 的转发也搞回来",
    });
    expect(state.sessions.find((s) => s.cliSessionId === "btw-active-under-archived-cli")).toMatchObject({
      cliSessionId: "btw-active-under-archived-cli",
      parentSessionId: "grandparent-cli",
      forkLabel: "btw",
      sidechat: true,
      title: "244 透明网关多拨架构",
    });
    const detachedBtw = state.sessions.find((s) => s.cliSessionId === "btw-detached-cli");
    expect(detachedBtw?.parentSessionId).toBeUndefined();
    expect(detachedBtw?.sidechat).toBeUndefined();
    expect(state.archivedCliSessionIds.has("btw-named-cli")).toBe(false);
    expect(state.archivedSessions.find((s) => s.cliSessionId === "btw-archived-cli")).toMatchObject({
      cliSessionId: "btw-archived-cli",
      parentSessionId: "archived-parent-cli",
      forkLabel: "btw",
      sidechat: true,
      title: "Side chat",
    });
    expect(state.archivedCliSessionIds.has("btw-archived-cli")).toBe(true);
  });

  it("maps custom sidebar groups from claude_desktop_config.json onto sessions and their forks", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-desktop-groups-"));
    directories.push(root);
    const sessionsRoot = join(root, "Claude-3p", "claude-code-sessions");
    await mkdir(sessionsRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, "Claude-3p", "claude_desktop_config.json"), JSON.stringify({
        preferences: {
          epitaxyPrefs: {
            "dframe-group-scopes": {
              "account/workspace": {
                groups: [
                  { id: "cg-server", name: "服务器管理" },
                  { id: "cg-repro", name: "reproAPA" },
                ],
                assignments: {
                  "code:local_server_1": "cg-server",
                  "code:local_repro_1": "cg-repro",
                },
              },
            },
          },
        },
      })),
      writeFile(join(sessionsRoot, "local_server_1.json"), JSON.stringify({
        sessionId: "local_server_1",
        cliSessionId: "cli-server-1",
        cwd: "/work/misc",
        title: "244配置",
        lastFocusedAt: 300,
      })),
      writeFile(join(sessionsRoot, "local_server_fork.json"), JSON.stringify({
        sessionId: "local_server_fork",
        cliSessionId: "cli-server-fork",
        cwd: "/work/misc",
        title: "244配置 (fork)",
        forkedFromSessionId: "local_server_1",
        lastFocusedAt: 250,
      })),
      writeFile(join(sessionsRoot, "local_repro_1.json"), JSON.stringify({
        sessionId: "local_repro_1",
        cliSessionId: "cli-repro-1",
        cwd: "/work/thesis",
        title: "polyApipe 审稿材料整理",
        lastFocusedAt: 200,
      })),
      writeFile(join(sessionsRoot, "local_ungrouped.json"), JSON.stringify({
        sessionId: "local_ungrouped",
        cliSessionId: "cli-ungrouped",
        cwd: "/work/thesis",
        title: "普通会话",
        lastFocusedAt: 100,
      })),
    ]);

    const sessions = await listClaudeDesktopSessions([sessionsRoot]);
    expect(sessions.find((s) => s.cliSessionId === "cli-server-1")).toMatchObject({
      groupId: "cg-server",
      groupName: "服务器管理",
    });
    expect(sessions.find((s) => s.cliSessionId === "cli-server-fork")).toMatchObject({
      groupId: "cg-server",
      groupName: "服务器管理",
    });
    expect(sessions.find((s) => s.cliSessionId === "cli-repro-1")).toMatchObject({
      groupId: "cg-repro",
      groupName: "reproAPA",
    });
    expect(sessions.find((s) => s.cliSessionId === "cli-ungrouped")?.groupId).toBeUndefined();
  });
});
