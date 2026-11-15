import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeInspectorStartup, parseInspectorDesktopProcesses } from "./claude-inspector-startup.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-inspector-startup-"));
  directories.push(directory);
  const processes = vi.fn().mockResolvedValue([{ pid: 42, identity: "42:first-start" }]);
  const menu = vi.fn<(pid: number, press: boolean) => Promise<"waiting" | "ready" | "enabled" | "clicked">>(async (_pid, press) => press ? "clicked" : "ready");
  const options = { recordPath: join(directory, "startup.json"), processes, menu };
  return { ...options, options, startup: new ClaudeInspectorStartup(options) };
}

describe("one native inspector action per Desktop process start", () => {
  it("does not click again after opening and then manually closing in the same process", async () => {
    const f = await fixture();
    await f.startup.check(false);
    await f.startup.check(true);
    await f.startup.check(false);
    await f.startup.check(false);
    expect(f.menu.mock.calls.filter(([, press]) => press)).toHaveLength(1);
  });

  it("records an already-open process so later manual closure is respected", async () => {
    const f = await fixture();
    expect(await f.startup.check(true)).toMatchObject({ state: "already-open", recordedAt: expect.any(Number) });
    await f.startup.check(false);
    expect(f.menu).not.toHaveBeenCalled();
  });

  it("keeps the handled identity across a Bridge service restart after manual closure", async () => {
    const f = await fixture();
    await f.startup.check(false);
    await f.startup.check(true);
    const restarted = new ClaudeInspectorStartup(f.options);
    await restarted.check(false);
    expect(f.menu.mock.calls.filter(([, press]) => press)).toHaveLength(1);
    expect(await readFile(f.recordPath, "utf8")).toContain("42:first-start");
  });

  it("treats the same PID with a different launch time as a new Desktop", async () => {
    const f = await fixture();
    await f.startup.check(false);
    f.processes.mockResolvedValue([{ pid: 42, identity: "42:second-start" }]);
    await f.startup.check(false);
    await f.startup.check(false);
    expect(f.menu.mock.calls.filter(([, press]) => press)).toHaveLength(2);
  });

  it("waits for late menu construction without consuming the single action", async () => {
    const f = await fixture();
    f.menu.mockResolvedValueOnce("waiting");
    expect(await f.startup.check(false)).toMatchObject({ state: "waiting", detail: expect.stringContaining("等待") });
    expect(f.menu.mock.calls.filter(([, press]) => press)).toHaveLength(0);
    await f.startup.check(false);
    await f.startup.check(false);
    expect(f.menu.mock.calls.filter(([, press]) => press)).toHaveLength(1);
  });

  it("preserves the original failure time through polling, port recovery, manual closure and service restart", async () => {
    const f = await fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1794697200000);
    f.menu.mockRejectedValue(new Error("Not authorized to send Apple events (-1743)"));
    const failed = await f.startup.check(false);
    expect(failed).toEqual({ state: "failed", recordedAt: 1794697200000, detail: "自动开启失败：Not authorized to send Apple events (-1743)" });
    now.mockReturnValue(1794700800000);
    expect(await f.startup.check(false)).toEqual(failed);
    expect(await f.startup.check(true)).toEqual(failed);
    expect(await f.startup.check(false)).toEqual(failed);
    expect(await new ClaudeInspectorStartup(f.options).check(false)).toEqual(failed);
    expect(JSON.parse(await readFile(f.recordPath, "utf8"))["42:first-start"]).toEqual(failed);
    expect(f.menu).toHaveBeenCalledOnce();
  });

  it("waits for Accessibility consent without consuming the process attempt, then acts once", async () => {
    const f = await fixture();
    const accessibility = vi.fn(() => ({ trusted: false, applicationPath: "/Applications/Bridge.app" }));
    const startup = new ClaudeInspectorStartup({ ...f.options, accessibility });
    expect(await startup.check(false)).toEqual({ state: "accessibility-required", detail: expect.stringContaining("/Applications/Bridge.app") });
    await startup.check(false);
    expect(f.menu).not.toHaveBeenCalled();
    await expect(readFile(f.recordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    accessibility.mockReturnValue({ trusted: true, applicationPath: "/Applications/Bridge.app" });
    await startup.check(false);
    await new ClaudeInspectorStartup({ ...f.options, accessibility }).check(false);
    expect(f.menu.mock.calls.filter(([, press]) => press)).toHaveLength(1);
  });

  it("respects already-open and historical attempts before checking Accessibility", async () => {
    const f = await fixture();
    const accessibility = vi.fn(() => ({ trusted: false, applicationPath: "/Applications/Bridge.app" }));
    const startup = new ClaudeInspectorStartup({ ...f.options, accessibility });
    expect(await startup.check(true)).toMatchObject({ state: "already-open" });
    await startup.check(false);
    expect(accessibility).not.toHaveBeenCalled();
    expect(f.menu).not.toHaveBeenCalled();
  });

  it("keeps old string records as time-unknown history without granting another automatic attempt", async () => {
    const f = await fixture();
    await writeFile(f.recordPath, JSON.stringify({ "42:first-start": "本进程自动开启失败：旧权限错误 (-2700)" }));
    const legacy = await f.startup.check(false);
    expect(legacy).toEqual({ state: "legacy", detail: "本进程自动开启失败：旧权限错误 (-2700)" });
    expect(await f.startup.check(true)).toEqual(legacy);
    expect(await new ClaudeInspectorStartup(f.options).check(false)).toEqual(legacy);
    expect(f.menu).not.toHaveBeenCalled();
  });

  it("keeps a click failure visible and does not mistake the menu result for an open port", async () => {
    const f = await fixture();
    f.menu.mockImplementation(async (_pid, press) => { if (press) throw new Error("AXPress failed"); return "ready"; });
    expect(await f.startup.check(false)).toMatchObject({ state: "failed", detail: expect.stringContaining("AXPress failed") });
    expect(await f.startup.check(false)).toMatchObject({ state: "failed", detail: expect.stringContaining("AXPress failed") });
    expect(f.menu.mock.calls.filter(([, press]) => press)).toHaveLength(1);
    const next = await fixture();
    const attempted = await next.startup.check(false);
    expect(attempted).toMatchObject({ state: "attempted" });
    expect(await next.startup.check(true)).toEqual(attempted);
  });

  it("records a checked menu separately from a click without pressing it", async () => {
    const f = await fixture();
    f.menu.mockResolvedValue("enabled");
    expect(await f.startup.check(false)).toMatchObject({ state: "enabled", detail: expect.stringContaining("未重复操作") });
    await f.startup.check(false);
    expect(f.menu).toHaveBeenCalledExactlyOnceWith(42, false);
  });
});

it.each(["darwin", "linux", "win32"] as const)("parses macOS PID, launch time, and exact main executable on %s hosts, excluding helpers and other apps", platform => {
  vi.stubGlobal("process", { ...process, platform });
  expect(parseInspectorDesktopProcesses([
    " 42 Tue Nov 10 11:25:09 2026 /Applications/Claude.app/Contents/MacOS/Claude",
    " 43 Tue Nov 10 11:25:09 2026 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper",
    " 44 Tue Nov 10 11:25:09 2026 /Applications/Other.app/Contents/MacOS/Claude",
  ].join("\n"))).toEqual([{ pid: 42, identity: "42:Tue Nov 10 11:25:09 2026:/Applications/Claude.app/Contents/MacOS/Claude" }]);
});
