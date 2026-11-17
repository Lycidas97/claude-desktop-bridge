import type {
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeEvent,
  BridgeHostSnapshot,
  BridgeResponse,
  BridgeSessionInfo,
  BridgeToolCallDetail,
  DesktopControlSnapshot,
} from "@bridge/protocol";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationDraftsProvider,
  useConversationDrafts,
  type ConversationDraftsController,
} from "../components/conversation/ConversationDraftsProvider.js";
import {
  ToolCallDetailSheet,
  clearToolCallDetailCache,
} from "../components/conversation/ToolCallDetailSheet.js";
import {
  DesktopConversationProvider,
  useDesktopConversation,
  type DesktopConversationController,
} from "../components/desktop/DesktopSessionConversation.js";
import type { MediaRequest } from "./media-preview.js";
import { useMobileBridge } from "../hooks/useMobileBridge.js";
import { collectDiagnosticsStateSnapshot } from "./diagnostics.js";

interface HookStore {
  slots: any[];
  index: number;
  memos: Array<{ value: unknown; deps: unknown[] | undefined }>;
  memoIndex: number;
  dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number;
  pending: Array<() => void>;
}

const runtime = vi.hoisted(() => ({
  currentStore: undefined as HookStore | undefined,
  contexts: new Map<unknown, unknown>(),
  mediaRequest: undefined as MediaRequest | undefined,
  uploadImpl: vi.fn(),
  downloadArtifactImpl: vi.fn(),
  downloadFileImpl: vi.fn(),
}));

class SyntheticFileReader {
  result: string | null = null;
  error: Error | null = null;
  private listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, listener: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  readAsDataURL(blob: { type?: string }) {
    this.result = `data:${blob.type || "image/png"};base64,U0VDUkVUX0lNQUdFX0JZVEVT`;
    queueMicrotask(() => {
      for (const listener of this.listeners.get("load") ?? []) listener();
    });
  }
}

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  createContext(defaultValue: unknown) {
    const ctx = { defaultValue, Provider: ({ value, children }: any) => {
      runtime.contexts.set(ctx, value);
      return children;
    } };
    return ctx;
  },
  useState(initial: any) {
    const store = runtime.currentStore!;
    const index = store.index++;
    if (!(index in store.slots)) {
      store.slots[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      store.slots[index],
      (value: any) => {
        const next = typeof value === "function" ? value(store.slots[index]) : value;
        if (!Object.is(next, store.slots[index])) store.dirty = true;
        store.slots[index] = next;
      },
    ];
  },
  useRef(initial: unknown) {
    const store = runtime.currentStore!;
    const index = store.index++;
    store.slots[index] ??= { current: initial };
    return store.slots[index];
  },
  useCallback(fn: unknown, deps?: unknown[]) {
    const store = runtime.currentStore!;
    const index = store.memoIndex++;
    const previous = store.memos[index];
    if (
      previous
      && deps
      && deps.length === previous.deps?.length
      && deps.every((value, idx) => Object.is(value, previous.deps?.[idx]))
    ) {
      return previous.value;
    }
    store.memos[index] = { value: fn, deps };
    return fn;
  },
  useMemo(create: () => unknown, deps?: unknown[]) {
    const store = runtime.currentStore!;
    const index = store.memoIndex++;
    const previous = store.memos[index];
    if (
      previous
      && deps
      && deps.length === previous.deps?.length
      && deps.every((value, idx) => Object.is(value, previous.deps?.[idx]))
    ) {
      return previous.value;
    }
    const value = create();
    store.memos[index] = { value, deps };
    return value;
  },
  useContext: (ctx: { defaultValue?: unknown }) => (
    runtime.contexts.has(ctx) ? runtime.contexts.get(ctx) : ctx?.defaultValue
  ),
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const store = runtime.currentStore!;
    const index = store.effectIndex++;
    const previous = store.effects[index];
    if (
      previous
      && deps
      && deps.length === previous.deps?.length
      && deps.every((value, idx) => Object.is(value, previous.deps?.[idx]))
    ) {
      return;
    }
    store.pending.push(() => {
      previous?.cleanup?.();
      store.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));

vi.mock("../components/evidence/MediaPreviewProvider.js", async (original) => ({
  ...await original<typeof import("../components/evidence/MediaPreviewProvider.js")>(),
  useMediaRequest: () => runtime.mediaRequest,
}));

vi.mock("./file-upload.js", async (original) => ({
  ...await original<typeof import("./file-upload.js")>(),
  uploadSessionFile: (...args: unknown[]) => runtime.uploadImpl(...args),
}));

vi.mock("./artifact-download.js", async (original) => ({
  ...await original<typeof import("./artifact-download.js")>(),
  downloadBridgeArtifact: (...args: unknown[]) => runtime.downloadArtifactImpl(...args),
  downloadBridgeSessionFile: (...args: unknown[]) => runtime.downloadFileImpl(...args),
}));

vi.mock("./session-notifications.js", async (original) => ({
  ...await original<typeof import("./session-notifications.js")>(),
  ensureSessionNotificationPermission: vi.fn().mockResolvedValue(true),
  showSessionNotification: vi.fn(),
}));

vi.mock("./vault.js", () => ({
  bridgeVault: {
    listHosts: vi.fn(async () => []),
    getHost: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => []),
    saveMessage: vi.fn(async () => undefined),
    listOutbox: vi.fn(async () => []),
    addOutbox: vi.fn(async () => undefined),
    removeOutbox: vi.fn(async () => undefined),
  },
}));

