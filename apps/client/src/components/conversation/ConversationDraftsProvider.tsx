import type {
  BridgeAttachment,
  BridgeHostSnapshot,
  BridgeSessionInfo,
  BridgeSessionRewindResult,
  BridgeUploadedFile,
} from "@bridge/protocol";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { sessionCommandName } from "../../hooks/useSessionCommands.js";
import { canSendSession, fileToAttachment } from "../../lib/conversation-timeline.js";
import { registerDiagnosticsStateProvider } from "../../lib/diagnostics.js";
import { appendUploadedFilePaths, type UploadFileHandler } from "../../lib/file-upload.js";
import type { useFileAttachments } from "../evidence/FileAttachmentPicker.js";
import type { QueuedTurnActionState } from "./ConversationMessageItem.js";

export interface ConversationDraftState {
  text: string;
  attachments: BridgeAttachment[];
  sending: boolean;
  imageError?: string | undefined;
}

export interface ConversationFileEntry {
  id: string;
  hostId: string | undefined;
  sessionId: string;
  key: string;
  name: string;
  size: number;
  progress: number;
  result?: BridgeUploadedFile;
  error?: string;
}

interface UploadControllerRecord {
  hostId: string | undefined;
  key: string;
  controller: AbortController;
  reason?: "remove" | "clear" | "host-switch" | "unmount";
}

export interface SubmitConversationDraftOptions {
  session: BridgeSessionInfo | undefined;
  snapshot: BridgeHostSnapshot | undefined;
  canAttachImages: boolean;
  resolveMailRefId?: (() => string | undefined) | undefined;
  executeCommand(text: string, hasAttachments: boolean): Promise<boolean>;
  sendTurn(text: string, attachments: BridgeAttachment[], mailRefId?: string): Promise<unknown>;
}

export interface SubmitQuickReplyOptions {
  session: BridgeSessionInfo | undefined;
  snapshot: BridgeHostSnapshot | undefined;
  promptId: string;
  promptText: string;
  resolveMailRefId?: (() => string | undefined) | undefined;
  sendTurn(text: string, mailRefId?: string): Promise<string | null | undefined>;
}

export interface SessionConversationDraft {
  draftKey: string;
  draft: ConversationDraftState;
  promptReplies: Record<string, string | null> | undefined;
  promptError(promptId: string): string | undefined;
  queuedActions: Record<string, QueuedTurnActionState> | undefined;
  setQueuedAction(commandId: string, next: QueuedTurnActionState): void;
  fileUploads: ReturnType<typeof useFileAttachments>;
  updateDraft(change: (current: ConversationDraftState) => ConversationDraftState): void;
  setText(text: string): void;
  addImages(files: FileList | null, inputElement?: HTMLInputElement | null): Promise<void>;
  applyRewindPrefill(result: BridgeSessionRewindResult): void;
  submitMessage(options: SubmitConversationDraftOptions): Promise<void>;
  submitQuickReply(options: SubmitQuickReplyOptions): Promise<void>;
}

export interface ConversationDraftsController {
  session(
    hostId: string | undefined,
    sessionId: string | undefined,
    onUploadFile?: UploadFileHandler,
  ): SessionConversationDraft;
  resetSession(hostId: string | undefined, sessionId: string | undefined): void;
  clearHost(hostId: string): void;
}

export interface ConversationDraftsHandle {
  clearHost?: ((hostId: string) => void) | undefined;
}

const EMPTY_DRAFT: ConversationDraftState = { text: "", attachments: [], sending: false };
const MAX_SINGLE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
const HOST_SWITCH_UPLOAD_ERROR = "已切换电脑，上传已中断";
export const CONVERSATION_DRAFTS_STORAGE_KEY = "bridge-conversation-drafts:v1";
const MAX_PERSISTED_DRAFTS = 100;
const DRAFT_WRITE_INTERVAL_MS = 250;

interface PersistedDraftEntry {
  key: string;
  text: string;
  updatedAt: number;
}

function safeLocalStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    if (typeof window === "undefined" && descriptor?.get) {
      return undefined;
    }
    const storage = descriptor?.value ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    if (
      storage
      && typeof storage.getItem === "function"
      && typeof storage.setItem === "function"
      && typeof storage.removeItem === "function"
    ) {
      return storage as Pick<Storage, "getItem" | "setItem" | "removeItem">;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isValidDraftStorageKey(key: string): boolean {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 2) return false;
    const [hostId, sessionId] = parsed;
    return (hostId === null || typeof hostId === "string")
      && typeof sessionId === "string"
      && sessionId.length > 0;
  } catch {
    return false;
  }
}

