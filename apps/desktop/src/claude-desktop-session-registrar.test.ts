import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeDesktopSessionRegistrar,
  parseClaudeDesktopProfiles,
  parseWindowsClaudeDesktopProfiles,
} from "./claude-desktop-session-registrar.js";
import type { ClaudeRuntimePaths } from "./platform.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual, readFile: vi.fn(actual.readFile),
    unlink: async (path: string) => { execFileSync(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", [path]); },
  };
});

const directories: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  if (directories.length) execFileSync(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", directories.splice(0));
});

async function fixture(profileName = "Claude-active"): Promise<{
  root: string;
  paths: ClaudeRuntimePaths;
  profileRoot: string;
  accountDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bridge-desktop-register-"));
  directories.push(root);
  const projects = join(root, ".claude", "projects");
  const profileRoot = join(root, profileName, "claude-code-sessions");
  const accountDir = join(profileRoot, randomUUID(), randomUUID());
  await mkdir(accountDir, { recursive: true });
  await mkdir(projects, { recursive: true });
  await writeFile(join(accountDir, `local_${randomUUID()}.json`), JSON.stringify({
    sessionId: `local_${randomUUID()}`,
    cliSessionId: randomUUID(),
    cwd: root,
    title: "Existing",
    titleSource: "auto",
    createdAt: 1,
    lastActivityAt: 2,
  }), "utf8");
  return {
    root,
    profileRoot,
    accountDir,
    paths: {
      sessions: join(root, ".claude", "sessions"),
      tasks: join(root, ".claude", "tasks"),
      projects,
      desktopSessions: [profileRoot],
    },
  };
}

