import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { originalTitle, sessionId } from "../config.mjs";
import { eventually } from "../helpers.mjs";

export const incomingFileName = "从文件管理器打开.zip";
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
  await sheet.getByText(incomingFileName, { exact: true }).waitFor();
  await sheet.getByRole("button", { name: /Browser E2E 隔离电脑/ }).click();
  await sheet.getByRole("button", { name: "文件接收电脑" }).click();
  await target.waitFor();
  assert.ok(!(await target.isDisabled()));
  for (const computer of [startingHost, host]) {
    assert.ok(!computer.requests.some(request => request.method.startsWith("file.upload.")));
  }
  await sheet.screenshot({ path: resolve(directory, "incoming-file-picker.png"), animations: "disabled" });
  await target.click();
  await page.getByRole("list", { name: "待发送文件" }).getByText("已上传，发送时附上路径", { exact: false }).waitFor();
  await eventually(() => host.requests.filter(request => request.method === "file.upload.cancel").length, 1, "Release the upload lease");
  const uploads = host.requests.filter(request => request.method.startsWith("file.upload."));
  assert.deepEqual(uploads.map(request => request.method), ["file.upload.open", "file.upload.write", "file.upload.commit", "file.upload.cancel"]);
  const { client: _client, ...uploadParams } = uploads[0].params;
  assert.deepEqual(uploadParams, {
    sessionId, name: incomingFileName, size: sample.length, sha256: createHash("sha256").update(sample).digest("hex"),
  });
  assert.deepEqual(await readFile(resolve(host.nativeApproval.cwd, ".bridge-uploads", uploads[2].params.uploadId, incomingFileName)), sample);
  assert.ok(!host.requests.some(request => request.method === "turn.start"));

  await page.evaluate(file => window.bridgeIncomingFileFixture(file), { id: "warm", name: "另一个文件.bin", mimeType: "application/octet-stream" });
  await sheet.getByText("另一个文件.bin", { exact: true }).waitFor();
  await target.waitFor();
  await sheet.getByRole("button", { name: "取消导入" }).click();
  await sheet.waitFor({ state: "hidden" });

  await page.evaluate(file => window.bridgeIncomingFileFixture(file), { id: "oversize", error: "单个文件不能超过 20 MiB" });
  await sheet.getByRole("alert").waitFor();
  assert.equal(await sheet.getByRole("alert").textContent(), "单个文件不能超过 20 MiB");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  assert.equal(host.requests.filter(request => request.method === "file.upload.open").length, 1);
  assert.ok(!startingHost.requests.some(request => request.method.startsWith("file.upload.")));
  steps.push("a cold file is uploaded byte-for-byte to the selected computer and appears in the chosen draft; a warm read error closes without uploading");
}
