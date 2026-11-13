import type { BridgeToolCallDetail, BridgeToolCallStatus, BridgeToolResultOmittedBlock } from "@bridge/protocol";
import { AlertCircle, Check, ChevronRight, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationItem } from "../../lib/conversation-timeline.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { MessageCopyButton } from "../common/MessageCopyButton.js";
import { useMediaRequest } from "../evidence/MediaPreviewProvider.js";
import { MobileSheet } from "../mobile/MobileSheet.js";
import "./ToolCallDetailSheet.css";

const MAX_CACHED_TOOL_DETAILS = 200;
const toolDetailCache = new Map<string, BridgeToolCallDetail>();
const inFlightToolDetails = new Map<string, Promise<BridgeToolCallDetail>>();

export function clearToolCallDetailCache(): void {
  toolDetailCache.clear();
  inFlightToolDetails.clear();
}

function detailCacheKey(hostId: string | undefined, sessionId: string, toolUseId: string, agentId?: string): string {
  return `${hostId ?? "local"}\0${sessionId}\0${agentId ?? ""}\0${toolUseId}`;
}

function rememberCompletedDetail(key: string, detail: BridgeToolCallDetail): void {
  if (detail.status === "running") {
    toolDetailCache.delete(key);
    return;
  }
  if (toolDetailCache.has(key)) {
    toolDetailCache.delete(key);
  } else if (toolDetailCache.size >= MAX_CACHED_TOOL_DETAILS) {
    const oldest = toolDetailCache.keys().next().value;
    if (oldest !== undefined) toolDetailCache.delete(oldest);
  }
  toolDetailCache.set(key, detail);
}

function formatDetailBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatOmittedBlock(block: BridgeToolResultOmittedBlock): string {
  const kindLabel = block.type === "image"
    ? "图片内容块"
    : block.type === "document"
      ? "文档内容块"
      : `${block.type} 非文本内容块`;
  const mime = block.mimeType ? ` (${block.mimeType})` : "";
  return `已省略 ${block.count} 个${kindLabel}${mime}`;
}

const STATUS_LABELS: Record<BridgeToolCallStatus, string> = {
  running: "运行中",
  completed: "已完成",
  error: "执行出错",
};