async function transcript(
  paths: ClaudeRuntimePaths,
  sessionId: string,
  cwd: string,
): Promise<string> {
  const path = join(paths.projects, "project", `${sessionId}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, [
    JSON.stringify({
      type: "user",
      sessionId,
      cwd,
      timestamp: "2026-07-27T01:00:00.000Z",
      message: { role: "user", content: "hello" },
    }),
    "",
  ].join("\n"), "utf8");
  return path;
}

describe("parseClaudeDesktopProfiles", () => {
  it("maps helper user-data directories to their Claude main process", () => {
    const output = [
      "  100     1 /Applications/Claude.app/Contents/MacOS/Claude",
      "  101   100 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process --user-data-dir=/Users/me/Library/Application Support/Claude-3p --lang=en",
      "  200     1 /Applications/Other.app/Contents/MacOS/Other",
      "  201   200 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --user-data-dir=/tmp/not-claude --type=renderer",
    ].join("\n");

    expect(parseClaudeDesktopProfiles(output)).toEqual([{
      pid: 100,
      userDataDir: "/Users/me/Library/Application Support/Claude-3p",
    }]);
  });

  it("maps Windows Claude Helper processes to their Claude.exe profile", () => {
    const output = JSON.stringify([
      {
        ProcessId: 400,
        ParentProcessId: 1,
        Name: "Claude.exe",
        CommandLine: '"C:\\Users\\me\\AppData\\Local\\Programs\\Claude\\Claude.exe"',
      },
      {
        ProcessId: 401,
        ParentProcessId: 400,
        Name: "Claude Helper.exe",
        CommandLine: '"C:\\Users\\me\\AppData\\Local\\Programs\\Claude\\Claude Helper.exe" --type=renderer --user-data-dir="C:\\Users\\me\\AppData\\Roaming\\Claude"',
      },
    ]);

    expect(parseWindowsClaudeDesktopProfiles(output)).toEqual([{
      pid: 400,
      userDataDir: "C:\\Users\\me\\AppData\\Roaming\\Claude",
    }]);
  });
});

describe("ClaudeDesktopSessionRegistrar", () => {
  it("waits for the first trusted transcript before writing metadata", async () => {
    const { paths, profileRoot } = await fixture();
    const sessionId = randomUUID();
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid: 10, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => undefined,
      now: () => 10,
    });

    await expect(registrar.register({
      sessionId,
      cwd: paths.projects,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
    })).resolves.toMatchObject({
      state: "waiting-transcript",
      updatedAt: 10,
    });
  });

  it("writes deterministic metadata once and marks it registered after restart", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture();
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    let pid = 20;
    let now = 100;
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => transcriptPath,
      now: () => now,
    });
    const input = {
      sessionId,
      cwd: root,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
      model: "claude-fable-5",
      effort: "high" as const,
    };

    const first = await registrar.register(input);
    expect(first).toMatchObject({
      state: "restart-required",
      desktopSessionId: `local_${sessionId}`,
      claudePidAtRegistration: 20,
      registeredAt: 100,
    });
    const metadataPath = join(accountDir, `local_${sessionId}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      sessionId: `local_${sessionId}`,
      cliSessionId: sessionId,
      cwd: root,
      originCwd: root,
      title: "Bridge task",
      titleSource: "custom",
      model: "claude-fable-5",
      effort: "high",
      isArchived: false,
    });
    const metadataStat = await stat(metadataPath);
    expect(metadataStat.isFile()).toBe(true);
    if (process.platform !== "win32") expect(metadataStat.mode & 0o777).toBe(0o600);

    now = 200;
    const unchanged = await registrar.register(input, first);
    expect(unchanged).toEqual(first);

    pid = 21;
    const registered = await registrar.register(input, first);
    expect(registered).toMatchObject({
      state: "registered",
      desktopSessionId: `local_${sessionId}`,
      updatedAt: 200,
    });
    expect(registered.claudePidAtRegistration).toBeUndefined();
    // Reconciling an already-registered session must be a no-op: minting a
    // fresh updatedAt here flooded the event log with no-op
    // session.desktop-registration events after every turn.
    now = 300;
    const revisited = await registrar.register(input, registered);
    expect(revisited).toEqual(registered);
    expect(registrar.changed(registered, revisited)).toBe(false);
    expect(await registrar.removeOwned(sessionId, registered)).toBe(true);
    await expect(access(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["codex/gpt-6.1-sol", "mythos-magpie-9189869295"],
    ["antigravity/gemini-4-argon[1m]", "mythos-magpie-1052229916[1m]"],
    ["claude/claude-opus-5-5[1m]", "magpie-2213244526.anthropic.claude-opus-5-5[1m]"],
    ["auto/claude-opus-5-5", "mythos-magpie-1855947975"],
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["mythos-magpie-1052229916[1m]", "mythos-magpie-1052229916[1m]"],
    ["anthropic/magpie-2213244526.anthropic.claude-opus-5-5[1m]", "anthropic/magpie-2213244526.anthropic.claude-opus-5-5[1m]"],
  ])("registers gateway model %s using its native picker value", async (model, nativeModel) => {
    const { paths, profileRoot, accountDir, root } = await fixture("Claude-3p");
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const registrar = new ClaudeDesktopSessionRegistrar({ paths, platform: "darwin", listProfiles: async () => [{ pid: 20, userDataDir: join(profileRoot, "..") }], findTranscript: async () => transcriptPath });
    const input = { sessionId, cwd: root, title: "Configured on phone", createdAt: 1, lastActivityAt: 2, model, effort: "high" as const, permissionMode: "full-access" as const };
    await registrar.register(input);
    expect(JSON.parse(await readFile(join(accountDir, `local_${sessionId}.json`), "utf8"))).toMatchObject({ model: nativeModel, effort: "high", permissionMode: "bypassPermissions" });
  });

  it("preserves official model values and standard permission mode", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture("Claude");
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const registrar = new ClaudeDesktopSessionRegistrar({ paths, platform: "darwin", listProfiles: async () => [{ pid: 20, userDataDir: join(profileRoot, "..") }], findTranscript: async () => transcriptPath });
    const input = { sessionId, cwd: root, title: "Standard session", createdAt: 1, lastActivityAt: 2, model: "custom/vendor-model", permissionMode: "standard" as const };
    await registrar.register(input);
    expect(JSON.parse(await readFile(join(accountDir, `local_${sessionId}.json`), "utf8"))).toMatchObject({ model: "custom/vendor-model", permissionMode: "default" });
  });

  it("keeps changed settings pending until an adopted Desktop session reloads", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture("Claude-3p");
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const metadataPath = join(accountDir, `local_${sessionId}.json`);
    await writeFile(metadataPath, JSON.stringify({ sessionId: `local_${sessionId}`, cliSessionId: sessionId, cwd: root, title: "Adopted", model: "desktop-default", effort: "medium", permissionMode: "default", adoptedFromOtherSurface: true, remoteMcpServersConfig: [] }));
    let pid = 20;
    const registrar = new ClaudeDesktopSessionRegistrar({ paths, platform: "darwin", listProfiles: async () => [{ pid, userDataDir: join(profileRoot, "..") }], findTranscript: async () => transcriptPath, now: () => 100 });
    const input = { sessionId, cwd: root, title: "Adopted", createdAt: 1, lastActivityAt: 2 };
    const original = await registrar.register(input);
    expect(original.state).toBe("registered");
    const configured = { ...input, model: "codex/gpt-6.1-sol", overrideModel: "codex/gpt-6.1-sol", effort: "high" as const, overrideEffort: "high" as const, permissionMode: "full-access" as const };
    const pending = await registrar.register(configured, original);
    expect(pending).toMatchObject({ state: "restart-required", settingsReloadRequired: true, claudePidAtRegistration: 20 });
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({ model: "mythos-magpie-9189869295", effort: "high", permissionMode: "bypassPermissions", adoptedFromOtherSurface: true, remoteMcpServersConfig: [] });
    expect(await registrar.register(configured, pending)).toEqual(pending);
    // Desktop may save its still-loaded values before it exits.
    const stale = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, JSON.stringify({ ...stale, model: "desktop-default", effort: "medium", permissionMode: "default" }, null, 2) + "\n");
    expect(await registrar.register(configured, pending)).toEqual(pending);
    pid = 21;
    const reloaded = await registrar.register(configured, pending);
    expect(reloaded.state).toBe("registered");
    expect(reloaded).not.toHaveProperty("settingsReloadRequired");
    expect(reloaded).not.toHaveProperty("claudePidAtRegistration");
    expect(await registrar.register(configured, reloaded)).toEqual(reloaded);
  });

  it("requires a reload when restoring a registered permission value to the same saved hash", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture("Claude-3p");
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const metadataPath = join(accountDir, `local_${sessionId}.json`);
    const metadata = { sessionId: `local_${sessionId}`, cliSessionId: sessionId, cwd: root, title: "Adopted", permissionMode: "default", adoptedFromOtherSurface: true };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
    const registrar = new ClaudeDesktopSessionRegistrar({ paths, platform: "darwin", listProfiles: async () => [{ pid: 20, userDataDir: join(profileRoot, "..") }], findTranscript: async () => transcriptPath });
    const input = { sessionId, cwd: root, title: "Adopted", createdAt: 1, lastActivityAt: 2, permissionMode: "standard" as const };
    const registered = await registrar.register(input);
    expect(registered.state).toBe("registered");

    // Desktop switches to full access and persists its live value.
    await writeFile(metadataPath, JSON.stringify({ ...metadata, permissionMode: "bypassPermissions" }, null, 2) + "\n");
    const restored = await registrar.register(input, registered);
    expect(JSON.parse(await readFile(metadataPath, "utf8")).permissionMode).toBe("default");
    expect(restored).toMatchObject({ state: "restart-required", settingsReloadRequired: true, claudePidAtRegistration: 20 });
  });

  it("keeps settings pending when a new Desktop process loads stale metadata", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture("Claude-3p");
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const metadataPath = join(accountDir, `local_${sessionId}.json`);
    await writeFile(metadataPath, JSON.stringify({ sessionId: `local_${sessionId}`, cliSessionId: sessionId, cwd: root, title: "Adopted", model: "desktop-default", permissionMode: "default", adoptedFromOtherSurface: true }));
    let pid = 20;
    const registrar = new ClaudeDesktopSessionRegistrar({ paths, platform: "darwin", listProfiles: async () => [{ pid, userDataDir: join(profileRoot, "..") }], findTranscript: async () => transcriptPath });
    const input = { sessionId, cwd: root, title: "Adopted", createdAt: 1, lastActivityAt: 2 };
    const registered = await registrar.register(input);
    const configured = { ...input, overrideModel: "codex/gpt-6.1-sol", permissionMode: "full-access" as const };
    const pending = await registrar.register(configured, registered);
    expect(pending).toMatchObject({ state: "restart-required", claudePidAtRegistration: 20 });
    const desired = JSON.parse(await readFile(metadataPath, "utf8"));

    // The old process saves stale values on exit; its replacement loads them.
    await writeFile(metadataPath, JSON.stringify({ ...desired, model: "desktop-default", permissionMode: "default" }, null, 2) + "\n");
    pid = 21;
    const reapplied = await registrar.register(configured, pending);
    expect(reapplied.state).toBe("restart-required");
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({ model: "mythos-magpie-9189869295", permissionMode: "bypassPermissions" });
    expect((await registrar.register(configured, reapplied)).state).toBe("restart-required");
    expect(reapplied.claudePidAtRegistration).toBe(21);
  });

  it("keeps an adopted session with a distinct native ID pending until reload", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture("Claude-3p");
    const sessionId = randomUUID();
    const desktopSessionId = `local_${randomUUID()}`;
    const transcriptPath = await transcript(paths, sessionId, root);
    const metadataPath = join(accountDir, `${desktopSessionId}.json`);
    await writeFile(metadataPath, JSON.stringify({ sessionId: desktopSessionId, cliSessionId: sessionId, cwd: root, title: "Native session", permissionMode: "default", adoptedFromOtherSurface: true }));
    let pid = 20;
    const registrar = new ClaudeDesktopSessionRegistrar({ paths, platform: "darwin", listProfiles: async () => [{ pid, userDataDir: join(profileRoot, "..") }], findTranscript: async () => transcriptPath });
    const input = { sessionId, cwd: root, title: "Native session", createdAt: 1, lastActivityAt: 2, permissionMode: "standard" as const };
    const registered = await registrar.register(input);
    expect(registered).toMatchObject({ state: "registered", desktopSessionId });
    const configured = { ...input, permissionMode: "full-access" as const };
    const pending = await registrar.register(configured, registered);
    expect(pending).toMatchObject({ state: "restart-required", settingsReloadRequired: true, claudePidAtRegistration: 20 });
    expect(JSON.parse(await readFile(metadataPath, "utf8")).permissionMode).toBe("bypassPermissions");
    const sameProcess = await registrar.register(configured, pending);
    expect(sameProcess).toEqual(pending);
    pid = 21;
    expect((await registrar.register(configured, sameProcess)).state).toBe("registered");
  });

  it.each([false, true])("loads settings written while Desktop is stopped without another restart (fork: %s)", async (fork) => {
    const { paths, profileRoot, accountDir, root } = await fixture("Claude");
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const metadataPath = join(accountDir, `local_${sessionId}.json`);
    let pid: number | undefined = 20;
    const registrar = new ClaudeDesktopSessionRegistrar({ paths, platform: "darwin", listProfiles: async () => pid === undefined ? [] : [{ pid, userDataDir: join(profileRoot, "..") }], findTranscript: async () => transcriptPath });
    const input = { sessionId, cwd: root, title: "Lifecycle", createdAt: 1, lastActivityAt: 2, model: "claude/claude-opus-5-5[1m]", effort: "medium" as const, permissionMode: "standard" as const, ...(fork ? { parentDesktopSessionId: `local_${randomUUID()}`, forkLabel: "review" } : {}) };
    const initial = await registrar.register(input);
    pid = 21;
    const registered = await registrar.register(input, initial);
    expect(registered.state).toBe("registered");
    const fullAccess = { ...input, overrideEffort: "high" as const, permissionMode: "full-access" as const };
    const pending = await registrar.register(fullAccess, registered);
    expect(pending).toMatchObject({ state: "restart-required", settingsReloadRequired: true, claudePidAtRegistration: 21 });
    pid = undefined;
    const stopped = await registrar.register(fullAccess, pending);
    expect(stopped).toEqual(pending);
    const standard = { ...fullAccess, overrideEffort: "max" as const, permissionMode: "standard" as const };
    const savedWhileStopped = await registrar.register(standard, stopped);
    expect(savedWhileStopped).toMatchObject({ state: "restart-required", settingsReloadRequired: true });
    expect(savedWhileStopped).not.toHaveProperty("claudePidAtRegistration");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    expect(metadata).toMatchObject({ model: "claude/claude-opus-5-5[1m]", effort: "max", permissionMode: "default" });
    if (fork) expect(metadata).toMatchObject({ forkedFromSessionId: input.parentDesktopSessionId, spawnedFrom: { sessionId: input.parentDesktopSessionId, name: "review", userFork: true } });
    pid = 22;
    const reloaded = await registrar.register(standard, savedWhileStopped);
    expect(reloaded.state).toBe("registered");
    expect(reloaded).not.toHaveProperty("settingsReloadRequired");
    expect(reloaded).not.toHaveProperty("claudePidAtRegistration");
    expect(await registrar.register(standard, reloaded)).toEqual(reloaded);
  });

  it.each([false, true])("checks transcript titles without reading the entire file (existing title: %s)", async (existingTitle) => {
    const { paths, profileRoot, root } = await fixture();
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const original = await readFile(transcriptPath, "utf8");
    const padding = `${JSON.stringify({ type: "progress", text: "x".repeat(1_000) })}\n`.repeat(2_000);
    // Split the marker across a stream chunk and keep it outside either validation probe.
    const titleOffset = 1024 * 1024 + 64 * 1024 - 8;
    const prefix = original + "\n".repeat(titleOffset - Buffer.byteLength(original));
    const before = existingTitle
      ? `${prefix}${JSON.stringify({ type: "custom-title", customTitle: "Keep this title", sessionId })}\n${padding}`
      : `${original}${padding.trimEnd()}`;
    await writeFile(transcriptPath, before);
    vi.mocked(fs.readFile).mockClear();
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid: 20, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => transcriptPath,
      now: () => 100,
    });

    expect((await registrar.register({
      sessionId,
      cwd: root,
      title: "  Bridge task  ",
      createdAt: 1,
      lastActivityAt: 2,
    })).state).toBe("restart-required");
    const fullTranscriptReads = vi.mocked(fs.readFile).mock.calls.filter(([path]) => path === transcriptPath);
    const after = await readFile(transcriptPath, "utf8");
    if (existingTitle) {
      expect(after).toBe(before);
    } else {
      expect(after.slice(0, before.length + 1)).toBe(`${before}\n`);
      expect(JSON.parse(after.slice(before.length + 1))).toMatchObject({
        type: "custom-title", customTitle: "Bridge task", sessionId,
      });
    }
    expect(fullTranscriptReads).toHaveLength(0);
  });

  it("fails closed when the active profile has multiple account directories", async () => {
    const { paths, profileRoot, root } = await fixture();
    const second = join(profileRoot, randomUUID(), randomUUID());
    await mkdir(second, { recursive: true });
    await writeFile(join(second, `local_${randomUUID()}.json`), JSON.stringify({
      sessionId: `local_${randomUUID()}`,
      cliSessionId: randomUUID(),
      cwd: root,
      title: "Second",
      titleSource: "auto",
      createdAt: 1,
      lastActivityAt: 2,
    }), "utf8");
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid: 30, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => transcriptPath,
      now: () => 300,
    });

    await expect(registrar.register({
      sessionId,
      cwd: root,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
    })).resolves.toMatchObject({
      state: "unavailable",
      detail: expect.stringContaining("多个账号"),
    });
  });

  it("does not overwrite a conflicting deterministic metadata file", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture();
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    await writeFile(join(accountDir, `local_${sessionId}.json`), JSON.stringify({
      sessionId: `local_${sessionId}`,
      cliSessionId: randomUUID(),
      cwd: root,
    }), "utf8");
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid: 40, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => transcriptPath,
    });

    await expect(registrar.register({
      sessionId,
      cwd: root,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
    })).rejects.toThrow("指向其他 transcript");
  });

  it("ignores a persisted metadata path outside configured Claude roots", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture();
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const outside = join(root, `local_${sessionId}.json`);
    await writeFile(outside, JSON.stringify({
      sessionId: `local_${sessionId}`,
      cliSessionId: sessionId,
      cwd: root,
    }), "utf8");
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid: 50, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => transcriptPath,
      now: () => 500,
    });

    const result = await registrar.register({
      sessionId,
      cwd: root,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
    }, {
      state: "restart-required",
      detail: "untrusted",
      updatedAt: 1,
      desktopSessionId: `local_${sessionId}`,
      metadataPath: outside,
      profileSessionsRoot: profileRoot,
      claudePidAtRegistration: 50,
    });

    expect(result.metadataPath).toBe(join(
      await realpath(accountDir),
      `local_${sessionId}.json`,
    ));
    expect(result.state).toBe("restart-required");
    await expect(readFile(outside, "utf8")).resolves.toContain(sessionId);
  });
});
