import type { BridgeArtifactManifest, BridgeResponse, LocalBridgeRequest } from "@bridge/protocol";
import { useRef, useState, type RefObject } from "react";
import { downloadBridgeArtifact, downloadBridgeSessionFile } from "../../lib/artifact-download.js";
import { uploadSessionFile, type UploadFileHandler } from "../../lib/file-upload.js";

type TransferInput = {
  snapshot: { host: { hostId: string } };
  apiRequest(request: LocalBridgeRequest): Promise<BridgeResponse>;
};

export function useDesktopConversationTransfers(latestRef: RefObject<TransferInput>) {
  const [artifactTransfersByHost, setArtifactTransfersByHost] = useState<Record<string, Record<string, number>>>({});
  const transfersRef = useRef(artifactTransfersByHost);
  transfersRef.current = artifactTransfersByHost;
  const activeUploadsRef = useRef(0);

  function setHostTransfer(hostId: string, transferKey: string, progress: number | undefined): void {
    setArtifactTransfersByHost((current) => {
      const hostTransfers = current[hostId] ?? {};
      if (progress === undefined) {
        if (!(transferKey in hostTransfers)) return current;
        const nextHost = { ...hostTransfers };
        delete nextHost[transferKey];
        return { ...current, [hostId]: nextHost };
      }
      return {
        ...current,
        [hostId]: { ...hostTransfers, [transferKey]: progress },
      };
    });
  }

  function createHostBoundTransferRequest(startingHostId: string, switchedHostMessage: string) {
    const startingRequest = latestRef.current.apiRequest;
    return async (method: LocalBridgeRequest["method"], params: Record<string, unknown>): Promise<BridgeResponse> => {
      if (latestRef.current.snapshot.host.hostId !== startingHostId) {
        throw new Error(switchedHostMessage);
      }
      const response = await startingRequest({ method, params });
      if (latestRef.current.snapshot.host.hostId !== startingHostId) {
        throw new Error(switchedHostMessage);
      }
      return response;
    };
  }

  async function downloadArtifact(
    artifact: BridgeArtifactManifest,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): Promise<void> {
    const transferRequest = createHostBoundTransferRequest(targetHostId, "电脑已切换，文件传输已取消");
    setHostTransfer(targetHostId, artifact.id, 0);
    try {
      await downloadBridgeArtifact(
        artifact,
        transferRequest,
        (progress) => {
          if (latestRef.current.snapshot.host.hostId === targetHostId) {
            setHostTransfer(targetHostId, artifact.id, progress);
          }
        },
      );
    } finally {
      setHostTransfer(targetHostId, artifact.id, undefined);
    }
  }

  async function downloadSessionFile(
    sessionId: string,
    filePath: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
    resolveRelativeLink?: true,
  ): Promise<void> {
    const transferKey = `file:${filePath}`;
    const transferRequest = createHostBoundTransferRequest(targetHostId, "电脑已切换，文件传输已取消");
    setHostTransfer(targetHostId, transferKey, 0);
    try {
      await downloadBridgeSessionFile(
        sessionId,
        filePath,
        transferRequest,
        (progress) => {
          if (latestRef.current.snapshot.host.hostId === targetHostId) {
            setHostTransfer(targetHostId, transferKey, progress);
          }
        },
        resolveRelativeLink,
      );
    } finally {
      setHostTransfer(targetHostId, transferKey, undefined);
    }
  }

  const uploadFile: UploadFileHandler = async (sessionId, file, onProgress, signal) => {
    const transferRequest = createHostBoundTransferRequest(latestRef.current.snapshot.host.hostId, "电脑已切换，文件上传已取消");
    activeUploadsRef.current += 1;
    try {
      return await uploadSessionFile(transferRequest, sessionId, file, onProgress, signal);
    } finally {
      activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
    }
  };

  return {
    artifactTransfersByHost,
    downloadArtifact,
    downloadSessionFile,
    uploadFile,
    readTransferDiagnostics() {
      return {
        hostIds: Object.keys(transfersRef.current),
        artifactTransfersCount: Object.values(transfersRef.current).reduce((count, transfers) => count + Object.keys(transfers).length, 0),
        activeUploads: activeUploadsRef.current,
      };
    },
  };
}