function readPersistedDrafts(raw: string | null): Map<string, PersistedDraftEntry> {
  const drafts = new Map<string, PersistedDraftEntry>();
  if (!raw) return drafts;
  let parsed: { entries?: unknown } | null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return drafts;
  }
  if (!Array.isArray(parsed?.entries)) return drafts;
  for (const candidate of parsed.entries as PersistedDraftEntry[]) {
    if (
      !candidate
      || typeof candidate.key !== "string"
      || !isValidDraftStorageKey(candidate.key)
      || typeof candidate.text !== "string"
      || candidate.text.length === 0
    ) {
      continue;
    }
    drafts.set(candidate.key, {
      key: candidate.key,
      text: candidate.text,
      updatedAt: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0,
    });
  }
  return drafts;
}

function writePersistedDrafts(
  changes: ReadonlyMap<string, PersistedDraftEntry | null>,
  removedHostId?: string,
): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    const drafts = readPersistedDrafts(storage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY));
    for (const [key, entry] of changes) {
      if (entry) drafts.set(key, entry);
      else drafts.delete(key);
    }
    const entries = [...drafts.values()]
      .filter(({ key }) => removedHostId === undefined || !keyBelongsToHost(key, removedHostId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_PERSISTED_DRAFTS);
    if (entries.length === 0) {
      storage.removeItem(CONVERSATION_DRAFTS_STORAGE_KEY);
    } else {
      storage.setItem(CONVERSATION_DRAFTS_STORAGE_KEY, JSON.stringify({ version: 1, entries }));
    }
  } catch {
    // Storage quota or private-mode restrictions must not interrupt typing.
  }
}

export function conversationDraftKey(hostId: string | undefined, sessionId: string | undefined): string {
  return JSON.stringify([hostId, sessionId]);
}

function keyBelongsToHost(key: string, hostId: string): boolean {
  try {
    const [entryHostId] = JSON.parse(key) as [string | undefined, string | undefined];
    return entryHostId === hostId;
  } catch {
    return false;
  }
}

