import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm as recycle, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeDesktopDeveloperSettings } from "./claude-desktop-developer-settings.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});

// Reuse the repository's Trash-only cleanup on all CI platforms.
createRequire(import.meta.url)("../../../scripts/recycle-cleanup.cjs");
const directories: string[] = [];
let home: string;
let claude: string;
let thirdParty: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bridge-developer-settings-"));
  directories.push(home);
  claude = join(home, "Library", "Application Support", "Claude");
  thirdParty = join(home, "Library", "Application Support", "Claude-3p");
});
afterAll(async () => {
  await Promise.all(directories.map((directory) => recycle(directory, { recursive: true })));
});

describe("Claude Desktop developer settings", () => {
  it("checks without creating directories or settings files", async () => {
    expect(await claudeDesktopDeveloperSettings({ home, platform: "darwin" })).toEqual({ supported: true, profiles: [] });
    await expect(stat(claude)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(thirdParty, { recursive: true });
    expect(await claudeDesktopDeveloperSettings({ home, platform: "darwin" })).toMatchObject({ profile: "Claude-3p", enabled: false });
    await expect(stat(join(thirdParty, "developer_settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["Claude", "Claude-3p"] as const)("selects the only profile %s and creates its settings on enable", async (profile) => {
    const path = join(profile === "Claude" ? claude : thirdParty, "developer_settings.json");
    await mkdir(profile === "Claude" ? claude : thirdParty, { recursive: true });
    expect(await claudeDesktopDeveloperSettings({ home, platform: "darwin", profile, enable: true }))
      .toMatchObject({ profile, path, enabled: true, changed: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ allowDevTools: true });
  });

  it("requires selection when both directories exist and preserves the other profile", async () => {
    await mkdir(claude, { recursive: true });
    await mkdir(thirdParty, { recursive: true });
    const original = '{ "allowDevTools": false, "other": { "theme": "dark" } }';
    await writeFile(join(claude, "developer_settings.json"), original);
    await writeFile(join(thirdParty, "developer_settings.json"), original);
    expect(await claudeDesktopDeveloperSettings({ home, platform: "darwin" })).toMatchObject({
      profiles: [{ id: "Claude" }, { id: "Claude-3p" }],
    });
    expect((await claudeDesktopDeveloperSettings({ home, platform: "darwin" })).profile).toBeUndefined();
    await expect(claudeDesktopDeveloperSettings({ home, platform: "darwin", enable: true })).rejects.toThrow("请先选择");
    await claudeDesktopDeveloperSettings({ home, platform: "darwin", profile: "Claude-3p", enable: true });
    expect(await readFile(join(claude, "developer_settings.json"), "utf8")).toBe(original);
    expect(JSON.parse(await readFile(join(thirdParty, "developer_settings.json"), "utf8"))).toEqual({
      allowDevTools: true, other: { theme: "dark" },
    });
  });

  it.each([{}, { allowDevTools: "true" }])("sets only a strict boolean true while preserving fields: %j", async (settings) => {
    await mkdir(claude, { recursive: true });
    const path = join(claude, "developer_settings.json");
    await writeFile(path, JSON.stringify({ ...settings, extra: [1, "two"] }));
    expect(await claudeDesktopDeveloperSettings({ home, platform: "darwin" })).toMatchObject({ enabled: false });
    await claudeDesktopDeveloperSettings({ home, platform: "darwin", profile: "Claude", enable: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ allowDevTools: true, extra: [1, "two"] });
  });

  it("does not rewrite an enabled file, preserving bytes and modification time", async () => {
    await mkdir(claude, { recursive: true });
    const path = join(claude, "developer_settings.json");
    const original = '{"allowDevTools":true, "extra":42}\n';
    await writeFile(path, original);
    const before = await stat(path);
    expect(await claudeDesktopDeveloperSettings({ home, platform: "darwin", profile: "Claude", enable: true }))
      .toMatchObject({ enabled: true, changed: false });
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it.each(["{broken", "null", "[]", '"text"', "42", "true"])("rejects invalid settings without overwriting %s", async (content) => {
    await mkdir(claude, { recursive: true });
    const path = join(claude, "developer_settings.json");
    await writeFile(path, content);
    await expect(claudeDesktopDeveloperSettings({ home, platform: "darwin", profile: "Claude", enable: true })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("surfaces file access errors and rejects unknown or absent profiles", async () => {
    await expect(claudeDesktopDeveloperSettings({ home, platform: "darwin", profile: "../elsewhere", enable: true })).rejects.toThrow("请选择");
    await expect(claudeDesktopDeveloperSettings({ home, platform: "darwin", profile: "Claude", enable: true })).rejects.toThrow("未找到 Claude");
    await mkdir(join(claude, "developer_settings.json"), { recursive: true });
    await expect(claudeDesktopDeveloperSettings({ home, platform: "darwin", profile: "Claude", enable: true })).rejects.toThrow();
  });

  it("surfaces write failures", async () => {
    await mkdir(claude, { recursive: true });
    vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(claudeDesktopDeveloperSettings({ home, platform: "darwin", profile: "Claude", enable: true })).rejects.toThrow("permission denied");
    await expect(stat(join(claude, "developer_settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports Windows MSIX and non-virtualized profile directories without listing duplicates", async () => {
    const appData = join(home, "AppData", "Roaming");
    const localAppData = join(home, "AppData", "Local");
    const relocatedClaude = join(localAppData, "Claude-Data", "claude_pzs8sxrjxfjjc");
    const hostThirdParty = join(localAppData, "Claude-3p");
    const vfsThirdParty = join(localAppData, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Local", "Claude-3p");
    await mkdir(relocatedClaude, { recursive: true });
    await mkdir(join(appData, "Claude"), { recursive: true });
    await mkdir(hostThirdParty, { recursive: true });
    await mkdir(vfsThirdParty, { recursive: true });
    const env = { APPDATA: appData, LOCALAPPDATA: localAppData };

    const check = await claudeDesktopDeveloperSettings({ home, platform: "win32", environment: env });
    expect(check).toEqual({
      supported: true,
      profiles: [
        { id: "Claude", path: join(relocatedClaude, "developer_settings.json") },
        { id: "Claude-3p", path: join(hostThirdParty, "developer_settings.json") },
      ],
    });
    const enabled = await claudeDesktopDeveloperSettings({
      home,
      platform: "win32",
      environment: env,
      profile: "Claude-3p",
      enable: true,
    });
    expect(enabled).toMatchObject({
      supported: true,
      profile: "Claude-3p",
      path: join(hostThirdParty, "developer_settings.json"),
      enabled: true,
      changed: true,
    });
    expect(JSON.parse(await readFile(join(hostThirdParty, "developer_settings.json"), "utf8"))).toEqual({ allowDevTools: true });
    await expect(stat(join(vfsThirdParty, "developer_settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not write on linux", async () => {
    await mkdir(claude, { recursive: true });
    expect(await claudeDesktopDeveloperSettings({ home, platform: "linux" })).toEqual({ supported: false, profiles: [] });
    await expect(claudeDesktopDeveloperSettings({ home, platform: "linux", profile: "Claude", enable: true })).rejects.toThrow("仅支持 macOS 与 Windows");
    await expect(stat(join(claude, "developer_settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
