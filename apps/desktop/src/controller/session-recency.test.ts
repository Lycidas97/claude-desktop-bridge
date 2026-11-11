import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanClaudeCatalog } from "../claude/claude-session-catalog.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("session last-update time", () => {
  it.each([
    { activity: 1_000, transcript: 2_000, archived: false, expected: 2_000 },
    { activity: 4_000, transcript: 2_000, archived: false, expected: 4_000 },
    { activity: undefined, transcript: 2_000, archived: false, expected: 2_000 },
    { activity: undefined, transcript: undefined, archived: false, expected: 0 },
    { activity: 4_000, transcript: undefined, archived: true, expected: 4_000 },
    { activity: undefined, transcript: undefined, archived: true, expected: 0 },
    { activity: undefined, transcript: 2_000, archived: false, expected: 2_000, omitCreatedAt: true },
  ])("ignores focus for activity=$activity transcript=$transcript archived=$archived omitCreatedAt=$omitCreatedAt", async ({ activity, transcript, archived, expected, omitCreatedAt = false }) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-session-recency-"));
    directories.push(root);
    vi.stubEnv("BRIDGE_DISABLE_PROCESS_SCAN", "1");
    const desktop = join(root, "desktop");
    const projects = join(root, "projects");
    const cwd = join(root, "work");
    await Promise.all([mkdir(desktop), mkdir(projects), mkdir(cwd)]);
    const createdAt = Date.now() - 60_000;
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(desktop, "local_recency.json"), JSON.stringify({
      sessionId: "local_recency", cliSessionId: sessionId, cwd,
      ...(!omitCreatedAt ? { createdAt } : {}),
      lastFocusedAt: createdAt + 50_000,
      ...(activity !== undefined ? { lastActivityAt: createdAt + activity } : {}),
      ...(archived ? { isArchived: true } : {}),
    }));
    if (transcript !== undefined) {
      const path = join(projects, `${sessionId}.jsonl`);
      await writeFile(path, `${JSON.stringify({ type: "assistant", uuid: "answer", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } })}\n`);
      await utimes(path, (createdAt + transcript) / 1_000, (createdAt + transcript) / 1_000);
    }
    const catalog = await scanClaudeCatalog({ sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects, desktopSessions: [desktop] }, "linux");
    const session = (archived ? catalog.archivedSessions : catalog.sessions)?.find(candidate => candidate.sessionId === sessionId);
    expect(session).toBeDefined();
    expect(session!.lastActivityAt).toBeCloseTo(createdAt + expected, 0);
  });
});
