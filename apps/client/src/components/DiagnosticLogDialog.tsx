import { useEffect, useState } from "react";
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
} from "../lib/diagnostics.js";

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

export function DiagnosticFloatingEntry() {
  const { entries, bridgeState, enabled, dialogOpen } = useDiagnosticLogs();
  const [reportText, setReportText] = useState("");
  const [idbInfo, setIdbInfo] = useState<Record<string, unknown>>({});
  const [statusNotice, setStatusNotice] = useState<string>("");
  const [probing, setProbing] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const errorCount = entries.filter((e) => e.level === "error").length;
  const conn = String(bridgeState.connection ?? "idle");
  const desktopOnline = Boolean(bridgeState.desktopOnline);

  useEffect(() => {
    if (!dialogOpen) return;
    let active = true;
    void inspectIndexedDbSummary().then((summary) => {
      if (active) setIdbInfo(summary);
    });
    void buildDiagnosticReportText().then((text) => {
      if (active) setReportText(text);
    });
    return () => {
      active = false;
    };
  }, [dialogOpen, entries.length, bridgeState, enabled]);

  async function handleCopy(): Promise<void> {
    const text = await buildDiagnosticReportText();
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
    const text = await buildDiagnosticReportText();
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
      await runRelayConnectivityProbe();
      const text = await buildDiagnosticReportText();
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
      setRepairing(false);
    }
  }

  const dotColor = desktopOnline
    ? "#22c55e"
    : conn === "connected"
      ? "#f59e0b"
      : errorCount > 0
        ? "#ef4444"
        : "#94a3b8";

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
          style={{
            position: "fixed",
            right: "12px",
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 74px)",
            zIndex: 9998,
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "5px 10px",
            borderRadius: "999px",
            border: "1px solid rgba(148, 163, 184, 0.35)",
            background: "rgba(15, 23, 42, 0.86)",
            color: "#f8fafc",
            fontSize: "11px",
            fontWeight: 600,
            boxShadow: "0 4px 14px rgba(0, 0, 0, 0.28)",
            backdropFilter: "blur(8px)",
          }}
        >
          <span
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "999px",
              background: dotColor,
              display: "inline-block",
            }}
          />
          <span>记录中 ({entries.length})</span>
        </button>
      )}

      {dialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="连接诊断与日志导出"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(2, 6, 23, 0.78)",
            display: "flex",
            flexDirection: "column",
            padding: "calc(env(safe-area-inset-top, 12px) + 8px) 12px calc(env(safe-area-inset-bottom, 12px) + 8px)",
            color: "#f1f5f9",
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          <div
            style={{
              background: "#0f172a",
              border: "1px solid rgba(148, 163, 184, 0.28)",
              borderRadius: "14px",
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 14px",
                borderBottom: "1px solid rgba(148, 163, 184, 0.2)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <div>
                <div style={{ fontSize: "14px", fontWeight: 700 }}>连接诊断与按需日志</div>
                <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                  {BUILD_DIAG_TAG} · 状态: {conn} / 电脑{desktopOnline ? "在线" : "未就绪"} · 缓存消息: {String(idbInfo.messagesCount ?? "?")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDiagDialogOpen(false)}
                style={{
                  padding: "5px 10px",
                  borderRadius: "8px",
                  border: "1px solid rgba(148, 163, 184, 0.3)",
                  background: "#1e293b",
                  color: "#f8fafc",
                  fontSize: "12px",
                }}
              >
                关闭
              </button>
            </div>

            <div
              style={{
                padding: "10px 12px",
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
                borderBottom: "1px solid rgba(148, 163, 184, 0.16)",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  const next = !enabled;
                  setDiagEnabled(next);
                  setStatusNotice(next ? "已开启按需记录（页面右下角会显示记录浮标）" : "已停止按需记录（已隐藏页面浮标）");
                }}
                style={{
                  padding: "7px 12px",
                  borderRadius: "8px",
                  border: "none",
                  background: enabled ? "#dc2626" : "#16a34a",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
              >
                {enabled ? "停止记录" : "开启按需记录"}
              </button>
              <button
                type="button"
                onClick={() => void handleCopy()}
                style={{
                  padding: "7px 12px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#2563eb",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
              >
                一键复制日志
              </button>
              <button
                type="button"
                onClick={() => void handleExportFile()}
                style={{
                  padding: "7px 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(148, 163, 184, 0.35)",
                  background: "#1e293b",
                  color: "#f8fafc",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
              >
                分享/导出 .log
              </button>
              <button
                type="button"
                onClick={() => void handleProbe()}
                disabled={probing}
                style={{
                  padding: "7px 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(148, 163, 184, 0.35)",
                  background: "#0f766e",
                  color: "#f8fafc",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
              >
                {probing ? "探测中..." : "探测中继"}
              </button>
              <button
                type="button"
                onClick={() => void handleRepair()}
                disabled={repairing}
                style={{
                  padding: "7px 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(245, 158, 11, 0.45)",
                  background: "#b45309",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
              >
                {repairing ? "修复中..." : "清理缓存并重连"}
              </button>
              <button
                type="button"
                onClick={() => clearDiagEntries()}
                style={{
                  padding: "7px 10px",
                  borderRadius: "8px",
                  border: "1px solid rgba(148, 163, 184, 0.25)",
                  background: "transparent",
                  color: "#94a3b8",
                  fontSize: "12px",
                }}
              >
                清空
              </button>
            </div>

            {statusNotice && (
              <div
                style={{
                  padding: "7px 12px",
                  background: "rgba(37, 99, 235, 0.22)",
                  color: "#bfdbfe",
                  fontSize: "12px",
                  borderBottom: "1px solid rgba(148, 163, 184, 0.16)",
                }}
              >
                {statusNotice}
              </div>
            )}

            <textarea
              readOnly
              value={reportText}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                flex: 1,
                width: "100%",
                minHeight: 0,
                padding: "10px 12px",
                background: "#020617",
                color: "#e2e8f0",
                border: "none",
                outline: "none",
                resize: "none",
                fontSize: "11px",
                lineHeight: 1.45,
                fontFamily: "var(--font-mono, monospace)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