function createStore(): HookStore {
  return { slots: [], index: 0, memos: [], memoIndex: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
}

function renderStore<T>(store: HookStore, render: () => T): T {
  for (let pass = 0; pass < 12; pass += 1) {
    runtime.currentStore = store;
    store.dirty = false;
    store.index = 0;
    store.memoIndex = 0;
    store.effectIndex = 0;
    const output = render();
    store.pending.splice(0).forEach((effect) => effect());
    if (!store.dirty) return output;
  }
  throw new Error("Hook store did not settle");
}

function unmountStore(store: HookStore): void {
  for (const effect of store.effects) effect.cleanup?.();
  store.effects = [];
  store.slots = [];
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function makeSensitiveSession(sessionId: string): BridgeSessionInfo {
  return {
    sessionId,
    title: `SECRET_SESSION_TITLE_${sessionId}`,
    projectId: "proj-secret",
    projectName: "SECRET_PROJECT_NAME",
    cwd: "/Users/secret-owner/private-repo",
    source: "desktop",
    ownership: "DESKTOP_NATIVE_IDLE",
    transport: "claude-desktop-native",
    turnState: "idle",
    lastActivityAt: 100,
    pendingCount: 0,
    allowedActions: {
      canSend: true,
      canSteer: true,
      canInterrupt: true,
      canConfigure: true,
      canSwitchProvider: false,
      canContinueOfficial: false,
    },
  };
}

function makeDesktopSnapshot(hostId = "host-secret-1"): DesktopControlSnapshot {
  return {
    host: {
      hostId,
      name: "SECRET_DESKTOP_HOSTNAME",
      capabilities: ["claude.native-relay.v1", "evidence.details.v1"],
      pairingEpoch: 1,
      relayUrl: "wss://secret-token@relay.example.test/ws",
      online: true,
      lastSeenAt: 100,
      version: "1.3.4",
    },
    projects: [{
      projectId: "proj-secret",
      name: "SECRET_PROJECT_NAME",
      cwd: "/Users/secret-owner/private-repo",
      sessionCount: 1,
      runningCount: 1,
      pendingCount: 0,
      lastActivityAt: 100,
    }],
    sessions: [makeSensitiveSession("sess-1")],
    devices: [],
    permissions: [{
      requestId: "perm-1",
      sessionId: "sess-1",
      toolUseId: "tool-1",
      toolName: "Bash",
      input: { command: "cat /Users/secret-owner/.ssh/id_rsa" },
      description: "SECRET_PERMISSION_SUMMARY",
      createdAt: 100,
      canAllowAlways: false,
    }],
    prompts: [{
      promptId: "prompt-1",
      sessionId: "sess-1",
      kind: "cwd-trust",
      directory: "/Users/secret-owner/private-repo",
      sources: [".claude/settings.json"],
      title: "SECRET_PROMPT_TITLE",
      message: "SECRET_PROMPT_MESSAGE /Users/secret-owner/private-repo",
      choices: [{ value: "allow", label: "Allow" }],
      canRespond: true,
    }],
    latestSeq: 25,
    connection: "connected",
    launchAtLogin: false,
    diagnosticsEnabled: false,
    managedDesktopEnabled: false,
    claudeDesktop: {
      state: "running",
      detail: "Running",
      canLaunch: false,
      canQuit: true,
    },
    runtime: {
      state: "ready",
      detail: "Ready",
      activeTurns: 1,
      maxParallelTurns: 2,
      desktopIntegration: { state: "ready", detail: "Ready", enabled: true, canRestart: false },
    },
  };
}

const FORBIDDEN_SECRET_PATTERN = /SECRET_|secret-owner|private-repo|id_rsa|secret-attachment|secret-upload|secret-artifact|secret-desktop|relay\.example\.test/;

describe("Frontend pull-based diagnostics state gauges & redaction", () => {
  beforeEach(() => {
    runtime.contexts.clear();
    runtime.mediaRequest = undefined;
    runtime.uploadImpl.mockReset();
    runtime.downloadArtifactImpl.mockReset();
    runtime.downloadFileImpl.mockReset();
    clearToolCallDetailCache();
    vi.stubGlobal("FileReader", SyntheticFileReader);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { href: "https://example.test/#pair=SECRET_PAIRING_TOKEN" } }));
    vi.stubGlobal("navigator", { onLine: true, userAgent: "Vitest" });
  });

  afterEach(() => {
    clearToolCallDetailCache();
    vi.unstubAllGlobals();
  });

  it("collects useMobileBridge bridgeState gauges accurately, cleans up on unmount, and leaks zero plaintext", async () => {
    const store = createStore();
    let releaseUpload!: () => void;
    let releaseDownload!: () => void;
    runtime.uploadImpl.mockImplementationOnce(() => new Promise((resolve) => {
      releaseUpload = () => resolve({
        uploadId: "up-1",
        sessionId: "sess-1",
        name: "secret-upload.pdf",
        path: ".bridge-uploads/up-1/secret-upload.pdf",
        size: 512,
        sha256: "a".repeat(64),
      });
    }));
    runtime.downloadArtifactImpl.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseDownload = resolve;
    }));

    const bridge = renderStore(store, () => useMobileBridge());
    // Let initial mount bootstrapStoredBridgeHosts finish before seeding live state & in-flight RPCs.
    await flushMicrotasks();
    const snapshot = makeDesktopSnapshot() as unknown as BridgeHostSnapshot;
    const base64Preview: BridgeArtifactPreview = {
      artifactId: "art-1",
      mode: "image",
      mimeType: "image/png",
      encoding: "base64",
      data: "U0VDUkVUX1BSRVZJRVdfQllURVM=",
      truncated: false,
      generatedAt: 100,
    };

    // Populate sensitive runtime state directly on the hook's stateRef & pendingResponsesRef
    const stateRef = store.slots[1] as { current: typeof bridge.state };
    const cryptoRef = store.slots[2] as { current: unknown };
    const pendingResponsesRef = store.slots[7] as { current: Map<string, unknown> };
    cryptoRef.current = { identity: { roomId: "room-secret" } };
    const now = 50_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const timer = setTimeout(() => undefined, 60_000);
    pendingResponsesRef.current.set("rpc-secret-1", {
      resolve: vi.fn(),
      reject: vi.fn(),
      timer,
      startedAt: now - 1_750,
    });

    const populatedState = {
      ...stateRef.current,
      hosts: [{
        hostId: "host-secret-1",
        roomId: "room-secret",
        desktopName: "SECRET_DESKTOP_HOSTNAME",
        relayUrl: "wss://secret-token@relay.example.test/ws",
        needsRepair: false,
        status: "running" as const,
        activeTurns: 1,
        path: "direct" as const,
      }],
      activeHostId: "room-secret",
      desktopName: "SECRET_DESKTOP_HOSTNAME",
      connection: "connected" as const,
      desktopOnline: true,
      latestSeq: 25,
      pendingOutbound: 2,
      snapshot,
      permissions: snapshot.permissions,
      histories: {
        "sess-1": {
          status: "ready" as const,
          hasMore: false,
          items: [
            { id: "m-1", sessionId: "sess-1", role: "user" as const, text: "SECRET_MESSAGE_BODY_1", createdAt: 1, origin: "claude-desktop" as const },
            { id: "m-2", sessionId: "sess-1", role: "assistant" as const, text: "SECRET_MESSAGE_BODY_2", createdAt: 2, origin: "claude-desktop" as const },
          ],
        },
        "sess-2": {
          status: "loading" as const,
          hasMore: true,
          items: [{ id: "m-3", sessionId: "sess-2", role: "user" as const, text: "SECRET_MESSAGE_BODY_3", createdAt: 3, origin: "claude-desktop" as const }],
        },
      },
      events: [{
        eventId: "ev-1",
        seq: 25,
        timestamp: 100,
        sessionId: "sess-1",
        origin: "claude-desktop" as const,
        type: "assistant.completed" as const,
        data: { text: "SECRET_EVENT_TEXT" },
      }],
      localTurns: [{
        requestId: "req-1",
        idempotencyKey: "idem-1",
        sessionId: "sess-1",
        text: "SECRET_LOCAL_TURN_PROMPT",
        attachments: [],
        createdAt: 100,
        delivery: "queued" as const,
      }],
      evidence: {
        "sess-1": {
          status: "ready" as const,
          hasMore: false,
          items: [{
            id: "ev-bundle-1",
            sessionId: "sess-1",
            source: "bridge-host" as const,
            confidence: "exact" as const,
            state: "ready" as const,
            startedAt: 10,
            completedAt: 20,
            toolCount: 1,
            changeCount: 3,
            artifactCount: 3,
            tools: [],
            artifacts: [],
            warnings: ["SECRET_EVIDENCE_WARNING /Users/secret-owner/private-repo"],
          }],
        },
      },
      artifactPreviews: { "art-1": base64Preview },
    };
    store.slots[0] = populatedState;
    stateRef.current = populatedState;

    const uploadAbort = new AbortController();
    const uploadTask = bridge.uploadFile("sess-1", { name: "secret-upload.pdf", size: 512 } as File, () => undefined, uploadAbort.signal);
    const artifact: BridgeArtifactManifest = {
      id: "art-dl-1",
      evidenceId: "ev-bundle-1",
      relativePath: "docs/secret-artifact.pdf",
      name: "secret-artifact.pdf",
      kind: "pdf",
      changeKind: "created",
      mimeType: "application/pdf",
      size: 4096,
      availability: "snapshot",
      previewMode: "none",
      downloadAllowed: true,
    };
    const downloadTask = bridge.downloadArtifact(artifact);
    await flushMicrotasks();
    renderStore(store, () => useMobileBridge());

    try {
      const gauges = collectDiagnosticsStateSnapshot();
      expect(gauges.bridgeState).toEqual({
        hostsCount: 1,
        hasActiveHost: true,
        connection: "connected",
        desktopOnline: true,
        latestSeq: 25,
        pendingOutbound: 2,
        sessionsCount: 1,
        projectsCount: 1,
        permissionsCount: 1,
        promptsCount: 1,
        histories: {
          sessionsCached: 2,
          totalItems: 3,
          loadingSessions: 1,
        },
        eventsCount: 1,
        localTurnsCount: 1,
        evidence: {
          bundlesCached: 1,
          totalArtifacts: 3,
        },
        artifactPreviews: {
          cachedCount: 1,
          estimatedDataUrlBytes: base64Preview.data.length + "image/png".length + 13,
        },
        artifactTransfers: {
          count: 1,
          activeCount: 1,
          totalCachedBytes: 0,
        },
        pendingRpcCount: 1,
        oldestPendingRpcMs: 1_750,
        activeUploads: 1,
        activeDownloads: 1,
      });
      expect(JSON.stringify(gauges)).not.toMatch(FORBIDDEN_SECRET_PATTERN);
    } finally {
      clearTimeout(timer);
      releaseUpload();
      releaseDownload();
      await Promise.all([uploadTask, downloadTask]);
    }

    unmountStore(store);
    expect(collectDiagnosticsStateSnapshot()).not.toHaveProperty("bridgeState");
  });

  it("collects ConversationDraftsProvider gauges without fallback clobbering, redacts drafts/filenames, and cleans up", async () => {
    const providerStore = createStore();
    const consumerStore = createStore();
    let releaseUpload!: () => void;
    const onUploadFile = vi.fn(() => new Promise<never>(() => {
      // Hold upload open while inspecting gauges.
    }));
    const abortableUpload = vi.fn((_sessionId: string, _file: File, _onProgress?: (p: number) => void, signal?: AbortSignal) => (
      new Promise<any>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        releaseUpload = () => resolve({
          uploadId: "up-draft-1",
          sessionId: "sess-1",
          name: "secret-attachment.pdf",
          path: ".bridge-uploads/up-draft-1/secret-attachment.pdf",
          size: 2048,
          sha256: "b".repeat(64),
        });
      })
    ));
    void onUploadFile;

    let capturedController!: ConversationDraftsController;
    const renderBoth = () => {
      const element = renderStore(providerStore, () => ConversationDraftsProvider({
        activeHostId: "host-secret-1",
        children: null,
      }) as ReactElement<{ value: ConversationDraftsController }>);
      runtime.contexts.clear();
      // Populate the provider's Context value via its returned Provider element.
      const providerType = element.type as unknown as (props: any) => unknown;
      providerType(element.props);
      capturedController = renderStore(consumerStore, () => useConversationDrafts("host-secret-1"));
    };
    renderBoth();

    const draftOne = capturedController.session("host-secret-1", "sess-1", abortableUpload);
    draftOne.setText("SECRET_DRAFT_TEXT_ONE");
    renderBoth();

    await capturedController.session("host-secret-1", "sess-1", abortableUpload).addImages([
      { name: "secret-attachment.png", size: 1024, type: "image/png" } as unknown as File,
    ] as unknown as FileList);
    await flushMicrotasks();
    renderBoth();

    const addUploadPromise = capturedController
      .session("host-secret-1", "sess-1", abortableUpload)
      .fileUploads.add([
        { name: "secret-attachment.pdf", size: 2048, type: "application/pdf" } as unknown as File,
      ] as unknown as FileList);
    await flushMicrotasks();
    renderBoth();

    // Create an empty second draft entry to prove nonEmptyTextDrafts != draftEntries
    const draftTwo = capturedController.session("host-secret-1", "sess-2");
    draftTwo.setText("x");
    renderBoth();
    capturedController.session("host-secret-1", "sess-2").setText("");
    renderBoth();

    const gauges = collectDiagnosticsStateSnapshot();
    expect(gauges.conversationDrafts).toEqual({
      draftEntries: 2,
      nonEmptyTextDrafts: 1,
      totalTextCodeUnits: "SECRET_DRAFT_TEXT_ONE".length,
      attachmentsCount: 2,
      attachmentsBytes: 1024 + 2048,
      uploadingDraftsCount: 1,
    });
    expect(JSON.stringify(gauges)).not.toMatch(FORBIDDEN_SECRET_PATTERN);

    releaseUpload();
    await addUploadPromise;
    renderBoth();
    expect((collectDiagnosticsStateSnapshot().conversationDrafts as Record<string, unknown>).uploadingDraftsCount).toBe(0);

    unmountStore(consumerStore);
    // Consumer unmount must NOT unregister the active provider!
    expect(collectDiagnosticsStateSnapshot()).toHaveProperty("conversationDrafts");

    unmountStore(providerStore);
    expect(collectDiagnosticsStateSnapshot()).not.toHaveProperty("conversationDrafts");
  });

  it("collects DesktopConversationProvider gauges across hosts without leaking session histories or paths", async () => {
    const providerStore = createStore();
    const consumerStore = createStore();
    const snapshot = makeDesktopSnapshot("host-secret-1");
    const hostAEvents: BridgeEvent[] = [
      { eventId: "e-1", seq: 1, timestamp: 1, sessionId: "sess-1", origin: "claude-desktop", type: "assistant.completed", data: { text: "SECRET_EVENT_A1" } },
      { eventId: "e-2", seq: 2, timestamp: 2, sessionId: "sess-1", origin: "claude-desktop", type: "assistant.completed", data: { text: "SECRET_EVENT_A2" } },
    ];
    const hostBEvents: BridgeEvent[] = [
      { eventId: "e-3", seq: 3, timestamp: 3, sessionId: "sess-b", origin: "claude-desktop", type: "assistant.completed", data: { text: "SECRET_EVENT_B1" } },
    ];

    const apiRequest = vi.fn(async (req: { method: string }): Promise<BridgeResponse> => {
      if (req.method === "session.open") {
        return {
          kind: "response",
          requestId: "r-open",
          ok: true,
          result: {
            history: {
              items: [
                { id: "h-1", sessionId: "sess-1", role: "user", kind: "message", text: "SECRET_DESKTOP_HISTORY_1", timestamp: 1 },
                { id: "h-2", sessionId: "sess-1", role: "assistant", kind: "message", text: "SECRET_DESKTOP_HISTORY_2", timestamp: 2 },
              ],
              hasMore: false,
            },
          },
        };
      }
      if (req.method === "evidence.list") {
        return {
          kind: "response",
          requestId: "r-ev",
          ok: true,
          result: {
            evidence: {
              items: [{
                id: "ev-desk-1",
                sessionId: "sess-1",
                source: "claude-desktop",
                confidence: "inferred",
                state: "ready",
                startedAt: 1,
                completedAt: 2,
                toolCount: 1,
                changeCount: 1,
                artifactCount: 1,
                tools: [],
                artifacts: [],
                warnings: [],
              }],
              hasMore: false,
            },
          },
        };
      }
      if (req.method === "artifact.preview") {
        return {
          kind: "response",
          requestId: "r-prev",
          ok: true,
          result: {
            preview: {
              artifactId: "art-desk-1",
              mode: "text",
              mimeType: "text/plain",
              encoding: "utf8",
              data: "SECRET_DESKTOP_PREVIEW_CONTENT",
              truncated: false,
              generatedAt: 10,
            } satisfies BridgeArtifactPreview,
          },
        };
      }
      throw new Error(`Unexpected method: ${req.method}`);
    });

    let releaseUpload!: () => void;
    let releaseDownload!: () => void;
    runtime.uploadImpl.mockImplementationOnce(() => new Promise((resolve) => {
      releaseUpload = () => resolve({
        uploadId: "up-desk-1",
        sessionId: "sess-1",
        name: "secret-desktop-upload.txt",
        path: ".bridge-uploads/up-desk-1/secret-desktop-upload.txt",
        size: 128,
        sha256: "c".repeat(64),
      });
    }));
    runtime.downloadFileImpl.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseDownload = resolve;
    }));

    const input = {
      snapshot,
      events: hostAEvents,
      eventsByHost: {
        "host-secret-1": hostAEvents,
        "host-secret-2": hostBEvents,
      },
      apiRequest,
      onRefreshSnapshot: vi.fn(async () => undefined),
    };

    let controller!: DesktopConversationController;
    const renderBoth = () => {
      const element = renderStore(providerStore, () => DesktopConversationProvider({
        ...input,
        children: null,
      }) as ReactElement<{ value: DesktopConversationController }>);
      runtime.contexts.clear();
      const providerType = element.type as unknown as (props: any) => unknown;
      providerType(element.props);
      controller = renderStore(consumerStore, () => useDesktopConversation(input));
    };
    renderBoth();

    await controller.openSession("sess-1");
    renderBoth();
    await controller.previewArtifact("art-desk-1");
    renderBoth();

    const desktopUploadAbort = new AbortController();
    const uploadPromise = controller.uploadFile("sess-1", { name: "secret-desktop-upload.txt", size: 128 } as File, () => undefined, desktopUploadAbort.signal);
    const downloadPromise = controller.downloadSessionFile("sess-1", "/Users/secret-owner/private-repo/secret-desktop.txt");
    await flushMicrotasks();
    renderBoth();

    try {
      const gauges = collectDiagnosticsStateSnapshot();
      expect(gauges.desktopConversations).toEqual({
        trackedHosts: 2,
        totalBufferedEvents: 3,
        maxEventsPerHost: 2,
        historiesCached: 1,
        historyItemsTotal: 2,
        evidenceCached: 1,
        artifactPreviewsCached: 1,
        artifactPreviewBytes: "SECRET_DESKTOP_PREVIEW_CONTENT".length,
        artifactTransfersCount: 1,
        activeUploads: 1,
      });
      expect(JSON.stringify(gauges)).not.toMatch(FORBIDDEN_SECRET_PATTERN);
    } finally {
      releaseUpload();
      releaseDownload();
      await Promise.all([uploadPromise, downloadPromise]);
    }

    unmountStore(consumerStore);
    expect(collectDiagnosticsStateSnapshot()).toHaveProperty("desktopConversations");
    unmountStore(providerStore);
    expect(collectDiagnosticsStateSnapshot()).not.toHaveProperty("desktopConversations");
  });

  it("tracks module-level toolDetailCache in-flight and cached JSON code-unit gauges without leaking tool I/O", async () => {
    const store = createStore();
    let resolveDetail!: (response: BridgeResponse) => void;
    runtime.mediaRequest = vi.fn(() => new Promise<BridgeResponse>((resolve) => {
      resolveDetail = resolve;
    }));

    renderStore(store, () => ToolCallDetailSheet({
      hostId: "host-secret-1",
      sessionId: "sess-1",
      toolUseId: "tool-secret-1",
      toolName: "Read",
      supportsToolDetail: true,
      onClose: vi.fn(),
    }));

    expect(collectDiagnosticsStateSnapshot().toolDetailCache).toEqual({
      cachedEntries: 0,
      inFlightEntries: 1,
      estimatedJsonCodeUnits: 0,
    });

    const detail: BridgeToolCallDetail = {
      sessionId: "sess-1",
      toolUseId: "tool-secret-1",
      toolName: "Read",
      status: "completed",
      input: { file_path: "/Users/secret-owner/private-repo/secret.pem" },
      inputTruncated: false,
      outputText: "SECRET_PRIVATE_KEY_MATERIAL",
      truncated: false,
      totalBytes: 27,
      omittedBlocks: [],
    };
    resolveDetail({
      kind: "response",
      requestId: "r-tool-1",
      ok: true,
      result: { detail },
    });
    await flushMicrotasks();

    const gauges = collectDiagnosticsStateSnapshot();
    expect(gauges.toolDetailCache).toEqual({
      cachedEntries: 1,
      inFlightEntries: 0,
      estimatedJsonCodeUnits: JSON.stringify(detail).length,
    });
    expect(JSON.stringify(gauges)).not.toMatch(FORBIDDEN_SECRET_PATTERN);

    unmountStore(store);
    clearToolCallDetailCache();
    expect(collectDiagnosticsStateSnapshot().toolDetailCache).toEqual({
      cachedEntries: 0,
      inFlightEntries: 0,
      estimatedJsonCodeUnits: 0,
    });
  });
});
