import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findClaudeDesktopSessionId, listClaudeDesktopSessions } from "./claude-desktop-sessions.js";

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
    expect(detachedSession?.parentSessionId).toBeUndefined();
  });
});
