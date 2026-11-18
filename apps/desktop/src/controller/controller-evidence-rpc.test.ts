import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_TRANSFER_TTL_MS, BridgeCrypto, type BridgeEvidenceBundle, type BridgeFileUploadInfo, type BridgeMethod } from "@bridge/protocol";
import { expect, it, vi } from "vitest";
import { createControllerFixture } from "./controller-fixture.js";

it("returns evidence lists, summaries and detail pages through local RPC", async () => {
  const bundle: BridgeEvidenceBundle = {
    id: "evidence-1", sessionId: "session-1", source: "bridge-host", confidence: "exact", state: "ready",
    startedAt: 1, toolCount: 0, changeCount: 1, artifactCount: 1, tools: [], warnings: [],
    artifacts: [{
      id: "artifact-1", evidenceId: "evidence-1", relativePath: "output/note.txt", name: "note.txt",
      kind: "text", changeKind: "created", mimeType: "text/plain", size: 1,
      availability: "current-file", previewMode: "text", downloadAllowed: true,
    }],
  };
  const summary = { ...bundle, artifacts: [], detailsAvailable: true };
  const list = { sessionId: "session-1", items: [summary], hasMore: false };
  const page = { evidenceId: bundle.id, kind: "artifacts", items: bundle.artifacts, hasMore: false };
  const evidence = {
    list: vi.fn().mockReturnValue(list), get: vi.fn().mockReturnValue(bundle), details: vi.fn().mockReturnValue(page),
  };
  const controller = createControllerFixture({ broker: { session: vi.fn().mockReturnValue({ sessionId: "session-1" }) }, evidence });

  expect(await controller.dispatchLocal({ method: "evidence.list", params: { sessionId: "session-1", cursor: "next" } }))
    .toMatchObject({ ok: true, result: { evidence: list } });
  expect(evidence.list).toHaveBeenCalledWith("session-1", "next", 30);
  expect(await controller.dispatchLocal({ method: "evidence.get", params: { evidenceId: bundle.id } }))
    .toMatchObject({ ok: true, result: { evidence: summary } });
  expect(evidence.get).toHaveBeenCalledWith(bundle.id);
  expect(await controller.dispatchLocal({ method: "evidence.details", params: { evidenceId: bundle.id, kind: "artifacts", limit: 5 } }))
    .toMatchObject({ ok: true, result: { page } });
  expect(evidence.details).toHaveBeenCalledWith(bundle.id, "artifacts", undefined, 5);
});

