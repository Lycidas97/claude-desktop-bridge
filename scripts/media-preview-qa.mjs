import { chromium, _electron } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(import.meta.dirname, "../output/playwright");
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "electron-media-main.cjs"), `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1200, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  window.loadFile(require('node:path').resolve(__dirname, '../../apps/client/dist/index.html'));
});\n`);

// Separate content streams keep later pages outside the first range request.
function samplePdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const pages = [];
  for (let page = 1; page <= 10; page += 1) {
    pages.push(`${page + 3} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 13} 0 R >>`);
  }
  for (let page = 1; page <= 10; page += 1) {
    const content = `0.15 0.35 0.55 rg 40 600 515 160 re f\nBT /F1 24 Tf 40 550 Td (Media preview - page ${page}) Tj ET\n%${" ".repeat(300_000)}\n`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${pages.join(" ")}] /Count ${pages.length} >>`;
  let data = "%PDF-1.7\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(data).toString("base64");
}

const pdf = samplePdf();
const now = Date.now();
const session = { sessionId: "media-session", projectId: "media-project", projectName: "Reports", cwd: "/work/reports", title: "Images and PDF", source: "desktop", ownership: "DESKTOP_OBSERVED", transport: "bridge-host", turnState: "idle", lastActivityAt: now, pendingCount: 0 };
const artifacts = [
  { id: "pdf", name: "Research report.pdf", relativePath: "output/Research report.pdf", kind: "pdf", mimeType: "application/pdf", previewMode: "none" },
  { id: "image", name: "Figure.png", relativePath: "output/Figure.png", kind: "image", mimeType: "image/png", previewMode: "image" },
  { id: "svg", name: "Diagram.svg", relativePath: "output/Diagram.svg", kind: "binary", mimeType: "application/octet-stream", previewMode: "none" },
].map((file) => ({ ...file, evidenceId: "media-evidence", changeKind: "created", size: 1024, availability: "snapshot", downloadAllowed: true }));
const evidence = { sessionId: session.sessionId, items: [{ id: "media-evidence", sessionId: session.sessionId, turnId: "media-turn", source: "claude-desktop", confidence: "exact", state: "ready", startedAt: now - 1000, completedAt: now, toolCount: 1, changeCount: 2, artifactCount: 2, tools: [], artifacts, warnings: [] }], hasMore: false };
const history = { sessionId: session.sessionId, items: [{ id: "question", role: "user", text: "Show the report and image.", createdAt: now - 1000, turnId: "media-turn" }, { id: "answer", role: "assistant", text: "Created [Research report](<output/Research report.pdf>) and [Figure](output/Figure.png).", createdAt: now, turnId: "media-turn" }], hasMore: false };
const snapshot = { host: { hostId: "qa", pairingEpoch: 1, name: "Preview Mac", relayUrl: "ws://127.0.0.1:8788/ws", online: true, lastSeenAt: now, version: "1.0.2", capabilities: ["evidence.v1", "artifact.preview.v1", "artifact.transfer.v1"] }, projects: [{ projectId: session.projectId, name: "Reports", cwd: session.cwd, sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: now }], sessions: [session], devices: [], permissions: [], providers: [], runtime: { state: "ready", detail: "Ready", activeTurns: 0, pendingTurns: 0 }, latestSeq: 0, connection: "connected", launchAtLogin: false, managedDesktopEnabled: false, claudeDesktop: { state: "running", canLaunch: false, canQuit: true, detail: "Running" } };
const packaged = process.argv.includes("--electron");
const mobile = process.argv.includes("--mobile");
const mobileModule = mobile ? await (await fetch("http://127.0.0.1:5188/src/components/MobileWorkspace.tsx")).text() : "";
const providerModule = mobileModule.match(/from "([^"]*MediaPreviewProvider\.tsx[^"]*)"/u)?.[1];
const browser = packaged
  ? await _electron.launch({ ...(process.env.BRIDGE_ELECTRON_PATH ? { executablePath: process.env.BRIDGE_ELECTRON_PATH } : {}), args: [resolve(output, "electron-media-main.cjs")] })
  : await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const viewport of [{ width: 1200, height: 850 }, { width: 375, height: 812 }]) {
    if ((packaged && viewport.width === 375) || (mobile && viewport.width !== 375)) continue;
    const page = packaged ? await browser.firstWindow() : await browser.newPage({ viewport, serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript(({ snapshot, history, evidence, pdf }) => {
      const bytes = Uint8Array.from(atob(pdf), (char) => char.charCodeAt(0));
      // Keep the unrelated connectivity probe from leaving this local fixture.
      const fetchOriginal = window.fetch;
      window.fetch = (...args) => String(args[0]).endsWith("/health")
        ? Promise.resolve(new Response("ok")) : fetchOriginal(...args);
      let lease = 0;
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><circle cx="400" cy="250" r="150" fill="#245778"/></svg>');
      const transfers = new Map();
      window.__mediaRequests = [];
      window.__expireMediaTransfers = () => transfers.clear();
      const response = (result) => ({ kind: "response", requestId: "qa", ok: true, result });
      window.bridgeDesktop = {
        getSnapshot: async () => snapshot,
        onSnapshot: () => () => undefined,
        onEvent: () => () => undefined,
        request: async ({ method, params }) => {
          window.__mediaRequests.push({ method, params });
          if (method === "session.open") return response({ session: snapshot.sessions[0], history });
          if (method === "evidence.list") return response({ evidence });
          if (method === "artifact.preview") return response({ preview: { artifactId: "image", mode: "image", mimeType: "image/svg+xml", encoding: "base64", data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#dce8ef"/><circle cx="400" cy="210" r="100" fill="#245778"/><text x="270" y="410" font-size="32">Research figure</text></svg>'), truncated: false, generatedAt: Date.now() } });
          if (method === "artifact.transfer.open") {
            const isSvg = params.artifactId === "svg" || params.path?.endsWith(".svg");
            const data = isSvg ? svg : bytes;
            const transferId = `qa-${++lease}`;
            transfers.set(transferId, data);
            return response({ transfer: { transferId, artifactId: isSvg ? "svg" : "pdf", name: isSvg ? "Diagram.svg" : "Research report.pdf", mimeType: isSvg ? "application/octet-stream" : "application/pdf", size: data.length, chunkBytes: 262144, totalChunks: Math.ceil(data.length / 262144), sha256: "qa", expiresAt: Date.now() + 600000 } });
          }
          if (method === "artifact.transfer.read") {
            const data = transfers.get(params.transferId);
            if (!data) return { kind: "response", requestId: "qa", ok: false, error: { message: "Artifact transfer expired" } };
            const chunk = data.slice(params.index * 262144, (params.index + 1) * 262144);
            let binary = "";
            for (let index = 0; index < chunk.length; index += 8192) binary += String.fromCharCode(...chunk.subarray(index, index + 8192));
            return response({ chunk: { transferId: params.transferId, index: params.index, data: btoa(binary) } });
          }
          if (method === "artifact.transfer.close") return response({ closed: true });
          return response({});
        },
      };
    }, { snapshot, history, evidence, pdf });
    if (mobile) {
      await page.route("**/src/main.tsx*", (route) => route.fulfill({ contentType: "text/javascript", body: `
        import React from "/node_modules/.vite/deps/react.js";
        import ReactDOMClient from "/node_modules/.vite/deps/react-dom_client.js";
        import { MobileWorkspace } from "/src/components/MobileWorkspace.tsx";
        import { MediaPreviewProvider } from ${JSON.stringify(providerModule)};
        import { dispatchMobileBack } from "/src/lib/mobile-back-navigation.ts";
        import "/src/styles.css";
        import "/src/media-preview.css";
        const snapshot = await window.bridgeDesktop.getSnapshot();
        const history = ${JSON.stringify(history)};
        const evidence = ${JSON.stringify(evidence)};
        const noop = async () => undefined;
        localStorage.setItem("bridge.mobile.last-session.v1:qa", "media-session");
        document.documentElement.dataset.theme = "dark";
        window.__mobileBack = dispatchMobileBack;
        ReactDOMClient.createRoot(document.getElementById("root")).render(React.createElement(MediaPreviewProvider, {
          request: (method, params) => window.bridgeDesktop.request({ method, params }),
        }, React.createElement(MobileWorkspace, {
          activeHostId: "qa", desktopName: "Preview Mac", connection: "connected", desktopOnline: true,
          snapshot, permissions: [], histories: { "media-session": { ...history, status: "ready" } },
          evidence: { "media-session": { ...evidence, status: "ready" } }, artifactPreviews: {}, artifactTransfers: {},
          events: [], localTurns: [], pendingOutbound: 0,
          themeControl: { theme: "dark", family: "sunstone", setTheme: noop, setFamily: noop, toggleTheme: noop },
          onOpenSession: noop, onLoadOlderHistory: noop, onLoadOlderEvidence: noop, onDownloadSessionFile: noop,
          onPreviewArtifact: noop, onDownloadArtifact: noop, onSendTurn: noop, onInterruptTurn: noop,
          onResolveUncertain: noop, onResolvePermission: noop, onCreateSession: noop, onLoadSessionConfiguration: noop,
          onConfigureSession: noop, onPreviewProviderSwitch: noop, onCommitProviderSwitch: noop,
          onCancelProviderSwitch: noop, onRefreshProviders: noop, onPreviewRuntimeHandoff: noop,
          onCommitRuntimeHandoff: noop, onConfirmRuntimeHandoff: noop, onCancelRuntimeHandoff: noop,
          onGetRuntimeHandoff: noop, onPauseRuntimeGoal: noop, onResumeRuntimeGoal: noop,
          onDesktopAppAction: noop, onRefresh: async () => true, onBackToHosts: noop, onRetry: noop,
        })));
      ` }));
    }
    if (packaged) await page.reload();
    else await page.goto("http://127.0.0.1:5188");
    await page.locator(".media-file.pdf").first().waitFor({ timeout: 15_000 }).catch(async (error) => {
      await page.screenshot({ path: `${output}/media-failure.png` });
      console.error(JSON.stringify({ errors, body: await page.locator("body").innerText() }));
      throw error;
    });
    const before = await page.evaluate(() => window.__mediaRequests.filter((r) => r.method.startsWith("artifact.")).length);
    if (before !== 0) throw new Error("Media bodies were loaded before user interaction");
    await page.locator(".media-file.pdf").first().click();
    await page.locator(".media-viewer canvas:visible").waitFor({ timeout: 15_000 }).catch(async (error) => {
      await page.screenshot({ path: `${output}/media-failure.png` });
      console.error(JSON.stringify({ errors, body: await page.locator("body").innerText(), requests: await page.evaluate(() => window.__mediaRequests) }));
      throw error;
    });
    await page.waitForFunction(() => !document.querySelector(".media-viewer-status") && document.querySelector("canvas")?.width > 0);
    const pageOne = await page.evaluate(() => ({ reads: window.__mediaRequests.filter((r) => r.method === "artifact.transfer.read").map((r) => r.params.index), width: document.querySelector("canvas").width, pages: document.querySelector(".media-page-controls").textContent }));
    if (new Set(pageOne.reads).size > 4) throw new Error("First page fetched unrelated PDF content");
    await page.screenshot({ path: `${output}/${packaged ? "electron-" : mobile ? "mobile-" : ""}media-pdf-${viewport.width}.png` });
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".media-viewer-status") && document.querySelector('[aria-label="页码"]').value === "2");
    await page.getByRole("button", { name: "放大", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".media-viewer-status"));
    await page.getByRole("button", { name: "旋转页面", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".media-viewer-status"));
    await page.evaluate(() => window.__expireMediaTransfers());
    await page.getByRole("spinbutton", { name: "页码" }).fill("8");
    await page.getByRole("alert").waitFor();
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".media-viewer-status") && document.querySelector('[aria-label="页码"]').value === "8" && document.querySelector("canvas")?.width > 0);
    if (mobile) {
      if (!await page.evaluate(() => window.__mobileBack())) throw new Error("Mobile back was not handled");
      await page.locator(".media-viewer").waitFor({ state: "detached" });
      await page.locator(".markdown-file-link").filter({ hasText: "Research report" }).waitFor();
    } else await page.getByRole("button", { name: "关闭查看器" }).click();
    await page.waitForFunction(() => window.__mediaRequests.some((r) => r.method === "artifact.transfer.close"));
    await page.locator(".media-file.image").first().click();
    await page.locator(".media-viewer img").waitFor();
    await page.waitForFunction(() => document.querySelector(".media-viewer img")?.naturalWidth > 0);
    await page.screenshot({ path: `${output}/${packaged ? "electron-" : mobile ? "mobile-" : ""}media-image-${viewport.width}.png` });
    await page.getByRole("button", { name: "关闭查看器" }).click();
    await page.locator(".media-file.image").filter({ hasText: "Diagram.svg" }).first().click();
    await page.waitForFunction(() => document.querySelector(".media-viewer img")?.naturalWidth > 0 || document.querySelector('.media-viewer [role="alert"]'));
    if (await page.getByRole("alert").count()) throw new Error("SVG transfer preview failed to render");
    await page.getByRole("button", { name: "关闭查看器" }).click();
    await page.locator(".markdown-file-link").filter({ hasText: "Research report" }).click();
    await page.waitForFunction(() => !document.querySelector(".media-viewer-status") && document.querySelector(".media-viewer canvas")?.width > 0);
    await page.keyboard.press("Escape");
    await page.locator(".media-viewer").waitFor({ state: "detached" });
    if (mobile) {
      await page.getByRole("button", { name: /^成果\s+\d+$/u }).click();
      const first = await page.locator(".mobile-evidence-view > :first-child").getAttribute("class");
      if (!first?.includes("media-gallery")) throw new Error("Media gallery is not first in mobile outputs");
      await page.screenshot({ path: `${output}/mobile-media-gallery.png` });
      await page.locator(".mobile-evidence-view .media-file.pdf").click();
      await page.waitForFunction(() => !document.querySelector(".media-viewer-status") && document.querySelector(".media-viewer canvas")?.width > 0);
      await page.evaluate(() => window.__mobileBack());
      await page.locator(".media-viewer").waitFor({ state: "detached" });
      await page.locator(".mobile-evidence-view").waitFor();
    }
    results.push({ viewport, mobileWorkspace: mobile, lazyBeforeOpen: before, pageOne, errors });
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(`${output}/${packaged ? "electron-" : mobile ? "mobile-" : ""}media-preview-results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => result.errors.length)) process.exitCode = 1;
