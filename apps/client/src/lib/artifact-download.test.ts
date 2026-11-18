import type { BridgeArtifactTransferInfo, BridgeRequest, BridgeResponse } from "@bridge/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { downloadBridgeSessionFile } from "./artifact-download.js";

const native = vi.hoisted(() => ({
  platform: "android",
  openFile: vi.fn(),
  share: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => native.platform,
    isNativePlatform: () => native.platform === "android",
  },
  registerPlugin: (name: string) => name === "BridgeFiles" ? { openFile: native.openFile } : undefined,
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

function downloadRequest(name = "report.docx") {
  const transfer: BridgeArtifactTransferInfo = {
    transferId: "lease",
    artifactId: "report",
    name,
    mimeType: "application/octet-stream",
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
])("opens an Android download with a %s and preserves the extension", async (_label, name, cacheName) => {
  native.platform = "android";
  const request = downloadRequest(name);
  await downloadBridgeSessionFile("session", name, request, vi.fn());

  const path = `bridge-evidence/lease/${cacheName}`;
  expect(native.share).not.toHaveBeenCalled();
  expect(native.writeFile).toHaveBeenCalledWith({ path, directory: "CACHE", data: "YWJj", recursive: true });
  expect(native.openFile).toHaveBeenCalledExactlyOnceWith({ path });
  expect(native.openFile).toHaveBeenCalledAfter(native.writeFile);
  expect(request).toHaveBeenLastCalledWith("artifact.transfer.close", { transferId: "lease" }, expect.anything());
});

it("downloads a browser file using a blob URL", async () => {
  native.platform = "web";
  vi.useFakeTimers();
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
  const anchor = { click: vi.fn(), download: "", href: "" };
  vi.stubGlobal("document", { createElement: () => anchor });

  await downloadBridgeSessionFile("session", "report.docx", downloadRequest(), vi.fn());

  expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(expect.any(Blob));
  expect(anchor).toMatchObject({ download: "report.docx", href: "blob:report" });
  expect(anchor.click).toHaveBeenCalledOnce();
  expect(native.openFile).not.toHaveBeenCalled();
});