it("writes a local upload to the session cwd and keeps the prefix cancellation fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bridge-upload-rpc-"));
  try {
    const controller = createControllerFixture({ allSessions: () => [{ sessionId: "session-1", cwd }] });
    const content = Buffer.from("local upload");
    const opened = await controller.dispatchLocal({ method: "file.upload.open", params: {
      sessionId: "session-1", name: "note.txt", size: content.length, sha256: createHash("sha256").update(content).digest("hex"),
    } });
    expect(opened).toMatchObject({ ok: true, result: { upload: { uploadId: expect.any(String) } } });
    const { uploadId } = (opened.result as { upload: BridgeFileUploadInfo }).upload;
    expect(await controller.dispatchLocal({ method: "file.upload.write", params: { uploadId, index: 0, data: content.toString("base64") } }))
      .toMatchObject({ ok: true, result: { received: 1 } });
    const path = `.bridge-uploads/${uploadId}/note.txt`;
    expect(await controller.dispatchLocal({ method: "file.upload.commit", params: { uploadId } }))
      .toMatchObject({ ok: true, result: { file: { uploadId, sessionId: "session-1", path } } });
    expect(await readFile(join(cwd, path))).toEqual(content);
    expect(await controller.dispatchLocal({ method: "file.upload.other" as BridgeMethod, params: { uploadId } }))
      .toMatchObject({ ok: true, result: { cancelled: true } });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it.each([
  ["plugin.assistant-mail.status", { sessionId: "codex-desktop:saved" }, "UNSUPPORTED", "当前电脑不支持邮件助理。"],
  ["evidence.list", { sessionId: "codex-desktop:saved" }, "UNSUPPORTED", "当前仅支持 Claude Desktop，其他 Agent 适配已停用。"],
  ["runtime.file.open", {}, "UNSUPPORTED", "当前仅支持 Claude Desktop，其他 Agent 适配已停用。"],
  ["artifact.transfer.other", {}, "UNSUPPORTED_REQUEST_METHOD", "Unsupported request method"],
  ["file.upload.other", {}, "UPLOADID_IS_REQUIRED", "uploadId is required"],
  ["evidence.details", { kind: "invalid" }, "UNKNOWN_EVIDENCE_DETAIL_KIND", "Unknown evidence detail kind"],
] as const)("preserves the error for local %s", async (method, params, code, message) => {
  const controller = createControllerFixture({});
  expect(await controller.dispatchLocal({ method: method as BridgeMethod, params }))
    .toMatchObject({ ok: false, error: { code, message, retryable: false } });
});

it("dispatches phone transfers and uploads for the paired owner with the existing response policy", async () => {
  const { pairing, desktopCrypto } = await BridgeCrypto.createDevicePairing({
    roomId: "evidence-room", relayUrl: "ws://127.0.0.1:18789/ws", desktopName: "Desktop", deviceId: "phone-1",
  });
  const phone = await BridgeCrypto.fromPairing(pairing);
  const transfer = { transferId: "transfer-1" };
  const chunk = { ...transfer, index: 0, data: "YQ==" };
  const preview = { artifactId: "artifact-1", mode: "text", mimeType: "text/plain", encoding: "utf8", data: "a", truncated: false, generatedAt: 1 };
  const evidence = {
    openTransfer: vi.fn().mockResolvedValue(transfer), readTransfer: vi.fn().mockReturnValue(chunk),
    closeTransfer: vi.fn().mockReturnValue(true), preview: vi.fn().mockResolvedValue(preview),
  };
  const upload = { uploadId: "upload-1" };
  const file = { ...upload, path: ".bridge-uploads/upload-1/note.txt" };
  const uploads = {
    open: vi.fn().mockResolvedValue(upload), write: vi.fn().mockReturnValue(1), commit: vi.fn().mockResolvedValue(file),
  };
  const sendToDevice = vi.fn().mockResolvedValue("response");
  const ack = vi.fn();
  const controller = createControllerFixture({
    evidence, uploads, sendToDevice, socket: { ack },
    allSessions: () => [{ sessionId: "session-1", cwd: "/project" }],
  });
  const uploadParams = { sessionId: "session-1", name: "note.txt", size: 1, sha256: createHash("sha256").update("a").digest("hex") };

  for (const [method, params, result, cached, ttl] of [
    ["artifact.transfer.open", { artifactId: "artifact-1", purpose: "text-preview" }, { transfer }, true, ARTIFACT_TRANSFER_TTL_MS],
    ["artifact.transfer.read", { transferId: transfer.transferId, index: 0 }, { chunk }, false, ARTIFACT_TRANSFER_TTL_MS],
    ["artifact.transfer.close", { transferId: transfer.transferId }, { closed: true }, true, ARTIFACT_TRANSFER_TTL_MS],
    ["artifact.preview", { artifactId: "artifact-1" }, { preview }, false, ARTIFACT_TRANSFER_TTL_MS],
    ["file.upload.open", uploadParams, { upload }, true, undefined],
    ["file.upload.write", { uploadId: upload.uploadId, index: 0, data: "YQ==" }, { received: 1 }, true, undefined],
    ["file.upload.commit", { uploadId: upload.uploadId }, { file }, true, undefined],
  ] as const) {
    const envelope = await phone.encrypt({ kind: "request", requestId: method, idempotencyKey: method, method, params }, "mobile", "desktop");
    await controller.receiveMessage(await desktopCrypto.decrypt(envelope), envelope);
    expect(sendToDevice).toHaveBeenLastCalledWith(
      { kind: "response", requestId: method, ok: true, result }, pairing.deviceId, ttl, true, true,
    );
    expect(controller.responseCache.has(method)).toBe(cached);
    expect(ack).toHaveBeenLastCalledWith([envelope.id]);
  }
  expect(evidence.openTransfer).toHaveBeenCalledExactlyOnceWith("artifact-1", pairing.deviceId, true);
  expect(evidence.readTransfer).toHaveBeenCalledExactlyOnceWith(transfer.transferId, 0, pairing.deviceId);
  expect(evidence.closeTransfer).toHaveBeenCalledExactlyOnceWith(transfer.transferId, pairing.deviceId);
  expect(evidence.preview).toHaveBeenCalledExactlyOnceWith("artifact-1");
  expect(uploads.open).toHaveBeenCalledExactlyOnceWith({ ...uploadParams, owner: pairing.deviceId, cwd: "/project" });
  expect(uploads.write).toHaveBeenCalledExactlyOnceWith(upload.uploadId, 0, "YQ==", pairing.deviceId);
  expect(uploads.commit).toHaveBeenCalledExactlyOnceWith(upload.uploadId, pairing.deviceId);
});