function stripHostKeys<T>(record: Record<string, T>, hostId: string): Record<string, T> {
  const keys = Object.keys(record).filter((key) => keyBelongsToHost(key, hostId));
  if (keys.length === 0) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

const ConversationDraftsContext = createContext<ConversationDraftsController | undefined>(undefined);

function useConversationDraftsController(activeHostId: string | undefined, enabled: boolean): ConversationDraftsController {
  const pendingDraftChangesRef = useRef(new Map<string, PersistedDraftEntry | null>());
  const lastStampRef = useRef(0);
  const [drafts, setDrafts] = useState<Record<string, ConversationDraftState>>(() => {
    const drafts: Record<string, ConversationDraftState> = {};
    if (!enabled) return drafts;
    let raw: string | null | undefined;
    try {
      raw = safeLocalStorage()?.getItem(CONVERSATION_DRAFTS_STORAGE_KEY);
    } catch {
      return drafts;
    }
    for (const { key, text, updatedAt } of readPersistedDrafts(raw ?? null).values()) {
      drafts[key] = { text, attachments: [], sending: false };
      lastStampRef.current = Math.max(lastStampRef.current, updatedAt);
    }
    return drafts;
  });
  const [entries, setEntries] = useState<ConversationFileEntry[]>([]);
  const [promptReplies, setPromptReplies] = useState<Record<string, Record<string, string | null>>>({});
  const [promptErrors, setPromptErrors] = useState<Record<string, Record<string, string>>>({});
  const [queuedActions, setQueuedActions] = useState<Record<string, Record<string, QueuedTurnActionState>>>({});

  // Mutation handlers publish here before React renders so lifecycle flushes see the latest text.
  const draftsRef = useRef(drafts);
  const draftWriteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const controllersRef = useRef(new Map<string, UploadControllerRecord>());
  const previousHostRef = useRef(activeHostId);
  const hostEpochRef = useRef(new Map<string, number>());

  function currentHostEpoch(hostId: string | undefined): number {
    return hostId === undefined ? 0 : (hostEpochRef.current.get(hostId) ?? 0);
  }

  function flushPersistedDrafts(removedHostId?: string): void {
    clearTimeout(draftWriteTimerRef.current);
    draftWriteTimerRef.current = undefined;
    writePersistedDrafts(pendingDraftChangesRef.current, removedHostId);
    pendingDraftChangesRef.current.clear();
  }

  function updateDraftOnKey(
    key: string,
    change: (current: ConversationDraftState) => ConversationDraftState,
  ): void {
    const previous = draftsRef.current[key] ?? EMPTY_DRAFT;
    const updated = change(previous);
    if (updated === previous) return;
    draftsRef.current = { ...draftsRef.current, [key]: updated };
    setDrafts(draftsRef.current);

    if (!enabled || updated.text === previous.text || !isValidDraftStorageKey(key)) return;
    if (updated.text.length > 0) {
      lastStampRef.current = Math.max(Date.now(), lastStampRef.current + 1);
      pendingDraftChangesRef.current.set(key, { key, text: updated.text, updatedAt: lastStampRef.current });
      draftWriteTimerRef.current ??= setTimeout(flushPersistedDrafts, DRAFT_WRITE_INTERVAL_MS);
    } else {
      pendingDraftChangesRef.current.set(key, null);
      flushPersistedDrafts();
    }
  }

  function updateEntries(change: (current: ConversationFileEntry[]) => ConversationFileEntry[]): void {
    setEntries((current) => {
      const next = change(current);
      entriesRef.current = next;
      return next;
    });
  }

  function abortHostUploads(hostId: string, reason: "host-switch" | "clear"): void {
    const abortedIds = new Set<string>();
    for (const [id, record] of controllersRef.current.entries()) {
      if (record.hostId !== hostId) continue;
      record.reason = reason;
      record.controller.abort();
      controllersRef.current.delete(id);
      abortedIds.add(id);
    }
    if (reason === "host-switch" && abortedIds.size > 0) {
      updateEntries((current) => current.map((entry) => (
        abortedIds.has(entry.id) && !entry.result
          ? { ...entry, error: HOST_SWITCH_UPLOAD_ERROR }
          : entry
      )));
    }
  }

  useEffect(() => {
    if (!enabled) {
      previousHostRef.current = activeHostId;
      return;
    }
    const previousHostId = previousHostRef.current;
    previousHostRef.current = activeHostId;
    if (previousHostId !== undefined && previousHostId !== activeHostId) {
      abortHostUploads(previousHostId, "host-switch");
    }
  }, [activeHostId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const flushPendingDrafts = () => {
      if (draftWriteTimerRef.current !== undefined) flushPersistedDrafts();
    };
    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        flushPendingDrafts();
      }
    };
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", flushPendingDrafts);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    return () => {
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("pagehide", flushPendingDrafts);
      }
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      flushPendingDrafts();
      for (const record of controllersRef.current.values()) {
        record.reason = "unmount";
        record.controller.abort();
      }
      controllersRef.current.clear();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    return registerDiagnosticsStateProvider("conversationDrafts", () => {
      const draftValues = Object.values(draftsRef.current);
      const currentEntries = entriesRef.current;
      let nonEmptyTextDrafts = 0;
      let totalTextCodeUnits = 0;
      let attachmentsCount = currentEntries.length;
      let attachmentsBytes = currentEntries.reduce((sum, entry) => sum + entry.size, 0);
      for (const draft of draftValues) {
        if (draft.text.length > 0) nonEmptyTextDrafts += 1;
        totalTextCodeUnits += draft.text.length;
        attachmentsCount += draft.attachments.length;
        for (const attachment of draft.attachments) {
          attachmentsBytes += attachment.size;
        }
      }
      const uploadingKeys = new Set<string>();
      for (const entry of currentEntries) {
        if (!entry.result && !entry.error) uploadingKeys.add(entry.key);
      }
      return {
        draftEntries: draftValues.length,
        nonEmptyTextDrafts,
        totalTextCodeUnits,
        attachmentsCount,
        attachmentsBytes,
        uploadingDraftsCount: uploadingKeys.size,
      };
    });
  }, [enabled]);

  function clearFilesOnKey(key: string, filesToClear: BridgeUploadedFile[]): void {
    if (filesToClear.length === 0) return;
    updateEntries((current) => current.filter((entry) => (
      entry.key !== key || !filesToClear.some((file) => file.uploadId === entry.result?.uploadId)
    )));
  }

  function clearHost(hostId: string): void {
    hostEpochRef.current.set(hostId, currentHostEpoch(hostId) + 1);
    abortHostUploads(hostId, "clear");
    updateEntries((current) => current.filter((entry) => entry.hostId !== hostId));
    draftsRef.current = stripHostKeys(draftsRef.current, hostId);
    setDrafts(draftsRef.current);
    if (enabled) flushPersistedDrafts(hostId);
    setPromptReplies((current) => stripHostKeys(current, hostId));
    setPromptErrors((current) => stripHostKeys(current, hostId));
    setQueuedActions((current) => stripHostKeys(current, hostId));
  }

  function resetSession(hostId: string | undefined, sessionId: string | undefined): void {
    const key = conversationDraftKey(hostId, sessionId);
    for (const [id, record] of controllersRef.current.entries()) {
      if (record.key !== key) continue;
      record.reason = "clear";
      record.controller.abort();
      controllersRef.current.delete(id);
    }
    updateEntries((current) => current.filter((entry) => entry.key !== key));
    if (key in draftsRef.current) {
      const next = { ...draftsRef.current };
      delete next[key];
      draftsRef.current = next;
      setDrafts(next);
    }
    if (enabled && sessionId) {
      pendingDraftChangesRef.current.set(key, null);
      flushPersistedDrafts();
    }
    setPromptErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setQueuedActions((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function session(
    hostId: string | undefined,
    sessionId: string | undefined,
    onUploadFile?: UploadFileHandler,
  ): SessionConversationDraft {
    const key = conversationDraftKey(hostId, sessionId);
    const renderEpoch = currentHostEpoch(hostId);
    const draft = drafts[key] ?? EMPTY_DRAFT;
    const selectedEntries = sessionId ? entries.filter((entry) => entry.key === key) : [];
    const selectedFiles = selectedEntries.flatMap((entry) => entry.result ? [entry.result] : []);
    const uploading = selectedEntries.some((entry) => !entry.result && !entry.error);

    const fileUploads: ReturnType<typeof useFileAttachments> = {
      entries: selectedEntries,
      files: selectedFiles,
      uploading,
      async add(files: FileList | null) {
        if (!sessionId || !onUploadFile || !files?.length) return;
        const targetHostId = hostId;
        const targetSessionId = sessionId;
        const targetKey = key;
        const startingEpoch = currentHostEpoch(targetHostId);
        const selectedBatch = Array.from(files, (file) => ({
          file,
          id: crypto.randomUUID(),
          controller: new AbortController(),
        }));
        const records = selectedBatch.map((item) => {
          const record: UploadControllerRecord = {
            hostId: targetHostId,
            key: targetKey,
            controller: item.controller,
          };
          controllersRef.current.set(item.id, record);
          return { ...item, record };
        });
        updateEntries((current) => [
          ...current,
          ...records.map(({ file, id }) => ({
            id,
            hostId: targetHostId,
            sessionId: targetSessionId,
            key: targetKey,
            name: file.name,
            size: file.size,
            progress: 0,
          })),
        ]);
        for (const { file, id, controller, record } of records) {
          try {
            controller.signal.throwIfAborted();
            const result = await onUploadFile(targetSessionId, file, (progress) => {
              if (controller.signal.aborted || currentHostEpoch(targetHostId) !== startingEpoch) return;
              updateEntries((current) => current.map((entry) => (
                entry.id === id ? { ...entry, progress } : entry
              )));
            }, controller.signal);
            if (controller.signal.aborted || currentHostEpoch(targetHostId) !== startingEpoch) continue;
            updateEntries((current) => current.map((entry) => (
              entry.id === id ? { ...entry, result, progress: 1 } : entry
            )));
          } catch (error) {
            if (currentHostEpoch(targetHostId) !== startingEpoch) continue;
            if (!controller.signal.aborted) {
              const message = error instanceof Error ? error.message : "文件上传失败";
              updateEntries((current) => current.map((entry) => (
                entry.id === id ? { ...entry, error: message } : entry
              )));
            } else if (record.reason === "host-switch") {
              updateEntries((current) => current.map((entry) => (
                entry.id === id && !entry.result ? { ...entry, error: HOST_SWITCH_UPLOAD_ERROR } : entry
              )));
            }
          } finally {
            controllersRef.current.delete(id);
          }
        }
      },
      remove(id: string) {
        const record = controllersRef.current.get(id);
        if (record) {
          record.reason = "remove";
          record.controller.abort();
          controllersRef.current.delete(id);
        }
        updateEntries((current) => current.filter((entry) => entry.id !== id));
      },
      clear(filesToClear: BridgeUploadedFile[]) {
        clearFilesOnKey(key, filesToClear);
      },
    };

    return {
      draftKey: key,
      draft,
      promptReplies: promptReplies[key],
      promptError: (promptId: string) => promptErrors[key]?.[promptId],
      queuedActions: queuedActions[key],
      setQueuedAction: (commandId, next) => {
        if (!commandId || currentHostEpoch(hostId) !== renderEpoch) return;
        setQueuedActions((current) => ({
          ...current,
          [key]: { ...current[key], [commandId]: next },
        }));
      },
      fileUploads,
      updateDraft: (change) => updateDraftOnKey(key, change),
      setText: (nextText) => updateDraftOnKey(key, (current) => ({ ...current, text: nextText })),
      async addImages(files: FileList | null, inputElement?: HTMLInputElement | null): Promise<void> {
        if (!files?.length) return;
        const startingEpoch = currentHostEpoch(hostId);
        updateDraftOnKey(key, (current) => ({ ...current, imageError: undefined }));
        try {
          const candidates = [...files];
          if (candidates.some((file) => file.size > MAX_SINGLE_IMAGE_BYTES)) {
            throw new Error("单张图片不能超过 4 MB");
          }
          const existingBytes = (draftsRef.current[key] ?? EMPTY_DRAFT).attachments.reduce((sum, item) => sum + item.size, 0);
          const total = candidates.reduce((sum, file) => sum + file.size, existingBytes);
          if (total > MAX_TOTAL_IMAGE_BYTES) {
            throw new Error("图片总大小不能超过 6 MB");
          }
          const next = await Promise.all(candidates.map(fileToAttachment));
          if (currentHostEpoch(hostId) !== startingEpoch) return;
          const latestBytes = (draftsRef.current[key] ?? EMPTY_DRAFT).attachments.reduce((sum, item) => sum + item.size, 0);
          const nextBytes = next.reduce((sum, item) => sum + item.size, latestBytes);
          if (nextBytes > MAX_TOTAL_IMAGE_BYTES) {
            throw new Error("图片总大小不能超过 6 MB");
          }
          updateDraftOnKey(key, (current) => ({
            ...current,
            attachments: [...current.attachments, ...next],
          }));
        } catch (error) {
          if (currentHostEpoch(hostId) !== startingEpoch) return;
          updateDraftOnKey(key, (current) => ({
            ...current,
            imageError: error instanceof Error ? error.message : "图片读取失败",
          }));
        } finally {
          if (inputElement) inputElement.value = "";
        }
      },
      applyRewindPrefill(result: BridgeSessionRewindResult): void {
        if (currentHostEpoch(hostId) !== renderEpoch || result.scope === "files") return;
        updateDraftOnKey(key, (current) => ({
          ...current,
          text: result.prefill ?? "",
          attachments: [],
        }));
        updateEntries((current) => current.filter((entry) => entry.key !== key || !entry.result));
      },
      async submitMessage({
        session: targetSession,
        snapshot,
        canAttachImages,
        resolveMailRefId,
        executeCommand,
        sendTurn,
      }: SubmitConversationDraftOptions): Promise<void> {
        const currentDraft = draftsRef.current[key] ?? EMPTY_DRAFT;
        const currentEntries = sessionId ? entriesRef.current.filter((entry) => entry.key === key) : [];
        const currentUploading = currentEntries.some((entry) => !entry.result && !entry.error);
        const nextFiles = currentEntries.flatMap((entry) => entry.result ? [entry.result] : []);
        const nextText = currentDraft.text.trim();
        const hasImages = canAttachImages && currentDraft.attachments.length > 0;
        if (
          !targetSession
          || !canSendSession(targetSession, snapshot)
          || currentDraft.sending
          || currentUploading
          || (!nextText && !hasImages && nextFiles.length === 0)
        ) {
          return;
        }
        const startingEpoch = currentHostEpoch(hostId);
        const nextAttachments = canAttachImages ? currentDraft.attachments : [];
        const hadAttachments = currentDraft.attachments.length > 0 || nextFiles.length > 0;
        updateDraftOnKey(key, (current) => ({
          ...current,
          text: "",
          attachments: [],
          sending: true,
          imageError: undefined,
        }));
        try {
          const mailRefId = resolveMailRefId?.();
          if (mailRefId && sessionCommandName(nextText)) {
            throw new Error("请先清除邮件引用，再执行会话命令。");
          }
          if (await executeCommand(nextText, hadAttachments)) return;
          await sendTurn(appendUploadedFilePaths(nextText, nextFiles), nextAttachments, mailRefId);
          if (currentHostEpoch(hostId) === startingEpoch) {
            clearFilesOnKey(key, nextFiles);
          }
        } catch (error) {
          if (currentHostEpoch(hostId) !== startingEpoch) return;
          updateDraftOnKey(key, (current) => ({
            ...current,
            imageError: error instanceof Error ? error.message : "发送失败",
            text: [nextText, current.text].filter(Boolean).join("\n"),
            attachments: [...nextAttachments, ...current.attachments],
          }));
        } finally {
          if (currentHostEpoch(hostId) === startingEpoch) {
            updateDraftOnKey(key, (current) => ({ ...current, sending: false }));
          }
        }
      },
      async submitQuickReply({
        session: targetSession,
        snapshot,
        promptId,
        promptText,
        resolveMailRefId,
        sendTurn,
      }: SubmitQuickReplyOptions): Promise<void> {
        const currentDraft = draftsRef.current[key] ?? EMPTY_DRAFT;
        const trimmed = promptText.trim();
        if (!targetSession || !canSendSession(targetSession, snapshot) || currentDraft.sending || !trimmed) {
          return;
        }
        const startingEpoch = currentHostEpoch(hostId);
        updateDraftOnKey(key, (current) => ({ ...current, sending: true }));
        setPromptErrors((current) => {
          const perSession = current[key];
          if (!perSession || !(promptId in perSession)) return current;
          const nextSessionErrors = { ...perSession };
          delete nextSessionErrors[promptId];
          return { ...current, [key]: nextSessionErrors };
        });
        try {
          const mailRefId = resolveMailRefId?.();
          if (mailRefId && sessionCommandName(trimmed)) {
            throw new Error("请先清除邮件引用，再执行会话命令。");
          }
          const requestId = await sendTurn(trimmed, mailRefId);
          if (currentHostEpoch(hostId) !== startingEpoch) return;
          setPromptReplies((current) => ({
            ...current,
            [key]: { ...current[key], [promptId]: requestId ?? null },
          }));
        } catch (error) {
          if (currentHostEpoch(hostId) !== startingEpoch) return;
          const message = error instanceof Error ? error.message : "发送失败";
          setPromptErrors((current) => ({
            ...current,
            [key]: { ...current[key], [promptId]: message },
          }));
          updateDraftOnKey(key, (current) => ({ ...current, imageError: message }));
        } finally {
          if (currentHostEpoch(hostId) === startingEpoch) {
            updateDraftOnKey(key, (current) => ({ ...current, sending: false }));
          }
        }
      },
    };
  }

  return useMemo<ConversationDraftsController>(() => ({
    session,
    resetSession,
    clearHost,
  }), [drafts, entries, promptErrors, promptReplies, queuedActions]);
}

export function ConversationDraftsProvider({
  activeHostId,
  controllerRef,
  children,
}: {
  activeHostId?: string | undefined;
  controllerRef?: ConversationDraftsHandle | undefined;
  children: ReactNode;
}) {
  const controller = useConversationDraftsController(activeHostId, true);
  if (controllerRef) controllerRef.clearHost = controller.clearHost;
  useEffect(() => () => {
    if (controllerRef) controllerRef.clearHost = undefined;
  }, [controllerRef]);
  return (
    <ConversationDraftsContext.Provider value={controller}>
      {children}
    </ConversationDraftsContext.Provider>
  );
}

export function useConversationDrafts(activeHostId?: string): ConversationDraftsController {
  const context = useContext(ConversationDraftsContext);
  const fallback = useConversationDraftsController(activeHostId, context === undefined);
  return context ?? fallback;
}
