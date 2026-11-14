import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { DesktopControlSnapshot } from "@bridge/protocol";
import {
  BUILD_DIAG_TAG,
  buildDiagnosticReportText,
  clearDiagEntries,
  inspectIndexedDbSummary,
  repairVaultAndReconnect,
  runRelayConnectivityProbe,
  setDiagDialogOpen,
  setDiagEnabled,
  useDiagnosticLogs,
} from "../../lib/diagnostics.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { IconButton } from "./IconButton.js";
import "./diagnostic-log.css";

function copyTextFallback(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function DiagnosticFloatingEntry({ desktopSnapshot }: { desktopSnapshot?: DesktopControlSnapshot } = {}) {
  const { entries, bridgeState, enabled, dialogOpen } = useDiagnosticLogs();
  const [reportText, setReportText] = useState("");
  const [idbInfo, setIdbInfo] = useState<Record<string, unknown>>({});
  const [statusNotice, setStatusNotice] = useState<string>("");
  const [probing, setProbing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairConfirmOpen, setRepairConfirmOpen] = useState(false);

  useEffect(() => {
    if (!dialogOpen) return;
    return registerMobileBackHandler(() => {
      setRepairConfirmOpen(false);
      setDiagDialogOpen(false);
      return true;
    }, 400);
  }, [dialogOpen]);

  useEffect(() => {
    if (!dialogOpen || !repairConfirmOpen) return;
    return registerMobileBackHandler(() => {
      if (!repairing) setRepairConfirmOpen(false);
      return true;
    }, 450);
  }, [dialogOpen, repairConfirmOpen, repairing]);

  const errorCount = entries.filter((e) => e.level === "error").length;
  const conn = desktopSnapshot?.connection ?? String(bridgeState.connection ?? "idle");
  const desktopOnline = desktopSnapshot?.host.online ?? Boolean(bridgeState.desktopOnline);

  useEffect(() => {
    if (!dialogOpen) return;
    let active = true;
    if (!desktopSnapshot) {
      void inspectIndexedDbSummary().then((summary) => {
        if (active) setIdbInfo(summary);
      });
    }
    void buildDiagnosticReportText(desktopSnapshot).then((text) => {
      if (active) setReportText(text);
    });
    return () => {
      active = false;
    };
  }, [dialogOpen, entries.length, bridgeState, enabled, desktopSnapshot]);

  async function handleCopy(): Promise<void> {
    const text = await buildDiagnosticReportText(desktopSnapshot);
    setReportText(text);
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      copied = copyTextFallback(text);
    }
    setStatusNotice(copied ? "已复制到剪贴板，可直接粘贴发给 Claude" : "自动复制受限，请长按下方文本框全选复制");
  }

  async function handleExportFile(): Promise<void> {
    const text = await buildDiagnosticReportText(desktopSnapshot);
    setReportText(text);
    const filename = `bridge-diag-${new Date().toISOString().replace(/[:.]/gu, "-")}.log`;
    try {
      const file = new File([text], filename, { type: "text/plain;charset=utf-8" });
      if (typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share({
          title: "Bridge 诊断日志",
          text,
          files: [file],
        });
        setStatusNotice("已拉起系统分享/导出");
        return;
      }
    } catch {
      // Fall through to blob download / copy fallback
    }
    try {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
      setStatusNotice(`已触发下载: ${filename}`);
    } catch {
      const copied = copyTextFallback(text);
      setStatusNotice(copied ? "导出已转为复制到剪贴板" : "请在下方文本框长按全选复制");
    }
  }

  async function handleProbe(): Promise<void> {
    if (probing) return;
    setProbing(true);
    setStatusNotice("正在探测中继连通性...");
    try {
      await runRelayConnectivityProbe(desktopSnapshot?.host.relayUrl);
      const text = await buildDiagnosticReportText(desktopSnapshot);
      setReportText(text);
      setStatusNotice("探测完成，结果已追加至底部日志");
    } finally {
      setProbing(false);
    }
  }

  async function handleRepair(): Promise<void> {
    if (repairing) return;
    setRepairing(true);
    setStatusNotice("正在清理旧缓存并重置私有中继路由...");
    try {
      await repairVaultAndReconnect();
      setStatusNotice("修复完成，正在重新加载...");
      setTimeout(() => {
        window.location.reload();
      }, 400);
    } catch (error) {
      setStatusNotice(`修复失败: ${error instanceof Error ? error.message : String(error)}`);
      setRepairConfirmOpen(false);
      setRepairing(false);
    }
  }

  const dotState = desktopOnline
    ? "is-online"
    : conn === "connected"
      ? "waiting"
      : errorCount > 0
        ? "failed"
        : "";

  if (!enabled && !dialogOpen) {
    return null;
  }

  return (
    <>
      {enabled && (
        <button
          type="button"
          onClick={() => setDiagDialogOpen(true)}
          aria-label="打开连接诊断日志"
          className="secondary-button diagnostic-floating-entry"
        >
          <span className={`m-status-dot ${dotState}`} aria-hidden="true" />
          <span>记录中 ({entries.length})</span>
        </button>
      )}

      {dialogOpen && (
        <div className="m-sheet-backdrop diagnostic-backdrop">
          <section
            className="m-sheet diagnostic-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="连接诊断与日志导出"
          >
            <header className="m-sheet-header">
              <div>
                <h2>连接诊断与按需日志</h2>
                <span className="diagnostic-meta">
                  {BUILD_DIAG_TAG} · 状态: {conn} / 电脑{desktopOnline ? "在线" : "未就绪"}
                  {!desktopSnapshot && <> · 缓存消息: {String(idbInfo.messagesCount ?? "?")}</>}
                </span>
              </div>
              <IconButton label="关闭" onClick={() => {
                setRepairConfirmOpen(false);
                setDiagDialogOpen(false);
              }}><X size={20} /></IconButton>
            </header>

            <div className="m-sheet-body diagnostic-body">
              <div className="diagnostic-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    const next = !enabled;
                    setDiagEnabled(next);
                    setStatusNotice(next ? "已开启按需记录（页面右下角会显示记录浮标）" : "已停止按需记录（已隐藏页面浮标）");
                  }}
                >
                  {enabled ? "停止记录" : "开启按需记录"}
                </button>
                <button type="button" className="primary-button" onClick={() => void handleCopy()}>
                  一键复制日志
                </button>
              </div>
              <div className="diagnostic-tools">
                <button type="button" className="secondary-button" onClick={() => void handleExportFile()}>
                  分享/导出 .log
                </button>
                <button type="button" className="secondary-button" onClick={() => void handleProbe()} disabled={probing}>
                  {probing ? "探测中..." : "探测中继"}
                </button>
                <button type="button" className="secondary-button" onClick={() => clearDiagEntries()}>
                  清空
                </button>
              </div>

              {!desktopSnapshot && (
                <details className="diagnostic-repair">
                  <summary>高级修复</summary>
                  <p>
                    此操作影响手机保存的所有电脑：清空全部缓存消息和待发送消息，重置所有电脑的中继连接路由，并重新加载应用。
                  </p>
                  <button type="button" className="danger-button" onClick={() => setRepairConfirmOpen(true)} disabled={repairing}>
                    {repairing ? "修复中..." : "清理所有电脑缓存并重连…"}
                  </button>
                </details>
              )}

              <p className="diagnostic-notice" role="status">{statusNotice}</p>

              <textarea
                className="diagnostic-report"
                aria-label="诊断日志"
                readOnly
                wrap="off"
                value={reportText}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          </section>

          {repairConfirmOpen && (
            <div
              role="presentation"
              className="confirm-backdrop diagnostic-confirm-backdrop"
              onMouseDown={(event) => {
                if (event.currentTarget === event.target && !repairing) setRepairConfirmOpen(false);
              }}
            >
              <section role="alertdialog" aria-modal="true" aria-labelledby="diag-repair-title" aria-describedby="diag-repair-description" className="confirm-dialog diagnostic-confirm">
                <h2 id="diag-repair-title">清理所有电脑的手机缓存？</h2>
                <p id="diag-repair-description">
                  这会清空手机上所有已配对电脑的缓存消息和待发送消息，并重置它们的中继连接路由。待发送消息无法恢复；完成后应用会重新加载。
                </p>
                <div className="confirm-actions">
                  <button type="button" className="secondary-button" disabled={repairing} onClick={() => setRepairConfirmOpen(false)}>取消</button>
                  <button type="button" className="danger-button" disabled={repairing} onClick={() => void handleRepair()}>{repairing ? "修复中…" : "确认清理并重连"}</button>
                </div>
              </section>
            </div>
          )}
        </div>
      )}
    </>
  );
}
