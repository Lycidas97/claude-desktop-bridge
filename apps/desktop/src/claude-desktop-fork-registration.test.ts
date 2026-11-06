import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeDesktopSessionRegistrar, type StoredDesktopRegistration } from "./claude-desktop-session-registrar.js";

const desktop = vi.hoisted(() => ({ profile: "", opens: 0 }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFile(command: string, _args: string[], _options: unknown, done: (error: null, result: { stdout: string; stderr: string }) => void) {
    if (command === "/bin/ps") done(null, { stdout: `100 1 /Applications/Claude.app/Contents/MacOS/Claude\n101 100 /Applications/Claude.app/Contents/Frameworks/Claude Helper --user-data-dir=${desktop.profile}`, stderr: "" });
    else if (command === "/usr/bin/open") { desktop.opens += 1; done(null, { stdout: "", stderr: "" }); }
    else throw new Error(`Unexpected external command: ${command}`);
  },
}));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  // The registrar's existing temporary-file cleanup must also obey the Trash-only test policy.
  unlink: async (path: string) => { execFileSync(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", [path]); },
}));

const directories: string[] = [];
afterEach(() => {
  if (directories.length) execFileSync(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", directories.splice(0));
});

async function adoptedFork(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-registration-"));
  directories.push(root);
  const profile = join(root, "Claude");
  const sessionsRoot = join(profile, "claude-code-sessions");
  const account = join(sessionsRoot, "device", "account");
  await mkdir(account, { recursive: true });
  const sessionId = randomUUID();
  const input = { sessionId, cwd: root, title: "Fork", createdAt: 1, lastActivityAt: 2,
    parentDesktopSessionId: `local_${randomUUID()}`, forkLabel: "fork-2" };
  const path = join(account, `local_${sessionId}.json`);
  await writeFile(path, JSON.stringify({ sessionId: `local_${sessionId}`, cliSessionId: sessionId,
    cwd: root, title: "Custom title", titleSource: "custom", createdAt: 1, lastActivityAt: 2,
    adoptedFromOtherSurface: true, ...extra }));
  let pid = 100;
  const registrar = new ClaudeDesktopSessionRegistrar({
    paths: { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [sessionsRoot] },
    platform: "darwin", listProfiles: async () => [{ pid, userDataDir: profile }], now: () => 200,
  });
  const previous: StoredDesktopRegistration = { state: "registered", detail: "Claude Desktop 已登记这条 Bridge 会话。",
    desktopSessionId: `local_${sessionId}`, metadataPath: path, profileSessionsRoot: sessionsRoot,
    registeredAt: 1, updatedAt: 2 };
  return { registrar, input, previous, path, restart: () => { pid = 101; } };
}

describe("Desktop fork registration", () => {
  it("stages a new fork without adopting it into Desktop as an ordinary session", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-new-fork-"));
    directories.push(root);
    desktop.profile = join(root, "Claude"); desktop.opens = 0;
    const sessionsRoot = join(desktop.profile, "claude-code-sessions");
    const account = join(sessionsRoot, "device", "account");
    const projects = join(root, "projects");
    await mkdir(account, { recursive: true }); await mkdir(projects);
    const parentId = randomUUID(), sessionId = randomUUID();
    await writeFile(join(account, `local_${parentId}.json`), JSON.stringify({ sessionId: `local_${parentId}`, cliSessionId: parentId,
      cwd: root, title: "Parent", titleSource: "custom", createdAt: 1, lastActivityAt: 1 }));
    await writeFile(join(projects, `${sessionId}.jsonl`), JSON.stringify({ sessionId, cwd: root, type: "user", message: { role: "user", content: "QA" } }) + "\n");
    const registrar = new ClaudeDesktopSessionRegistrar({ paths: { projects, sessions: join(root, "sessions"), tasks: join(root, "tasks"), desktopSessions: [sessionsRoot] }, platform: "darwin" });
    const result = await registrar.register({ sessionId, cwd: root, title: "Fork", createdAt: 1, lastActivityAt: 2, parentDesktopSessionId: `local_${parentId}`, forkLabel: "fork" });
    expect(desktop.opens).toBe(0);
    expect(result).toMatchObject({ state: "restart-required", claudePidAtRegistration: 100, forkMetadataVersion: 1 });
    expect(JSON.parse(await readFile(result.metadataPath!, "utf8"))).toMatchObject({ forkedFromSessionId: `local_${parentId}`,
      spawnedFrom: { sessionId: `local_${parentId}`, userFork: true } });
  });

  it("migrates old registered forks even when their disk metadata is already complete", async () => {
    const { registrar, input, previous, path, restart } = await adoptedFork();
    const metadata = JSON.parse(await readFile(path, "utf8"));
    const contents = JSON.stringify({ ...metadata, forkedFromSessionId: input.parentDesktopSessionId,
      spawnedFrom: { sessionId: input.parentDesktopSessionId, userFork: true, sideSession: true, name: "user-name" } });
    await writeFile(path, contents);
    const staged = await registrar.register(input, previous);
    expect(staged).toMatchObject({ state: "restart-required", forkMetadataVersion: 1, claudePidAtRegistration: 100 });
    expect(await readFile(path, "utf8")).toBe(contents);
    restart();
    const loaded = await registrar.register(input, staged);
    expect(loaded.state).toBe("registered");
    expect(await registrar.register(input, loaded)).toEqual(loaded);
  });

  it("keeps ordinary live-adopted sessions registered without requiring a restart", async () => {
    const { registrar, input, previous } = await adoptedFork();
    const { parentDesktopSessionId: _parent, forkLabel: _label, ...ordinary } = input;
    expect(await registrar.register(ordinary, previous)).toMatchObject({ state: "registered" });
  });

  it("does not claim a disk-only fork repair is visible in the running Desktop process", async () => {
    const { registrar, input, previous, path, restart } = await adoptedFork();
    const repaired = await registrar.register(input, previous);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ forkedFromSessionId: input.parentDesktopSessionId,
      spawnedFrom: { sessionId: input.parentDesktopSessionId, userFork: true, sideSession: true } });
    expect(repaired).toMatchObject({ state: "restart-required", claudePidAtRegistration: 100 });
    expect(await registrar.register(input, repaired)).toEqual(repaired);
    restart();
    expect(await registrar.register(input, repaired)).toMatchObject({ state: "registered" });
  });

  it.each(["parent", "spawn", "both"])("repairs conflicting populated native fork identities (%s)", async broken => {
    const { registrar, input, previous, path } = await adoptedFork();
    const metadata = JSON.parse(await readFile(path, "utf8"));
    const wrongParent = `local_${randomUUID()}`;
    await writeFile(path, JSON.stringify({
      ...metadata,
      forkedFromSessionId: broken === "spawn" ? input.parentDesktopSessionId : wrongParent,
      spawnedFrom: { sessionId: broken === "parent" ? input.parentDesktopSessionId : wrongParent,
        taskId: "keep-task", name: "keep-name", userFork: true, sideSession: true, customField: "preserve" },
    }));
    const repaired = await registrar.register(input, previous);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      title: "Custom title", forkedFromSessionId: input.parentDesktopSessionId,
      spawnedFrom: { sessionId: input.parentDesktopSessionId, taskId: "keep-task", name: "keep-name", customField: "preserve" },
    });
    expect(repaired).toMatchObject({ state: "restart-required", forkMetadataVersion: 1 });
  });

  it("repairs a missing spawn link even when the parent field already exists", async () => {
    const { registrar, input, previous, path } = await adoptedFork();
    const metadata = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...metadata, forkedFromSessionId: input.parentDesktopSessionId }));
    await registrar.register(input, previous);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ title: "Custom title", spawnedFrom: {
      sessionId: input.parentDesktopSessionId, userFork: true, sideSession: true, sharedFolder: true, name: "fork-2",
    } });
  });
});
