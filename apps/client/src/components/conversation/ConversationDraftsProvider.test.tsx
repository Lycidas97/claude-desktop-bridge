import type { BridgeHostSnapshot, BridgeSessionInfo, BridgeUploadedFile } from "@bridge/protocol";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_DRAFTS_STORAGE_KEY,
  ConversationDraftsProvider,
  useConversationDrafts,
  type ConversationDraftsController,
  type ConversationDraftsHandle,
} from "./ConversationDraftsProvider.js";

interface HookStore {
  slots: any[];
  index: number;
  dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number;
  pending: Array<() => void>;
}

const runtime = vi.hoisted(() => ({
  currentStore: undefined as HookStore | undefined,
  contextValue: undefined as ConversationDraftsController | undefined,
  readers: [] as DeferredFileReader[],
}));

class DeferredFileReader {
  result: string | null = null;
  error: Error | null = null;
  private listeners = new Map<string, Array<() => void>>();
  constructor() {
    runtime.readers.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  readAsDataURL(blob: { type?: string; name?: string }) {
    this.result = `data:${blob.type || "image/png"};base64,QUJD`;
  }
  finish() {
    for (const listener of this.listeners.get("load") ?? []) listener();
  }
}

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
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
  useMemo: (create: () => unknown) => create(),
  useContext: () => runtime.contextValue,
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

function createStore(): HookStore {
  return { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
}

function runWithStore<T>(store: HookStore, render: () => T): T {
  for (let pass = 0; pass < 12; pass++) {
    runtime.currentStore = store;
    store.dirty = false;
    store.index = 0;
    store.effectIndex = 0;
    const output = render();
    store.pending.splice(0).forEach((effect) => effect());
    if (!store.dirty) return output;
  }
  throw new Error("Store did not settle");
}

function unmountStore(store: HookStore): void {
  for (const effect of store.effects) effect.cleanup?.();
  store.effects = [];
  store.slots = [];
}

function makeSession(sessionId: string): BridgeSessionInfo {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    projectId: "proj-1",
    projectName: "Project",
    cwd: "/work/project",
    source: "desktop",
    ownership: "DESKTOP_NATIVE_IDLE",
    transport: "claude-desktop-native",
    turnState: "idle",
    lastActivityAt: 1,
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

const snapshot: BridgeHostSnapshot = {
  host: {
    hostId: "host-a",
    name: "Mac A",
    capabilities: ["claude.native-relay.v1"],
    pairingEpoch: 1,
    relayUrl: "",
    online: true,
    lastSeenAt: 1,
    version: "1.4.0",
  },
  sessions: [makeSession("sess-1"), makeSession("sess-2")],
  projects: [],
  devices: [],
  permissions: [],
  latestSeq: 1,
  runtime: {
    state: "ready",
    detail: "Ready",
    activeTurns: 0,
    maxParallelTurns: 2,
    desktopIntegration: { state: "ready", detail: "Ready", enabled: true, canRestart: false },
  },
};

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("ConversationDraftsProvider", () => {
  let providerStore: HookStore;
  let consumerStore: HookStore;
  let activeHostId: string | undefined;
  let handle: ConversationDraftsHandle;

  function renderProvider(store = providerStore): ConversationDraftsController {
    const element = runWithStore(store, () => (
      ConversationDraftsProvider({ activeHostId, controllerRef: handle, children: null }) as ReactElement<{ value: ConversationDraftsController }>
    ));
    runtime.contextValue = element.props.value;
    return element.props.value;
  }

  function renderConsumer(hostId = activeHostId) {
    renderProvider();
    return runWithStore(consumerStore, () => useConversationDrafts(hostId));
  }

  let stored: Map<string, string>;

  beforeEach(() => {
    providerStore = createStore();
    consumerStore = createStore();
    activeHostId = "host-a";
    handle = {};
    runtime.contextValue = undefined;
    runtime.readers = [];
    stored = new Map();
    vi.stubGlobal("FileReader", DeferredFileReader);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
  });

  afterEach(() => {
    unmountStore(consumerStore);
    unmountStore(providerStore);
    runtime.contextValue = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("isolates drafts by (hostId, sessionId) and survives consumer unmount across page and subview switches", async () => {
    let progressCb!: (progress: number) => void;
    let resolveUpload!: (file: BridgeUploadedFile) => void;
    let uploadSignal: AbortSignal | undefined;
    const onUploadFile = vi.fn((_sessionId, _file, onProgress, signal) => {
      progressCb = onProgress!;
      uploadSignal = signal;
      return new Promise<BridgeUploadedFile>((resolve) => {
        resolveUpload = resolve;
      });
    });

    let drafts = renderConsumer();
    let sess1 = drafts.session("host-a", "sess-1", onUploadFile);
    sess1.setText("助理对话草稿");
    const addingImages = sess1.addImages([{ name: "diagram.png", type: "image/png", size: 128 }] as unknown as FileList);
    runtime.readers[0]!.finish();
    await addingImages;
    const uploading = sess1.fileUploads.add([{ name: "spec.md", size: 1024 }] as unknown as FileList);

    const otherHostSess1 = drafts.session("host-b", "sess-1", onUploadFile);
    otherHostSess1.setText("另一台电脑同会话 ID 草稿");

    // Simulate switching Assistant subview (对话 -> 邮件) or mobile tab (会话 -> 设置): consumer unmounts!
    unmountStore(consumerStore);
    expect(uploadSignal?.aborted).toBe(false);

    // Upload continues progressing and completes while consumer view is unmounted.
    progressCb(0.6);
    renderProvider();
    const uploaded: BridgeUploadedFile = {
      uploadId: "up-1",
      sessionId: "sess-1",
      name: "spec.md",
      path: ".bridge-uploads/up-1/spec.md",
      size: 1024,
      sha256: "abc",
    };
    resolveUpload(uploaded);
    await uploading;
    await flushPromises();

    // Remount consumer view on return to 对话 / 会话.
    consumerStore = createStore();
    drafts = renderConsumer();
    sess1 = drafts.session("host-a", "sess-1", onUploadFile);
    expect(sess1.draft.text).toBe("助理对话草稿");
    expect(sess1.draft.attachments.map((item) => item.name)).toEqual(["diagram.png"]);
    expect(sess1.fileUploads.files).toEqual([uploaded]);
    expect(sess1.fileUploads.uploading).toBe(false);

    expect(drafts.session("host-a", "sess-2").draft.text).toBe("");
    expect(drafts.session("host-b", "sess-1").draft.text).toBe("另一台电脑同会话 ID 草稿");
  });

  it("aborts in-flight uploads on host switch while preserving text, images, and completed files, and clears forgotten hosts", async () => {
    const completedFile: BridgeUploadedFile = {
      uploadId: "up-done",
      sessionId: "sess-1",
      name: "done.txt",
      path: ".bridge-uploads/done.txt",
      size: 32,
      sha256: "done",
    };
    let inFlightSignal: AbortSignal | undefined;
    let rejectInFlight!: (error: Error) => void;
    const onUploadFile = vi.fn()
      .mockResolvedValueOnce(completedFile)
      .mockImplementationOnce((_sessionId, _file, _onProgress, signal: AbortSignal) => {
        inFlightSignal = signal;
        return new Promise<BridgeUploadedFile>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
          rejectInFlight = reject;
        });
      });

    let drafts = renderConsumer();
    let sessA = drafts.session("host-a", "sess-1", onUploadFile);
    sessA.setText("保留的草稿");
    await sessA.fileUploads.add([{ name: "done.txt", size: 32 }] as unknown as FileList);

    drafts = renderConsumer();
    sessA = drafts.session("host-a", "sess-1", onUploadFile);
    const pendingAdd = sessA.fileUploads.add([{ name: "large.bin", size: 4096 }] as unknown as FileList);
    drafts = renderConsumer();
    expect(drafts.session("host-a", "sess-1", onUploadFile).fileUploads.uploading).toBe(true);

    // Switch active host from host-a to host-b.
    activeHostId = "host-b";
    drafts = renderConsumer("host-b");
    await pendingAdd;
    void rejectInFlight;
    expect(inFlightSignal?.aborted).toBe(true);

    const switchedBack = drafts.session("host-a", "sess-1", onUploadFile);
    expect(switchedBack.draft.text).toBe("保留的草稿");
    expect(switchedBack.fileUploads.files).toEqual([completedFile]);
    expect(switchedBack.fileUploads.uploading).toBe(false);
    expect(switchedBack.fileUploads.entries.find((entry) => entry.name === "large.bin")?.error).toBe("已切换电脑，上传已中断");

    // Forgetting host-a wipes its drafts and uploaded files without affecting host-b.
    drafts.session("host-b", "sess-1").setText("电脑 B 草稿");
    handle.clearHost?.("host-a");
    drafts = renderConsumer("host-b");
    expect(drafts.session("host-a", "sess-1").draft.text).toBe("");
    expect(drafts.session("host-a", "sess-1").fileUploads.entries).toEqual([]);
    expect(drafts.session("host-b", "sess-1").draft.text).toBe("电脑 B 草稿");
  });

  it("restores failed submissions onto the originating (hostId, sessionId) and tracks quick-reply requestIds", async () => {
    let rejectSend!: (error: Error) => void;
    let drafts = renderConsumer();
    const sess1 = drafts.session("host-a", "sess-1");
    sess1.setText("原始问题");
    drafts = renderConsumer();

    const sending = drafts.session("host-a", "sess-1").submitMessage({
      session: makeSession("sess-1"),
      snapshot,
      canAttachImages: true,
      executeCommand: async () => false,
      sendTurn: () => new Promise((_resolve, reject) => {
        rejectSend = reject;
      }),
    });
    await flushPromises();

    // User switches to sess-2 and also types follow-up text in sess-1 before send fails.
    drafts = renderConsumer();
    drafts.session("host-a", "sess-2").setText("会话 2 草稿");
    drafts.session("host-a", "sess-1").setText("补充说明");
    rejectSend(new Error("网络断开"));
    await sending;

    drafts = renderConsumer();
    expect(drafts.session("host-a", "sess-2").draft.text).toBe("会话 2 草稿");
    expect(drafts.session("host-a", "sess-2").draft.imageError).toBeUndefined();
    expect(drafts.session("host-a", "sess-1").draft.text).toBe("原始问题\n补充说明");
    expect(drafts.session("host-a", "sess-1").draft.imageError).toBe("网络断开");
    expect(drafts.session("host-a", "sess-1").draft.sending).toBe(false);

    // Quick reply records requestId per (hostId, sessionId) and blocks slash commands with mailRefId.
    await drafts.session("host-a", "sess-1").submitQuickReply({
      session: makeSession("sess-1"),
      snapshot,
      promptId: "prompt-1",
      promptText: "/compact",
      resolveMailRefId: () => "mail-ref-1",
      sendTurn: async () => "req-never",
    });
    drafts = renderConsumer();
    expect(drafts.session("host-a", "sess-1").promptError("prompt-1")).toBe("请先清除邮件引用，再执行会话命令。");

    await drafts.session("host-a", "sess-1").submitQuickReply({
      session: makeSession("sess-1"),
      snapshot,
      promptId: "prompt-1",
      promptText: "继续执行",
      sendTurn: async () => "req-42",
    });
    drafts = renderConsumer();
    expect(drafts.session("host-a", "sess-1").promptError("prompt-1")).toBeUndefined();
    expect(drafts.session("host-a", "sess-1").promptReplies).toEqual({ "prompt-1": "req-42" });
  });

  it("works standalone without a ConversationDraftsProvider wrapper when useContext returns undefined", () => {
    runtime.contextValue = undefined;
    const standaloneStore = createStore();
    try {
      let drafts = runWithStore(standaloneStore, () => useConversationDrafts("host-standalone"));
      drafts.session("host-standalone", "sess-1").setText("独立单测草稿");
      drafts = runWithStore(standaloneStore, () => useConversationDrafts("host-standalone"));
      expect(drafts.session("host-standalone", "sess-1").draft.text).toBe("独立单测草稿");
    } finally {
      unmountStore(standaloneStore);
    }
  });

  it("updates the composer immediately and saves a burst of edits in one write", () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(localStorage, "setItem");
    const session = renderConsumer().session("host-a", "sess-1");
    session.setText("草");
    expect(renderConsumer().session("host-a", "sess-1").draft.text).toBe("草");
    vi.advanceTimersByTime(100);
    session.setText("草稿");
    expect(renderConsumer().session("host-a", "sess-1").draft.text).toBe("草稿");
    vi.advanceTimersByTime(100);
    session.setText("草稿完成");
    expect(renderConsumer().session("host-a", "sess-1").draft.text).toBe("草稿完成");
    expect(setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored.get(CONVERSATION_DRAFTS_STORAGE_KEY)!)).toMatchObject({
      version: 1,
      entries: [{ key: JSON.stringify(["host-a", "sess-1"]), text: "草稿完成" }],
    });
  });

  it("does not restore another window's cleared draft when saving a different session", () => {
    vi.useFakeTimers();
    const keyA = JSON.stringify(["host-a", "sess-A"]);
    const keyB = JSON.stringify(["host-a", "sess-B"]);
    stored.set(CONVERSATION_DRAFTS_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [{ key: keyA, text: "旧草稿", updatedAt: 1 }],
    }));
    const first = renderProvider();
    const firstStore = providerStore;
    providerStore = createStore();
    const second = renderProvider();
    try {
      first.session("host-a", "sess-B").setText("另一个会话的新草稿");
      second.session("host-a", "sess-A").setText("");
      vi.advanceTimersByTime(250);
      expect(JSON.parse(stored.get(CONVERSATION_DRAFTS_STORAGE_KEY)!).entries).toMatchObject([
        { key: keyB, text: "另一个会话的新草稿" },
      ]);
    } finally {
      unmountStore(firstStore);
    }
  });

