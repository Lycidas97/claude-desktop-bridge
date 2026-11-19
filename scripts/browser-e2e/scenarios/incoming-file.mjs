import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { originalTitle, sessionId } from "../config.mjs";
import { eventually } from "../helpers.mjs";

export const incomingFileName = "实验?记录.txt";
const uploadedFileName = "实验_记录.txt";
const sample = Buffer.from([0, 255, 32, 197, 0, 128, 242]);

export function installIncomingFileFixture({ name, chunks }) {
  const listeners = new Map();
  let callbackId = 0;
  let pending = location.search === "?file-import" ? { id: "launch", name, mimeType: "application/zip" } : undefined;
  let index = 0;
  window.Capacitor = {
    // Exercise this plugin through the public API while the loopback fixture uses web pairing.
    get getPlatform() { return () => "android"; },
    set getPlatform(_) {},
    PluginHeaders: [{ name: "BridgeIncomingFile", methods: [
      { name: "addListener", rtype: "callback" },
      ...["removeListener", "getPendingFile", "readFileChunk", "discardFile"].map(name => ({ name, rtype: "promise" })),
    ] }],
    nativeCallback(_plugin, _method, _options, listener) {
      const id = String(++callbackId);
      listeners.set(id, listener);
      return id;
    },
    async nativePromise(_plugin, method, options) {
      if (method === "removeListener") listeners.delete(options.callbackId);
      else if (method === "getPendingFile") return { file: pending };
      else if (method === "discardFile") {
        if (pending?.id === options.id) pending = undefined;
      } else if (method === "readFileChunk") {
        if (pending?.id !== options.id) throw new Error("文件已关闭");
        if (index < chunks.length) return { data: chunks[index++] };
        pending = undefined;
        return { done: true };
      }
    },
  };
  window.bridgeIncomingFileFixture = (file) => {
    pending = file;
    index = 0;
    for (const listener of listeners.values()) listener(file);
  };
}

export const incomingFileFixture = {
  name: incomingFileName,
  chunks: [sample.subarray(0, 3), sample.subarray(3)].map(chunk => chunk.toString("base64")),
};

export async function verifyIncomingFile(page, startingHost, host, steps, directory) {
  const sheet = page.getByRole("dialog", { name: "上传到会话" });
  const target = sheet.getByRole("button", { name: new RegExp(originalTitle) });
  const root = host.snapshot.sessions.find(session => session.sessionId === sessionId);
  root.currentSummary = "处理发票附件";
  host.snapshot.sessions.push(
    { ...root, sessionId: "another-import-target", currentSummary: "审阅项目计划" },
    { ...root, sessionId: "archived-import-target", title: "已归档的导入目标", archivedAt: Date.now() },
    { ...root, sessionId: "sidechat-import-target", title: "侧聊导入目标", parentSessionId: sessionId, sidechat: true },
  );
  const imageId = "import-while-viewing";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+l2p0AAAAASUVORK5CYII=", "base64");
  host.nativeImages.set(`${imageId}:0`, png);
  host.history.push({ id: imageId, sessionId, role: "user", text: "导入前打开图片", createdAt: Date.now(), origin: "claude-desktop", delivery: "completed", attachments: [
    { id: `native-image:${imageId}:0`, name: "preview.png", mimeType: "image/png", size: png.length, nativeImage: { messageUuid: imageId, imageIndex: 0 } },
  ] });
  await sheet.getByText(incomingFileName, { exact: true }).waitFor();
  await sheet.getByRole("button", { name: /Browser E2E 隔离电脑/ }).click();
  await sheet.getByRole("button", { name: "文件接收电脑" }).click();
  await target.first().waitFor();
  const matchingTargets = await target.count();
  const invoiceTarget = sheet.getByRole("button", { name: /处理发票附件/ });
  const planTarget = sheet.getByRole("button", { name: /审阅项目计划/ });
  assert.deepEqual([matchingTargets, await invoiceTarget.count(), await planTarget.count()], [2, 1, 1]);
  const archivedVisible = await sheet.getByRole("button", { name: "已归档的导入目标", exact: false }).isVisible();
  const sidechatVisible = await sheet.getByRole("button", { name: "侧聊导入目标", exact: false }).isVisible();
  for (const computer of [startingHost, host]) {
    assert.ok(!computer.requests.some(request => request.method.startsWith("file.upload.")));
  }
  await sheet.screenshot({ path: resolve(directory, "incoming-file-picker.png"), animations: "disabled" });
  await sheet.locator("summary").click();
  await sheet.getByRole("button", { name: "侧聊导入目标", exact: true }).waitFor();
  await invoiceTarget.click();
  await page.getByRole("list", { name: "待发送文件" }).getByText("已上传，发送时附上路径", { exact: false }).waitFor();
  await eventually(() => host.requests.filter(request => request.method === "file.upload.cancel").length, 1, "Release the upload lease");
  const uploads = host.requests.filter(request => request.method.startsWith("file.upload."));
  assert.deepEqual(uploads.map(request => request.method), ["file.upload.open", "file.upload.write", "file.upload.commit", "file.upload.cancel"]);
  const { client: _client, ...uploadParams } = uploads[0].params;
  assert.deepEqual(uploadParams, {
    sessionId, name: uploadedFileName, size: sample.length, sha256: createHash("sha256").update(sample).digest("hex"),
  });
  assert.deepEqual(await readFile(resolve(host.nativeApproval.cwd, ".bridge-uploads", uploads[2].params.uploadId, uploadedFileName)), sample);
  assert.ok(!host.requests.some(request => request.method === "turn.start"));

  await page.locator(".conversation-image-preview img").click();
  const viewer = page.locator("dialog.media-viewer");
  await viewer.waitFor();
  await page.evaluate(file => window.bridgeIncomingFileFixture(file), { id: "warm", name: "另一个文件.bin", mimeType: "application/octet-stream" });
  await sheet.getByText("另一个文件.bin", { exact: true }).waitFor();
  const viewerStillOpen = await viewer.isVisible();
  assert.deepEqual({ archivedVisible, sidechatVisible, viewerStillOpen }, {
    archivedVisible: false, sidechatVisible: false, viewerStillOpen: false,
  });
  await target.first().waitFor();
  await sheet.getByRole("button", { name: "取消导入" }).click();
  await sheet.waitFor({ state: "hidden" });

  const oversizedName = "2026年11月第三周项目进度周报-最终版-修订3（发给客户前请再核对）.docx";
  await page.evaluate(file => window.bridgeIncomingFileFixture(file), { id: "oversize", name: oversizedName, error: "单个文件不能超过 20 MiB" });
  await sheet.getByText(oversizedName, { exact: true }).waitFor();
  await sheet.getByRole("alert").waitFor();
  assert.equal(await sheet.getByRole("alert").textContent(), "单个文件不能超过 20 MiB");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  assert.equal(host.requests.filter(request => request.method === "file.upload.open").length, 1);
  assert.ok(!startingHost.requests.some(request => request.method.startsWith("file.upload.")));
  steps.push("a cold file is uploaded byte-for-byte to the selected computer and appears in the chosen draft; a warm read error closes without uploading");
}
