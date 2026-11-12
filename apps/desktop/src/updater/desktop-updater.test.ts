import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { transpileModule } from "typescript";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm as recycle, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopController } from "../controller/controller.js";
import { BridgeRequestError } from "../controller/controller-rpc.js";
import {
  DesktopUpdater,
  buildWindowsSilentUpdateScript,
  type DesktopUpdaterPlatform,
} from "./desktop-updater.js";
import { extractZipEntryToFile, listZipEntries } from "./zip-extract.js";

createRequire(import.meta.url)("../../../../scripts/recycle-cleanup.cjs");

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildTestZip(entries: Array<{ name: string; content: Buffer; deflate?: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, "utf8");
    const method = item.deflate === false ? 0 : 8;
    const dataBuf = method === 8 ? deflateRawSync(item.content) : item.content;
    const checksum = crc32(item.content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(item.content.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(item.content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, nameBuf, dataBuf);
    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("DesktopUpdater & ZIP extraction", () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const directory of tempDirs.splice(0)) {
      await recycle(directory, { recursive: true, force: true });
    }
  });

  async function makeTempDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "bridge-updater-test-"));
    tempDirs.push(directory);
    return directory;
  }

  it("extracts deflated and stored entries from ZIP Central Directory and blocks traversal", async () => {
    const dir = await makeTempDir();
    const zipPath = join(dir, "bundle.zip");
    const setupPayload = Buffer.from("MZ-fake-nsis-installer-payload-1.3.3", "utf8");
    const zipBytes = buildTestZip([
      { name: "windows-release-evidence.json", content: Buffer.from('{"ok":true}'), deflate: false },
      { name: "Bridge-1.3.3-Setup.exe", content: setupPayload, deflate: true },
      { name: "../evil-Setup.exe", content: Buffer.from("bad"), deflate: false },
    ]);
    await writeFile(zipPath, zipBytes);

    const entries = await listZipEntries(zipPath);
    expect(entries.map((entry) => entry.fileName)).toEqual([
      "windows-release-evidence.json",
      "Bridge-1.3.3-Setup.exe",
      "../evil-Setup.exe",
    ]);

    const extractedPath = join(dir, "extracted-Setup.exe");
    const result = await extractZipEntryToFile(
      zipPath,
      (entry) => entry.fileName.endsWith("Setup.exe"),
      extractedPath,
    );
    expect(result.entryName).toBe("Bridge-1.3.3-Setup.exe");
    expect(await readFile(extractedPath)).toEqual(setupPayload);
  });

  it("builds Windows silent update PowerShell script with unquoted trailing /D= and no Remove-Item", () => {
    const script = buildWindowsSilentUpdateScript();
    expect(script).toContain('"/S /currentuser /D=$installDir"');
    expect(script).toContain("Get-Process -Name $procName");
    expect(script).not.toContain("Remove-Item");
  });

  it.each([
    {
      platform: "win32" as DesktopUpdaterPlatform,
      arch: "x64",
      assetName: "Bridge-1.3.3-windows-installer-ci.zip",
      innerName: "Bridge-1.3.3-Setup.exe",
      expectCanAutoRestart: true,
    },
    {
      platform: "darwin" as DesktopUpdaterPlatform,
      arch: "arm64",
      assetName: "Bridge-1.3.3-macos-adhoc.zip",
      innerName: "Bridge.dmg",
      expectCanAutoRestart: false,
    },
    {
      platform: "linux" as DesktopUpdaterPlatform,
      arch: "x64",
      assetName: "Bridge-1.3.3-linux-installers-ci.zip",
      innerName: "bridge_1.3.3_amd64.deb",
      expectCanAutoRestart: false,
    },
  ])(
    "downloads, verifies SHA-256, extracts, and applies honestly on $platform ($arch)",
    async ({ platform, arch, assetName, innerName, expectCanAutoRestart }) => {
      const dir = await makeTempDir();
      const innerContent = Buffer.from(`binary-installer-for-${platform}-${innerName}`, "utf8");
      const zipBuffer = buildTestZip([{ name: innerName, content: innerContent, deflate: true }]);
      const zipSha = sha256Hex(zipBuffer);

      let etagChecks = 0;
      const server = createServer((req, res) => {
        if (req.url?.startsWith("/releases")) {
          if (req.headers["if-none-match"] === '"v133-etag"') {
            etagChecks += 1;
            res.writeHead(304);
            res.end();
            return;
          }
          const origin = `https://updates.example.test`;
          res.writeHead(200, { "Content-Type": "application/json", ETag: '"v133-etag"' });
          res.end(
            JSON.stringify([
              {
                tag_name: "v1.3.3",
                name: "Bridge v1.3.3",
                draft: false,
                prerelease: false,
                html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.3",
                body: "- Auto updater support",
                assets: [
                  {
                    name: assetName,
                    browser_download_url: `${origin}/download/${assetName}`,
                    size: zipBuffer.length,
                    digest: `sha256:${zipSha}`,
                    state: "uploaded",
                  },
                ],
              },
            ]),
          );
          return;
        }
        if (req.url === `/download/${assetName}`) {
          res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": String(zipBuffer.length) });
          res.end(zipBuffer);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      servers.push(server);
      const port = (server.address() as { port: number }).port;

      const helperCalls: Array<{ setupPath: string; installDir: string; exePath: string; reopenUi: boolean }> = [];
      const openCalls: Array<{ filePath: string; revealOnly: boolean }> = [];
      let quitRequested = 0;

      const updater = new DesktopUpdater({
        platform,
        arch,
        currentVersion: "1.3.2",
        isPackaged: true,
        execPath: platform === "win32" ? "C:\\Users\\Test User\\AppData\\Local\\Programs\\Bridge\\bridge.exe" : "/Applications/Bridge.app/Contents/MacOS/bridge",
        userDataPath: dir,
        feedUrl: `http://127.0.0.1:${port}/releases`,
        autoCheckAllowed: false,
        linuxPackageFormat: "deb",
        isDirectoryWritable: () => true,
        fetchImpl: (input, init) => {
          const targetUrl = String(input).replace("https://updates.example.test", `http://127.0.0.1:${port}`);
          return fetch(targetUrl, init);
        },
        isSystemIdle: () => true,
        hasConnectedUi: () => true,
        requestQuitAll: () => {
          quitRequested += 1;
        },
        openLocalInstaller: async (filePath, revealOnly) => {
          openCalls.push({ filePath, revealOnly });
        },
        spawnWindowsHelper: (opts) => {
          helperCalls.push(opts);
        },
        onChanged: () => {},
      });

      await updater.initialize();
      expect(updater.snapshot().canAutoRestart).toBe(expectCanAutoRestart);

      const checked = await updater.handleRpc({ action: "check" }, "desktop");
      expect(checked.phase).toBe("available");
      expect(checked.latestVersion).toBe("1.3.3");
      expect(checked.assetName).toBe(assetName);

      // Verify ETag 304 caching on repeat check
      await updater.handleRpc({ action: "check" }, "desktop");
      expect(etagChecks).toBe(1);

      await updater.handleRpc({ action: "download" }, "desktop");
      await updater.waitForPendingTasks();

      const ready = updater.snapshot();
      expect(ready.phase).toBe("ready");
      expect(ready.integrityVerified).toBe("sha256");
      expect(ready.stagedPath).toBeTruthy();
      expect(await readFile(ready.stagedPath!)).toEqual(innerContent);

      // Remote mobile apply
      const afterMobileApply = await updater.handleRpc({ action: "apply" }, "mobile");
      if (expectCanAutoRestart) {
        expect(afterMobileApply.phase).toBe("applying");
        expect(helperCalls).toHaveLength(1);
        expect(helperCalls[0]?.reopenUi).toBe(true);
        expect(helperCalls[0]?.installDir).toBe("C:\\Users\\Test User\\AppData\\Local\\Programs\\Bridge");
        expect(helperCalls[0]?.exePath).toContain("bridge.exe");
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(quitRequested).toBe(1);
      } else {
        expect(afterMobileApply.phase).toBe("ready");
        expect(openCalls).toHaveLength(0);
        // Desktop local apply opens DMG on macOS and reveals package in folder on Linux
        await updater.handleRpc({ action: "apply" }, "desktop");
        expect(openCalls).toEqual([{ filePath: ready.stagedPath!, revealOnly: platform === "linux" }]);
      }
      updater.close();
    },
  );

  it("rejects tampered downloads on SHA-256 mismatch and supports silent-idle deferred apply", async () => {
    const dir = await makeTempDir();
    const innerContent = Buffer.from("MZ-valid-setup", "utf8");
    const zipBuffer = buildTestZip([{ name: "Bridge-1.3.3-Setup.exe", content: innerContent }]);
    let tamperDigest = true;
    let systemIdle = false;
    const helperCalls: string[] = [];

    const updater = new DesktopUpdater({
      platform: "win32",
      arch: "x64",
      currentVersion: "1.3.2",
      isPackaged: true,
      execPath: join(dir, "Bridge", "bridge.exe"),
      userDataPath: dir,
      feedUrl: "https://mock.local/releases",
      autoCheckAllowed: false,
      isDirectoryWritable: () => true,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/releases")) {
          return new Response(
            JSON.stringify([
              {
                tag_name: "v1.3.3",
                prerelease: false,
                html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.3",
                body: "",
                assets: [
                  {
                    name: "Bridge-1.3.3-windows-installer-ci.zip",
                    browser_download_url: "https://mock.local/bundle.zip",
                    size: zipBuffer.length,
                    digest: `sha256:${tamperDigest ? "0".repeat(64) : sha256Hex(zipBuffer)}`,
                  },
                ],
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(new Uint8Array(zipBuffer), { status: 200 });
      },
      isSystemIdle: () => systemIdle,
      hasConnectedUi: () => false,
      requestQuitAll: () => {},
      spawnWindowsHelper: ({ setupPath }) => {
        helperCalls.push(setupPath);
      },
      onChanged: () => {},
    });

    await updater.initialize();
    await updater.handleRpc({ action: "check" }, "desktop");
    await updater.handleRpc({ action: "download" }, "desktop");
    await updater.waitForPendingTasks();
    expect(updater.snapshot().phase).toBe("error");
    expect(updater.snapshot().error).toContain("SHA-256");

    // Now allow valid digest and configure silent-idle while busy
    tamperDigest = false;
    await updater.handleRpc({ action: "configure", applyMode: "silent-idle", autoCheck: true }, "desktop");
    await updater.handleRpc({ action: "check" }, "desktop");
    await updater.waitForPendingTasks();
    expect(updater.snapshot().phase).toBe("ready");
    expect(updater.snapshot().waitingForIdle).toBe(true);
    expect(helperCalls).toHaveLength(0);

    // Transition to idle -> auto applies!
    systemIdle = true;
    updater.notifyIdleStateChanged(true);
    expect(updater.snapshot().phase).toBe("applying");
    expect(helperCalls).toHaveLength(1);
    updater.close();
  });

  it("passes real dispatcher responses to the App updater callback and packaged QA", async () => {
    const updater = new DesktopUpdater({
      platform: "win32", arch: "x64", currentVersion: "1.3.2", isPackaged: true,
      execPath: "C:\\Bridge\\bridge.exe", userDataPath: await makeTempDir(),
      autoCheckAllowed: false, isDirectoryWritable: () => true,
      isSystemIdle: () => true, hasConnectedUi: () => false,
      requestQuitAll: () => {}, onChanged: () => {},
    });
    const controller: DesktopController = Object.assign(Object.create(DesktopController.prototype), {
      updater, publish: async () => {},
    });
    const appSource = await readFile(new URL("../../../client/src/App.tsx", import.meta.url), "utf8");
    const callback = appSource.match(/const invokeRemoteUpdate = useCallback\((async [\s\S]*?), \[request\]\);/u);
    expect(callback).not.toBeNull();
    // Run the checked-in callback, replacing transport I/O with the real dispatcher.
    const invoke = new Function("request", `${transpileModule(`const invoke = ${callback![1]};`, {}).outputText}\nreturn invoke;`)(
      (_method: string, params: Record<string, unknown>) => controller.dispatchLocal({ method: "system.update", params }),
    );
    const remoteStatus = await invoke({ action: "status" });
    expect(remoteStatus.phase).toBe("idle");
    expect(remoteStatus.currentVersion).toBe("1.3.2");
    expect(remoteStatus.canAutoRestart).toBe(true);

    const qaSource = await readFile(new URL("../../../../scripts/packaged-desktop-qa.mjs", import.meta.url), "utf8");
    const qaBlock = qaSource.slice(qaSource.indexOf("  const updaterStatus ="), qaSource.indexOf('  for (const method of ["provider.list"'));
    expect(qaBlock).toContain("updaterStatus.result.currentVersion");
    const ipcProof: Record<string, unknown> = {};
    await new (Object.getPrototypeOf(async function () {}).constructor)("page", "assert", "desktopPackage", "ipcProof", qaBlock)(
      {
        evaluate: (body: () => unknown) => runInNewContext(`(${body.toString()})()`, {
          window: { bridgeDesktop: { request: (input: Parameters<DesktopController["dispatchLocal"]>[0]) => controller.dispatchLocal(input) } },
        }),
      },
      assert, { version: "1.3.2" }, ipcProof,
    );
    expect(ipcProof["system.update"]).toBe("idle");
    updater.close();
  });

  it("preserves Object.create(DesktopController.prototype) safety when updater is absent", async () => {
    const bareController = Object.create(DesktopController.prototype) as DesktopController;
    const response = await bareController.dispatchLocal({
      method: "system.update",
      params: { action: "status" },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("UNSUPPORTED");
    expect(BridgeRequestError).toBeDefined();
  });
});