  it("does not restore a draft another window cleared after the edit was queued", () => {
    vi.useFakeTimers();
    stored.set(CONVERSATION_DRAFTS_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [{ key: JSON.stringify(["host-a", "sess-A"]), text: "旧草稿", updatedAt: 1 }],
    }));
    const first = renderProvider().session("host-a", "sess-A");
    const secondStore = createStore();
    const reopenedStore = createStore();
    try {
      const second = renderProvider(secondStore).session("host-a", "sess-A");
      expect(first.draft.text).toBe("旧草稿");
      expect(second.draft.text).toBe("旧草稿");

      first.setText("earlier edit");
      second.setText("");
      expect(stored.has(CONVERSATION_DRAFTS_STORAGE_KEY)).toBe(false);

      vi.advanceTimersByTime(250);
      expect(renderProvider(reopenedStore).session("host-a", "sess-A").draft.text).toBe("");

      first.setText("new edit after the clear");
      vi.advanceTimersByTime(250);
      unmountStore(reopenedStore);
      expect(renderProvider(reopenedStore).session("host-a", "sess-A").draft.text).toBe("new edit after the clear");
    } finally {
      unmountStore(reopenedStore);
      unmountStore(secondStore);
    }
  });

  it.each(["pagehide", "visibilitychange"])("flushes pending text immediately on %s", (event) => {
    vi.useFakeTimers();
    const page = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", document);
    const setItem = vi.spyOn(localStorage, "setItem");
    const session = renderConsumer().session("host-a", "sess-1");
    session.setText("第一版");
    session.setText("离开前的草稿");

    document.dispatchEvent(new Event("visibilitychange"));
    expect(setItem).not.toHaveBeenCalled();

    if (event === "pagehide") {
      page.dispatchEvent(new Event(event));
    } else {
      document.visibilityState = "hidden";
      document.dispatchEvent(new Event(event));
    }
    expect(JSON.parse(stored.get(CONVERSATION_DRAFTS_STORAGE_KEY)!).entries[0].text).toBe("离开前的草稿");
    vi.runOnlyPendingTimers();
    page.dispatchEvent(new Event("pagehide"));
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("persists per-session and __new__ drafts across full app reload, clears on send/reset/clearHost, caps at 100 entries, and tolerates storage errors", async () => {
    vi.useFakeTimers();
    let drafts = renderConsumer();
    drafts.session("host-a", "sess-A").setText("Draft for Session A");
    drafts.session("host-a", "sess-B").setText("Draft for Session B");
    drafts.session("host-a", "__new__").setText("新建会话草稿");
    drafts.session("host-b", "sess-A").setText("Host B Session A");

    // Simulate full app exit and cold restart (unmounting both consumer & provider, keeping only localStorage).
    unmountStore(consumerStore);
    unmountStore(providerStore);
    runtime.contextValue = undefined;
    providerStore = createStore();
    consumerStore = createStore();

    drafts = renderConsumer();
    expect(drafts.session("host-a", "sess-A").draft.text).toBe("Draft for Session A");
    expect(drafts.session("host-a", "sess-B").draft.text).toBe("Draft for Session B");
    expect(drafts.session("host-a", "__new__").draft.text).toBe("新建会话草稿");
    expect(drafts.session("host-b", "sess-A").draft.text).toBe("Host B Session A");
    expect(drafts.session("host-a", "sess-C").draft.text).toBe("");

    // Sending Session A clears ONLY Session A in both RAM and localStorage.
    await drafts.session("host-a", "sess-A").submitMessage({
      session: makeSession("sess-A"),
      snapshot,
      canAttachImages: true,
      executeCommand: async () => false,
      sendTurn: async () => undefined,
    });
    expect(stored.get(CONVERSATION_DRAFTS_STORAGE_KEY)).not.toContain("Draft for Session A");

    unmountStore(consumerStore);
    unmountStore(providerStore);
    runtime.contextValue = undefined;
    providerStore = createStore();
    consumerStore = createStore();
    drafts = renderConsumer();
    expect(drafts.session("host-a", "sess-A").draft.text).toBe("");
    expect(drafts.session("host-a", "sess-B").draft.text).toBe("Draft for Session B");
    expect(drafts.session("host-a", "__new__").draft.text).toBe("新建会话草稿");
    expect(drafts.session("host-b", "sess-A").draft.text).toBe("Host B Session A");

    // Deleting a draft must also discard any pending write for it.
    drafts.session("host-a", "__new__").setText("暂未落盘的修改");
    drafts.resetSession("host-a", "__new__");
    expect(stored.get(CONVERSATION_DRAFTS_STORAGE_KEY)).not.toContain("__new__");
    drafts.session("host-a", "sess-B").setText("");
    expect(JSON.parse(stored.get(CONVERSATION_DRAFTS_STORAGE_KEY)!).entries).toMatchObject([
      { key: JSON.stringify(["host-b", "sess-A"]), text: "Host B Session A" },
    ]);
    drafts.session("host-b", "sess-A").setText("忘记主机前尚未落盘的修改");
    handle.clearHost?.("host-b");
    expect(stored.has(CONVERSATION_DRAFTS_STORAGE_KEY)).toBe(false);
    vi.runOnlyPendingTimers();
    expect(stored.has(CONVERSATION_DRAFTS_STORAGE_KEY)).toBe(false);

    // LRU cap keeps the 100 most recently updated drafts.
    drafts = renderConsumer();
    for (let index = 0; index < 105; index += 1) {
      drafts.session("host-a", `bulk-${index}`).setText(`draft-${index}`);
    }
    vi.runOnlyPendingTimers();
    const parsedCap = JSON.parse(stored.get(CONVERSATION_DRAFTS_STORAGE_KEY)!) as { entries: Array<{ text: string }> };
    expect(parsedCap.entries).toHaveLength(100);
    expect(parsedCap.entries[0]?.text).toBe("draft-104");
    expect(parsedCap.entries.some((entry) => entry.text === "draft-0")).toBe(false);

    // Corrupt storage JSON & QuotaExceededError never crash rendering or typing.
    unmountStore(consumerStore);
    unmountStore(providerStore);
    stored.set(CONVERSATION_DRAFTS_STORAGE_KEY, "{not-valid-json");
    runtime.contextValue = undefined;
    providerStore = createStore();
    consumerStore = createStore();
    drafts = renderConsumer();
    expect(drafts.session("host-a", "sess-B").draft.text).toBe("");

    const failWrite = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });
    drafts.session("host-a", "sess-quota").setText("仍能在内存中正常输入");
    vi.runOnlyPendingTimers();
    expect(failWrite).toHaveBeenCalledTimes(1);
    drafts = renderConsumer();
    expect(drafts.session("host-a", "sess-quota").draft.text).toBe("仍能在内存中正常输入");
  });
});
