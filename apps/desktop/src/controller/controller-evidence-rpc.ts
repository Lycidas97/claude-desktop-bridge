import { ARTIFACT_MAX_BYTES, evidenceSummary, isBridgeNativeImageRef, mailAttachmentPreviewKind, type BridgeSessionInfo } from "@bridge/protocol";
import { MailAttachmentError } from "../../../../plugins/assistant-mail/desktop.js";
import type { ClaudeDesktopBridge } from "../claude/claude-desktop-bridge.js";
import type { EvidenceManager } from "../evidence/evidence-manager.js";
import type { FileUploadManager } from "../evidence/file-upload.js";
import { parseMailAttachmentRef } from "./assistant-mail.js";
import type { ControllerRpcHost } from "./controller-rpc.js";
import { BridgeRequestError, integerParam, numberParam, stringParam } from "./request-error.js";

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

export async function handleArtifactTarget(
  host: Pick<ControllerRpcHost, "evidence" | "broker" | "allSessions" | "assistantMail">,
  method: "artifact.preview" | "artifact.transfer.open",
  params: Record<string, unknown>,
  origin: "desktop" | "mobile",
  sourceDeviceId?: string,
) {
  if (params.mailAttachment !== undefined) {
    if (!host.assistantMail) throw new BridgeRequestError("UNSUPPORTED", "当前电脑不支持邮件附件。");
    if (["artifactId", "sessionId", "path", "nativeImage", "resolveRelativeLink"].some(key => params[key] !== undefined)) {
      throw new BridgeRequestError("INVALID_PARAMS", "需要独立的邮件附件引用。");
    }
    const ref = parseMailAttachmentRef(params.mailAttachment);
    try {
      const { filename: name, mimeType, size } = host.assistantMail.attachment(ref);
      if (method === "artifact.transfer.open" && params.purpose === "stat") return { metadata: { name, mimeType, size } };
      if (method === "artifact.preview" && mailAttachmentPreviewKind(mimeType) !== "image") {
        throw new BridgeRequestError("UNSUPPORTED", "此附件不支持图片预览。");
      }
      const bytes = await host.assistantMail.attachmentBytes(ref, ARTIFACT_MAX_BYTES);
      const artifactId = `mail:${ref.mailRefId}:${ref.attachmentId}`;
      return method === "artifact.preview"
        ? { preview: await host.evidence.previewUnstoredImage(artifactId, bytes, mimeType) }
        : { transfer: host.evidence.openBytesTransfer({ artifactId, name, mimeType, bytes }, sourceDeviceId ?? origin) };
    } catch (error) {
      if (error instanceof MailAttachmentError) throw new BridgeRequestError(error.code, error.message);
      throw error;
    }
  }
  if (method === "artifact.preview") return { preview: await host.evidence.preview(stringParam(params, "artifactId")!) };
  return openArtifactTransfer(host.evidence, host.broker, () => host.allSessions(), params, sourceDeviceId);
}

async function openArtifactTransfer(
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
