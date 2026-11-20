import type { BridgeArtifactTransferInfo, BridgeRequest, BridgeResponse } from "@bridge/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { downloadBridgeSessionFile, downloadMailAttachment, saveMediaTarget } from "./artifact-download.js";
import type { MediaTarget } from "./media-preview.js";

const native = vi.hoisted(() => ({
  platform: "android",
  openFile: vi.fn(),
  saveFile: vi.fn(),
  share: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => native.platform,
    isNativePlatform: () => native.platform === "android",
  },
  registerPlugin: (name: string) => name === "BridgeFiles" ? { openFile: native.openFile, saveFile: native.saveFile } : undefined,
}));
vi.mock("@capacitor/share", () => ({ Share: { share: native.share } }));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE" },
  Filesystem: {
    writeFile: native.writeFile,
    getUri: () => ({ uri: "file:///cache/bridge-evidence/lease/report.docx" }),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function downloadRequest(name = "report.docx", mimeType = "application/octet-stream") {
  const transfer: BridgeArtifactTransferInfo = {
    transferId: "lease",
    artifactId: "report",
    name,
    mimeType,
    size: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    chunkBytes: 3,
    totalChunks: 1,
    expiresAt: Date.now() + 60_000,
  };
  return vi.fn(async (method: BridgeRequest["method"], _params: Record<string, unknown>): Promise<BridgeResponse> => {
    const result = method === "artifact.transfer.open" ? { transfer }
      : method === "artifact.transfer.read" ? { chunk: { transferId: "lease", index: 0, data: "YWJj" } }
      : {};
    return { kind: "response", requestId: "test", ok: true, result };
  });
}

it.each([
  ["short filename", "report.docx", "report.docx"],
  ["long filename", `${"x".repeat(160)}.DOCX`, `${"x".repeat(155)}.DOCX`],
  ["multibyte filename", `${"文".repeat(100)}.docx`, `${"文".repeat(51)}.docx`],
])("opens an Android download with a %s and preserves the extension", async (_label, name, cacheName) => {
  native.platform = "android";
  const request = downloadRequest(name);
  await downloadBridgeSessionFile("session", name, request, vi.fn());

  const path = `bridge-evidence/lease/${cacheName}`;
  expect(native.share).not.toHaveBeenCalled();
  expect(native.writeFile).toHaveBeenCalledWith({ path, directory: "CACHE", data: "YWJj", recursive: true });
  expect(native.openFile).toHaveBeenCalledExactlyOnceWith({ path, mimeType: "application/octet-stream" });
  expect(native.openFile).toHaveBeenCalledAfter(native.writeFile);
  expect(request).toHaveBeenLastCalledWith("artifact.transfer.close", { transferId: "lease" }, expect.anything());
});

it("passes the transfer MIME type for TypeScript downloads on Android", async () => {
  native.platform = "android";
  await downloadBridgeSessionFile("session", "main.ts", downloadRequest("main.ts", "text/plain"), vi.fn());

  expect(native.openFile).toHaveBeenCalledExactlyOnceWith({
    path: "bridge-evidence/lease/main.ts",
    mimeType: "text/plain",
  });
});

it("downloads a browser file using a blob URL and preserves its extension", async () => {
  native.platform = "web";
  vi.useFakeTimers();
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
  const anchor = { click: vi.fn(), download: "", href: "" };
  vi.stubGlobal("document", { createElement: () => anchor });

  const name = `${"x".repeat(160)}.docx`;
  await downloadBridgeSessionFile("session", name, downloadRequest(name), vi.fn());

  expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(expect.any(Blob));
  expect(anchor).toMatchObject({ download: `${"x".repeat(155)}.docx`, href: "blob:report" });
  expect(anchor.click).toHaveBeenCalledOnce();
  expect(native.openFile).not.toHaveBeenCalled();
});

it.each<{ target: MediaTarget; params: Record<string, unknown> }>([
  { target: { name: "image.png", kind: "image", artifactId: "image", dataUrl: "data:image/jpeg;base64,cHJldmlldw==" }, params: { artifactId: "image" } },
  { target: { name: "report.pdf", kind: "pdf", path: " report.pdf:12:3 ", sessionId: "session", resolveRelativeLink: true }, params: { sessionId: "session", path: "report.pdf", resolveRelativeLink: true } },
  { target: { name: "report.pdf", kind: "pdf", mailAttachment: { mailRefId: "mail", attachmentId: "2" } }, params: { mailAttachment: { mailRefId: "mail", attachmentId: "2" } } },
  { target: { name: "image.png", kind: "image", sessionId: "session", nativeImage: { messageUuid: "message", imageIndex: 1 }, dataUrl: "blob:cached" }, params: { sessionId: "session", nativeImage: { messageUuid: "message", imageIndex: 1 } } },
])("saves original Android file bytes from $params", async ({ target, params }) => {
  native.platform = "android";
  const request = downloadRequest(target.name);
  const onProgress = vi.fn();
  await saveMediaTarget(target, request, onProgress);
  expect(onProgress).toHaveBeenCalledExactlyOnceWith(1);
  expect(request).toHaveBeenNthCalledWith(1, "artifact.transfer.open", params, expect.anything());
  expect(native.saveFile).toHaveBeenCalledExactlyOnceWith({ name: target.name, chunks: ["YWJj"] });
  expect(native.writeFile).not.toHaveBeenCalled();
  expect(native.openFile).not.toHaveBeenCalled();
  expect(request).toHaveBeenLastCalledWith("artifact.transfer.close", { transferId: "lease" }, expect.anything());
});

it("saves an inline original after Native reconciliation without requesting it from the offline host", async () => {
  native.platform = "android";
  const request = vi.fn(async () => { throw new Error("电脑当前离线"); });
  await saveMediaTarget({ name: "photo.png", kind: "image", sessionId: "session", nativeImage: { messageUuid: "message", imageIndex: 1 }, dataUrl: "data:image/png;base64,YWJj" }, request, vi.fn());
  expect(request).not.toHaveBeenCalled();
  expect(native.saveFile).toHaveBeenCalledExactlyOnceWith({ name: "photo.png", chunks: ["YWJj"] });
});

it("sends verified mail bytes to the Android save picker without staging or opening a file", async () => {
  native.platform = "android";
  const mailAttachment = { mailRefId: "mail", attachmentId: "2" };
  const request = downloadRequest("schedule.html", "text/html");
  await downloadMailAttachment(mailAttachment, request, vi.fn());
  expect(request).toHaveBeenNthCalledWith(1, "artifact.transfer.open", { mailAttachment }, expect.anything());
  expect(native.saveFile).toHaveBeenCalledExactlyOnceWith({ name: "schedule.html", chunks: ["YWJj"] });
  expect(native.writeFile).not.toHaveBeenCalled();
  expect(native.openFile).not.toHaveBeenCalled();
  expect(request).toHaveBeenLastCalledWith("artifact.transfer.close", { transferId: "lease" }, expect.anything());
});
