import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { mediaKind } from "../../lib/media-preview.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { useMediaPreview } from "../evidence/MediaPreviewProvider.js";

export function useSessionFileDownload(
  sessionId: string,
  isMobile: boolean,
  onDownloadSessionFile: ((sessionId: string, filePath: string, resolveRelativeLink?: true, save?: true) => Promise<void>) | undefined,
  supportsRelativeLinks: boolean,
  saveAssistantOutputs = false,
) {
  const openMedia = useMediaPreview();
  const [pendingFileDownload, setPendingFileDownload] = useState<{ path: string; resolveRelativeLink?: true }>();
  const [fileDownloadBusy, setFileDownloadBusy] = useState(false);
  const [fileDownloadError, setFileDownloadError] = useState<string>();

  function requestDownload(path: string, resolveRelativeLink?: true): void {
    setFileDownloadError(undefined);
    setPendingFileDownload({ path, ...(resolveRelativeLink ? { resolveRelativeLink } : {}) });
  }

  function closeDownload(): void {
    if (!fileDownloadBusy) setPendingFileDownload(undefined);
  }

  function isAssistantOutput(path: string): boolean {
    return saveAssistantOutputs && /^(?:\.\/)?outputs\//u.test(path);
  }

  function openFile(filePath: string): void {
    const kind = isAssistantOutput(filePath) ? undefined : mediaKind(filePath);
    if (kind) {
      openMedia({
        name: filePath.split(/[\\/]/u).at(-1) || filePath,
        kind,
        sessionId,
        path: filePath,
        ...(supportsRelativeLinks ? { resolveRelativeLink: true } : {}),
      });
      return;
    }
    requestDownload(filePath, supportsRelativeLinks ? true : undefined);
  }

  const pendingPath = pendingFileDownload?.path;

  return {
    openFile,
    requestDownload,
    closeDownload,
    pendingPath,
    busy: fileDownloadBusy,
    resetSelection() {
      setPendingFileDownload(undefined);
      setFileDownloadError(undefined);
    },
    dialog: (
      <ConfirmationDialog
        open={Boolean(pendingPath)}
        title={isMobile ? "确认下载远程文件到手机？" : "确认下载工作区文件？"}
        description={pendingPath
          ? (isMobile
              ? `即将从电脑工作区下载「${pendingPath.split(/[\\/]/u).at(-1) || pendingPath}」（${pendingPath}）到手机端，是否继续？`
              : `即将从工作区下载「${pendingPath.split(/[\\/]/u).at(-1) || pendingPath}」（${pendingPath}），是否继续？`)
          : ""}
        confirmLabel="确认下载"
        busy={fileDownloadBusy}
        onCancel={closeDownload}
        onConfirm={() => {
          if (!pendingFileDownload || !onDownloadSessionFile || fileDownloadBusy) return;
          setFileDownloadBusy(true);
          setFileDownloadError(undefined);
          void onDownloadSessionFile(sessionId, pendingFileDownload.path, pendingFileDownload.resolveRelativeLink, isAssistantOutput(pendingFileDownload.path) ? true : undefined)
            .then(() => {
              setPendingFileDownload(undefined);
            })
            .catch((downloadError) => {
              setPendingFileDownload(undefined);
              setFileDownloadError(
                downloadError instanceof Error
                  ? downloadError.message
                  : isMobile ? "远程文件下载失败" : "文件下载失败",
              );
            })
            .finally(() => {
              setFileDownloadBusy(false);
            });
        }}
      />
    ),
    warning: fileDownloadError && (
      <div className="session-channel-warning danger" role="alert">
        <AlertTriangle size={17} />
        <span><strong>文件下载失败</strong>{fileDownloadError}</span>
        <button type="button" className="secondary-button goal-action" onClick={() => setFileDownloadError(undefined)}>关闭</button>
      </div>
    ),
  };
}