export function ToolCallDetailSheet({
  hostId,
  sessionId,
  toolUseId,
  agentId,
  toolName,
  fallbackText,
  fallbackRunning = false,
  fallbackError = false,
  supportsToolDetail,
  onClose,
}: {
  hostId?: string;
  sessionId: string;
  toolUseId: string;
  agentId?: string;
  toolName: string;
  fallbackText?: string;
  fallbackRunning?: boolean;
  fallbackError?: boolean;
  supportsToolDetail: boolean;
  onClose(): void;
}) {
  const request = useMediaRequest();
  const requestRef = useRef(request);
  requestRef.current = request;
  const hasRequest = Boolean(request);
  const cacheKey = detailCacheKey(hostId, sessionId, toolUseId, agentId);
  const initialCached = toolDetailCache.get(cacheKey);
  const [detail, setDetail] = useState<BridgeToolCallDetail | undefined>(initialCached);
  const [loading, setLoading] = useState<boolean>(
    Boolean(supportsToolDetail && hasRequest && (!initialCached || initialCached.status === "running")),
  );
  const [fetchError, setFetchError] = useState<string | undefined>(undefined);
  const [reloadNonce, setReloadNonce] = useState(0);

  const reload = useCallback(() => {
    setReloadNonce((prev) => prev + 1);
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", escape);
    const unregister = registerMobileBackHandler(() => {
      onClose();
      return true;
    }, 150);
    return () => {
      document.removeEventListener("keydown", escape);
      unregister();
    };
  }, [onClose]);

  useEffect(() => {
    const sendRequest = requestRef.current;
    if (!supportsToolDetail || !hasRequest || !sendRequest) {
      setLoading(false);
      return;
    }
    const cached = toolDetailCache.get(cacheKey);
    if (reloadNonce === 0 && cached && cached.status !== "running") {
      setDetail(cached);
      setFetchError(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFetchError(undefined);
    let pending = reloadNonce === 0 ? inFlightToolDetails.get(cacheKey) : undefined;
    if (!pending) {
      pending = sendRequest(
        "session.tool.detail",
        {
          sessionId,
          toolUseId,
          ...(agentId ? { agentId } : {}),
        },
        { wait: true, timeoutMs: 30_000 },
      )
        .then((response) => {
          if (!response?.ok) {
            throw new Error(response?.error?.message ?? "工具详情加载失败");
          }
          const loaded = (response.result as { detail?: BridgeToolCallDetail } | undefined)?.detail;
          if (!loaded) {
            throw new Error("工具详情响应格式无效");
          }
          rememberCompletedDetail(cacheKey, loaded);
          return loaded;
        })
        .finally(() => {
          if (inFlightToolDetails.get(cacheKey) === pending) {
            inFlightToolDetails.delete(cacheKey);
          }
        });
      inFlightToolDetails.set(cacheKey, pending);
    }
    pending
      .then((loaded) => {
        if (cancelled) return;
        setDetail(loaded);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setFetchError(reason instanceof Error ? reason.message : "工具详情加载失败");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, cacheKey, hasRequest, reloadNonce, sessionId, supportsToolDetail, toolUseId]);

  const resolvedName = detail?.toolName || toolName || "工具";
  const status: BridgeToolCallStatus = detail?.status
    ?? (fallbackError ? "error" : fallbackRunning ? "running" : "completed");

  const isBash = resolvedName === "Bash" && detail && !detail.inputTruncated && typeof detail.input.command === "string";
  const bashCommand = isBash ? String(detail.input.command) : undefined;
  const bashDescription = isBash && typeof detail.input.description === "string" && detail.input.description.trim()
    ? detail.input.description.trim()
    : undefined;
  const bashExtraEntries = isBash
    ? Object.entries(detail.input).filter(([key, val]) => key !== "command" && key !== "description" && val !== undefined)
    : [];
  const formattedJsonInput = detail && !isBash
    ? (detail.inputTruncated ? (detail.inputText ?? "") : JSON.stringify(detail.input, null, 2))
    : undefined;

  return (
    <MobileSheet
      eyebrow={(
        <span className={`tool-detail-status is-${status}`}>
          {status === "running"
            ? <LoaderCircle className="is-spinning" size={12} aria-hidden="true" />
            : status === "error"
              ? <AlertCircle size={12} aria-hidden="true" />
              : <Check size={12} aria-hidden="true" />}
          {STATUS_LABELS[status]}
        </span>
      )}
      title={resolvedName}
      closeLabel="关闭工具详情"
      onClose={onClose}
    >
      <div className="tool-detail-body">
        {!supportsToolDetail && (
          <>
            {fallbackText && fallbackText !== resolvedName && (
              <section className="tool-detail-section" aria-label="入参摘要">
                <div className="tool-detail-section-header">
                  <span className="tool-detail-section-label">入参摘要</span>
                  <MessageCopyButton text={fallbackText} label="复制入参摘要" />
                </div>
                <pre className="tool-detail-code"><code>{fallbackText}</code></pre>
              </section>
            )}
            <div className="tool-detail-notice">电脑端版本较旧，升级后可按需加载完整工具输出。</div>
          </>
        )}

        {supportsToolDetail && loading && !detail && (
          <div className="tool-detail-loading" role="status">
            <span className="tool-detail-loading-label">
              <LoaderCircle className="is-spinning" size={15} aria-hidden="true" />
              正在加载工具详情…
            </span>
          </div>
        )}

        {supportsToolDetail && fetchError && (
          <div className="tool-detail-fetch-error" role="alert">
            <span>{fetchError}</span>
            <button type="button" className="tool-detail-retry-btn" onClick={reload}>重试</button>
          </div>
        )}

        {detail && isBash && bashCommand !== undefined && (
          <section className="tool-detail-section" aria-label="命令">
            {bashDescription && <p className="tool-detail-description">{bashDescription}</p>}
            <div className="tool-detail-section-header">
              <span className="tool-detail-section-label">命令</span>
              {bashCommand && <MessageCopyButton text={bashCommand} label="复制命令" />}
            </div>
            <pre className="tool-detail-code is-terminal"><code>{bashCommand}</code></pre>
            {bashExtraEntries.length > 0 && (
              <pre className="tool-detail-code"><code>{JSON.stringify(Object.fromEntries(bashExtraEntries), null, 2)}</code></pre>
            )}
          </section>
        )}

        {detail && !isBash && formattedJsonInput !== undefined && (
          <section className="tool-detail-section" aria-label="入参">
            <div className="tool-detail-section-header">
              <span className="tool-detail-section-label">
                入参
                {detail.inputTruncated && <span className="tool-detail-meta">已截断（展示前 256 KiB）</span>}
              </span>
              {formattedJsonInput && <MessageCopyButton text={formattedJsonInput} label="复制入参" />}
            </div>
            <pre className="tool-detail-code"><code>{formattedJsonInput}</code></pre>
          </section>
        )}

        {detail && (
          <section className="tool-detail-section" aria-label={detail.isError ? "错误输出" : "执行输出"}>
            <div className="tool-detail-section-header">
              <span className={`tool-detail-section-label${detail.isError ? " is-error" : ""}`}>
                {detail.isError ? "错误输出" : "执行输出"}
                {detail.truncated && (
                  <span className="tool-detail-meta">
                    已截断（共 {formatDetailBytes(detail.totalBytes)}，展示前 256 KiB）
                  </span>
                )}
              </span>
              {detail.outputText ? <MessageCopyButton text={detail.outputText} label="复制输出" /> : null}
            </div>

            {detail.status === "running" ? (
              <div className="tool-detail-notice">
                <span>工具正在执行，尚未返回输出</span>
                <button type="button" className="tool-detail-retry-btn" disabled={loading} onClick={reload}>
                  {loading ? "刷新中…" : "刷新"}
                </button>
              </div>
            ) : (
              <>
                {detail.omittedBlocks && detail.omittedBlocks.length > 0 && (
                  <div className="tool-detail-omitted-list">
                    {detail.omittedBlocks.map((block, index) => (
                      <div className="tool-detail-notice" key={`${block.type}:${block.mimeType ?? ""}:${index}`}>
                        <span>{formatOmittedBlock(block)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {detail.outputText ? (
                  <pre className={`tool-detail-code is-terminal${detail.isError ? " is-error" : ""}`}>
                    <code>{detail.outputText}</code>
                  </pre>
                ) : (
                  (!detail.omittedBlocks || detail.omittedBlocks.length === 0) && (
                    <div className="tool-detail-empty">无文本输出</div>
                  )
                )}
              </>
            )}
          </section>
        )}
      </div>
    </MobileSheet>
  );
}

export function ToolCallGroupRows({
  hostId,
  sessionId,
  tools,
  supportsToolDetail,
}: {
  hostId?: string;
  sessionId: string;
  tools: ConversationItem[];
  supportsToolDetail: boolean;
}) {
  const [selectedToolUseId, setSelectedToolUseId] = useState<string | undefined>(undefined);
  const selectedTool = selectedToolUseId
    ? tools.find((candidate) => candidate.toolUseId === selectedToolUseId)
    : undefined;

  return (
    <>
      <div className="conversation-tool-group-list">
        {tools.map((tool) => {
          const toolName = tool.toolName || "工具";
          const summary = tool.text && tool.text !== tool.toolName ? tool.text : undefined;
          if (!tool.toolUseId) {
            return (
              <div className={`conversation-tool-row${tool.isError ? " is-error" : ""}`} key={tool.id}>
                <strong>{toolName}</strong>
                {summary && <span>{summary}</span>}
              </div>
            );
          }
          return (
            <button
              type="button"
              className={`conversation-tool-row is-interactive${tool.isError ? " is-error" : ""}`}
              key={tool.id}
              aria-label={`查看 ${toolName} 详情${summary ? `：${summary}` : ""}`}
              onClick={() => setSelectedToolUseId(tool.toolUseId)}
            >
              <strong>{toolName}</strong>
              {summary && <span>{summary}</span>}
              <ChevronRight size={13} className="conversation-tool-row-chevron" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {selectedTool?.toolUseId && (
        <ToolCallDetailSheet
          {...(hostId ? { hostId } : {})}
          sessionId={sessionId}
          toolUseId={selectedTool.toolUseId}
          toolName={selectedTool.toolName || "工具"}
          {...(selectedTool.text ? { fallbackText: selectedTool.text } : {})}
          fallbackRunning={selectedTool.state === "running"}
          fallbackError={selectedTool.isError === true}
          supportsToolDetail={supportsToolDetail}
          onClose={() => setSelectedToolUseId(undefined)}
        />
      )}
    </>
  );
}
