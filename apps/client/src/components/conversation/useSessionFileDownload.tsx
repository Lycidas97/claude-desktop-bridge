import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { mediaKind } from "../../lib/media-preview.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { useMediaPreview } from "../evidence/MediaPreviewProvider.js";

export function useSessionFileDownload(
  sessionId: string,
  isMobile: boolean,
  onDownloadSessionFile: ((sessionId: string, filePath: string) => Promise<void>) | undefined,
) {
  const openMedia = useMediaPreview();
  const [pendingFileDownload, setPendingFileDownload] = useState<string>();
  const [fileDownloadBusy, setFileDownloadBusy] = useState(false);
  const [fileDownloadError, setFileDownloadError] = useState<string>();

  function requestDownload(filePath: string): void {
    setFileDownloadError(undefined);
    setPendingFileDownload(filePath);
  }

  function closeDownload(): void {
    if (!fileDownloadBusy) setPendingFileDownload(undefined);
  }

  function openFile(filePath: string): void {
    const kind = mediaKind(filePath);
    if (kind) {
      openMedia({
        name: filePath.split(/[\\/]/u).at(-1) || filePath,
        kind,
        sessionId,
        path: filePath,
      });
      return;
    }
    requestDownload(filePath);
  }

  return {
    openFile,
    requestDownload,
    closeDownload,
    pendingPath: pendingFileDownload,
    busy: fileDownloadBusy,
    resetSelection() {
      setPendingFileDownload(undefined);
      setFileDownloadError(undefined);
    },
    dialog: (
      <ConfirmationDialog
        open={Boolean(pendingFileDownload)}
        title={isMobile ? "确认下载远程文件到手机？" : "确认下载工作区文件？"}
        description={pendingFileDownload
          ? (isMobile
              ? `即将从电脑工作区下载「${pendingFileDownload.split(/[\\/]/u).at(-1) || pendingFileDownload}」（${pendingFileDownload}）到手机端，是否继续？`
              : `即将从工作区下载「${pendingFileDownload.split(/[\\/]/u).at(-1) || pendingFileDownload}」（${pendingFileDownload}），是否继续？`)
          : ""}
        confirmLabel="确认下载"
        busy={fileDownloadBusy}
        onCancel={closeDownload}
        onConfirm={() => {
          if (!pendingFileDownload || !onDownloadSessionFile || fileDownloadBusy) return;
          setFileDownloadBusy(true);
          setFileDownloadError(undefined);
          void onDownloadSessionFile(sessionId, pendingFileDownload)
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
