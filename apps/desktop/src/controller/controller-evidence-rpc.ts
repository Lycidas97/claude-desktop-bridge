import { evidenceSummary, isBridgeNativeImageRef, type BridgeSessionInfo } from "@bridge/protocol";
import type { ClaudeDesktopBridge } from "../claude/claude-desktop-bridge.js";
import type { EvidenceManager } from "../evidence/evidence-manager.js";
import type { FileUploadManager } from "../evidence/file-upload.js";
import { integerParam, numberParam, stringParam } from "./request-error.js";

export function listEvidence(evidence: EvidenceManager, broker: Pick<ClaudeDesktopBridge, "session">, params: Record<string, unknown>) {
  const sessionId = stringParam(params, "sessionId")!;
  if (!broker.session(sessionId)) throw new Error("Session not found");
  return { evidence: evidence.list(sessionId, stringParam(params, "cursor", false), numberParam(params, "limit", 30)) };
}

export function getEvidence(manager: EvidenceManager, params: Record<string, unknown>) {
  const evidence = manager.get(stringParam(params, "evidenceId")!);
  if (!evidence) throw new Error("Evidence not found");
  return { evidence: evidenceSummary(evidence) };
}

export function getEvidenceDetails(evidence: EvidenceManager, params: Record<string, unknown>) {
  const kind = stringParam(params, "kind");
  if (kind !== "tools" && kind !== "artifacts") throw new Error("Unknown evidence detail kind");
  const page = evidence.details(
    stringParam(params, "evidenceId")!, kind,
    stringParam(params, "cursor", false), numberParam(params, "limit", 30),
  );
  if (!page) throw new Error("Evidence not found");
  return { page };
}

export async function handleFileUpload(
  uploads: FileUploadManager,
  allSessions: () => BridgeSessionInfo[],
  method: string,
  params: Record<string, unknown>,
  sourceDeviceId?: string,
) {
  const owner = sourceDeviceId ?? "desktop";
  if (method === "file.upload.open") {
    const sessionId = stringParam(params, "sessionId")!;
    const session = allSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) throw new Error("Session not found");
    if (session.allowedActions?.canSend === false) throw new Error("当前会话不允许上传文件");
    return { upload: await uploads.open({
      owner,
      sessionId,
      cwd: session.cwd,
      name: stringParam(params, "name")!,
      size: integerParam(params, "size"),
      sha256: stringParam(params, "sha256")!,
    }) };
  }
  const uploadId = stringParam(params, "uploadId")!;
  if (method === "file.upload.write") {
    return { received: uploads.write(uploadId, integerParam(params, "index"), stringParam(params, "data", false) ?? "", owner) };
  }
  if (method === "file.upload.commit") return { file: await uploads.commit(uploadId, owner) };
  return { cancelled: uploads.cancel(uploadId, owner) };
}

export async function previewArtifact(evidence: EvidenceManager, params: Record<string, unknown>) {
  return { preview: await evidence.preview(stringParam(params, "artifactId")!) };
}

export async function openArtifactTransfer(
  evidence: EvidenceManager,
  broker: Pick<ClaudeDesktopBridge, "readNativeImage" | "executionCwd" | "resolveSessionFile">,
  allSessions: () => BridgeSessionInfo[],
  params: Record<string, unknown>,
  sourceDeviceId?: string,
) {
  const owner = sourceDeviceId ?? "desktop";
  const textPreview = params.purpose === "text-preview";
  if (params.nativeImage !== undefined) {
    if (!isBridgeNativeImageRef(params.nativeImage)) throw new Error("Invalid native image reference");
    const image = await broker.readNativeImage(stringParam(params, "sessionId")!, params.nativeImage);
    return { transfer: evidence.openBytesTransfer(image, owner) };
  }
  const artifactId = stringParam(params, "artifactId", false);
  if (artifactId) {
    if (params.purpose === "stat") return { metadata: await evidence.artifactTransferMetadata(artifactId) };
    return { transfer: await evidence.openTransfer(artifactId, owner, textPreview) };
  }
  const sessionId = stringParam(params, "sessionId")!;
  const filePath = stringParam(params, "path")!;
  const session = allSessions().find((candidate) => candidate.sessionId === sessionId);
  if (!session) throw new Error("Session not found");
  const readCwd = broker.executionCwd(sessionId);
  const resolveRelativePath = params.resolveRelativeLink === true
    ? (path: string) => broker.resolveSessionFile(sessionId, path)
    : undefined;
  if (params.purpose === "stat") {
    return { metadata: await evidence.fileTransferMetadata(session.cwd, filePath, readCwd, resolveRelativePath) };
  }
  return { transfer: await evidence.openFileTransfer(session.cwd, filePath, owner, textPreview, readCwd, resolveRelativePath) };
}

export function readArtifactTransfer(evidence: EvidenceManager, params: Record<string, unknown>, sourceDeviceId?: string) {
  return {
    chunk: evidence.readTransfer(stringParam(params, "transferId")!, integerParam(params, "index"), sourceDeviceId ?? "desktop"),
  };
}

export function closeArtifactTransfer(evidence: EvidenceManager, params: Record<string, unknown>, sourceDeviceId?: string) {
  return { closed: evidence.closeTransfer(stringParam(params, "transferId")!, sourceDeviceId ?? "desktop") };
}
