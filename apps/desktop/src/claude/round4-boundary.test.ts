import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeInspectorStatus } from "@bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeSectionFixture } from "../../../../scripts/fixtures/native-section-store.js";
import { createControllerFixture } from "../controller/controller-fixture.js";
import { ConversationStateStore } from "../controller/conversation-state-store.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import {
  CLAUDE_UNSECTIONED_PROJECT_ID,
  CLAUDE_UNSECTIONED_PROJECT_NAME,
  ClaudeDesktopBridge,
} from "./claude-desktop-bridge.js";
import { NativeCallError } from "./claude-desktop-inspector.js";
import { ClaudeInspectorMonitor } from "./claude-inspector-monitor.js";
import {
  ClaudeInspectorStartup,
  ensureClaudeDeveloperSettingsNonInteractive,
} from "./claude-inspector-startup.js";
import { MagpieConnectionRepository } from "./magpie-connection.js";
import {
  deriveFallbackSessionTitle,
  generateSessionTitle,
  sanitizeGeneratedTitle,
} from "./session-title-generator.js";

createRequire(import.meta.url)("../../../../scripts/recycle-cleanup.cjs");

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

class BoundaryNativeInspector extends EventEmitter {
  ready = true;
  calls: Array<{ method: string; args: unknown[] }> = [];
  sessions: Array<Record<string, unknown>> = [
    {
      sessionId: "local-native",
      cwd: "/project",
      title: "Initial",
      isRunning: true,
      turnRunning: false,
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      pendingToolPermissions: [],
    },
  ];
  ignoreStartTitle = true;
  unsupported = new Set<string>();

  supports(method: string): boolean {
    return !this.unsupported.has(method);
  }
  async connect(): Promise<void> {
    this.ready = true;
  }
  async close(): Promise<void> {
    this.ready = false;
  }
  availableCodeModels = vi.fn(async () => ["claude-sonnet-4-6"]);
  async prPreferences(): Promise<undefined> {
    return undefined;
  }
  async promptChoices(): Promise<undefined> {
    return undefined;
  }
  async startAutoFixOnNextPr(): Promise<void> {}

  async call(method: string, args: unknown[] = []): Promise<unknown> {
    this.calls.push({ method, args });
    if (!this.supports(method)) throw new Error(`Unsupported method: ${method}`);
    if (method === "getAll") return structuredClone(this.sessions);
    if (method === "delete") {
      this.sessions = this.sessions.filter(item => item.sessionId !== args[0]);
      return;
    }
    const session = this.sessions.find(item => item.sessionId === args[0]);
    if (method === "getSession") return structuredClone(session);
    if (method === "getTranscriptPage") return { messages: [], hasMore: false };
    if (method === "getTranscript") return [];
    if (method === "getContextUsage") return null;
    if (method === "getSupportedCommands") {
      return [
        { name: "compact", description: "Compact" },
        { name: "rename", description: "Rename" },
      ];
    }
    if (method === "sendMessage") {
      const prompt = String(args[1] ?? "").trim();
      const renameMatch = /^\/rename\s+(.+)$/isu.exec(prompt);
      if (renameMatch && session) {
        session.title = renameMatch[1]!.trim();
      }
      return { delivered: true };
    }
    if (method === "updateSession" && session && args[1] && typeof args[1] === "object") {
      Object.assign(session, args[1]);
      return;
    }
    if (method === "start") {
      const input = args[0] as Record<string, unknown>;
      this.sessions.push({
        ...input,
        ...(this.ignoreStartTitle ? { title: "" } : {}),
        isRunning: false,
        turnRunning: false,
      });
      return { sessionId: input.sessionId };
    }
    if (method === "forkSession" && session) {
      const child = {
        ...session,
        sessionId: `fork_${this.sessions.length + 1}`,
        forkedFromSessionId: session.sessionId,
        turnRunning: false,
      };
      this.sessions.push(child);
      return { sessionId: child.sessionId };
    }
    return undefined;
  }
}

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function createBridgeHarness(options: {
  fetchImpl?: typeof fetch;
  autoTitleGraceMs?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-round4-boundary-"));
  directories.push(directory);
  const state = new ConversationStateStore({
    databasePath: join(directory, "state.sqlite"),
    sessionsPath: join(directory, "sessions.json"),
    queuePath: join(directory, "queue.json"),
    masterSecret: Buffer.alloc(32, 9).toString("base64url"),
  });
  await state.initialize();
  const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
  await eventLog.initialize();
  const native = new BoundaryNativeInspector();
  const settingsPath = join(directory, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://gateway.example.test",
      ANTHROPIC_AUTH_TOKEN: "boundary-token",
    },
  }));
  const bridge = new ClaudeDesktopBridge({
    settingsPath,
    eventLog,
    conversationState: state,
    inspector: native,
    fetchImpl: options.fetchImpl ?? (async () => new Response("offline", { status: 503 })),
    environment: {},
    home: directory,
    scanCatalog: async () => ({ projects: [], sessions: [], observedAt: 0 }),
    refreshIntervalMs: 60_000,
    autoTitleGraceMs: options.autoTitleGraceMs ?? 5,
  });
  await bridge.initialize();
  return {
    directory,
    settingsPath,
    native,
    state,
    eventLog,
    bridge,
    async close() {
      await bridge.close();
      await eventLog.close();
      state.close();
    },
  };
}

describe("Round-4 Boundary 2A.1: Inspector checkbox toggle serialization & deduplication", () => {
  it("deduplicates concurrent enableNow() calls and serializes poll() vs enableNow() so checkbox is clicked at most once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-r4-inspector-race-"));
    directories.push(dir);
    let portListening = false;
    let menuClicks = 0;
    let releaseMenuProbe!: () => void;
    let menuProbeEntered!: () => void;
    const probeEnteredPromise = new Promise<void>((resolve) => {
      menuProbeEntered = resolve;
    });
    const holdMenuProbe = new Promise<void>((resolve) => {
      releaseMenuProbe = resolve;
    });

    const menu = vi.fn<
      (pid: number, press: boolean) => Promise<"waiting" | "ready" | "enabled" | "clicked">
    >(async (_pid, press) => {
      if (!press) {
        menuProbeEntered();
        await holdMenuProbe;
        return portListening ? "enabled" : "ready";
      }
      menuClicks += 1;
      // Checkbox toggle semantics: clicking a second time would turn port 9229 OFF!
      portListening = !portListening;
      return "clicked";
    });

    const startup = new ClaudeInspectorStartup({
      recordPath: join(dir, "startup.json"),
      processes: async () => [{ pid: 777, identity: "777:Mon Nov 16 20:00:00 2026:/Applications/Claude.app/Contents/MacOS/Claude" }],
      menu,
      ensureDeveloperSettings: async () => undefined,
      sleep: async () => undefined,
      explicitMenuAttempts: 3,
      explicitPortAttempts: 3,
    });

    const updates: BridgeInspectorStatus[] = [];
    const monitor = new ClaudeInspectorMonitor({
      platform: "darwin",
      intervalMs: 60_000,
      scan: async () => ({ listening: portListening, clients: [] }),
      startup: listening => startup.check(listening),
      enableStartup: checkListening => startup.enableExplicit(checkListening),
      onAlert: () => undefined,
      onUpdate: status => updates.push(status),
    });

    try {
      // Start passive pollNow() (which blocks inside menu(777, false)) AND concurrently fire two enableNow() calls.
      const passivePoll = monitor.pollNow();
      await probeEnteredPromise;
      const enableA = monitor.enableNow();
      const enableB = monitor.enableNow();

      releaseMenuProbe();
      const [, statusA, statusB] = await Promise.all([passivePoll, enableA, enableB]);

      expect(menuClicks).toBe(1);
      expect(portListening).toBe(true);
      expect(statusA).toBe(statusB);
      expect(statusA.state).toBe("listening");

      // Even if user closes port 9229 and double-taps enableNow() simultaneously, checkbox is clicked once.
      portListening = false;
      const [reEnable1, reEnable2, reEnable3] = await Promise.all([
        monitor.enableNow(),
        monitor.enableNow(),
        monitor.pollNow().then(() => monitor.enableNow()),
      ]);
      expect(menuClicks).toBe(2);
      expect(portListening).toBe(true);
      expect(reEnable1.state).toBe("listening");
      expect(reEnable2.state).toBe("listening");
      expect(reEnable3.state).toBe("listening");
    } finally {
      monitor.close();
    }
  });

  it("deduplicates concurrent DesktopController.launchDesktopApp('claude-desktop') RPCs onto a single launch + enablement", async () => {
    let appState: "stopped" | "running" = "stopped";
    let releaseEnable!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    const launch = vi.fn(async () => {
      appState = "running";
      return { state: appState, detail: "running", canLaunch: false, canQuit: true };
    });
    const enableInspector = vi.fn<() => Promise<BridgeInspectorStatus>>(async () => {
      await gate;
      return {
        platform: "darwin",
        state: "listening",
        port: 9229,
        pollIntervalMs: 3_000,
        clients: [],
        alerts: [],
      };
    });
    const claudeDesktop = {
      definition: { id: "claude-desktop" as const, displayName: "Claude Desktop" },
      status: vi.fn(async () => ({
        state: appState,
        detail: "ok",
        canLaunch: appState === "stopped",
        canQuit: appState === "running",
      })),
      launch,
      takeLaunchNote: vi.fn(() => undefined),
      quit: vi.fn(),
    };
    const controller = createControllerFixture({
      config: {
        devices: [],
        relayEndpoints: [],
        hostDeviceId: "host-r4",
        pairingEpoch: 1,
        desktopName: "Mac",
        relayUrl: "ws://127.0.0.1:8787",
        launchAtLogin: false,
        managedDesktopEnabled: false,
      },
      app: { getVersion: () => "1.3.5" },
      inspectorStatus: {
        platform: "darwin",
        state: "closed",
        port: 9229,
        pollIntervalMs: 3_000,
        clients: [],
        alerts: [],
      } satisfies BridgeInspectorStatus,
      runtimeAttachSleep: vi.fn(async () => undefined),
      claudeDesktop,
      desktopAppControls: new Map([["claude-desktop", claudeDesktop]]),
      broker: {
        refreshRuntime: vi.fn(async () => true),
        runtimeStatus: () => ({
          state: "ready" as const,
          detail: "ok",
          activeTurns: 0,
          maxParallelTurns: 0,
          desktopIntegration: { state: "ready" as const, detail: "ok", enabled: true, canRestart: false },
        }),
        capabilities: () => ["session.list"],
        listSessions: () => [],
        listProjects: () => [],
        magpieSettings: async () => ({}),
        promptsList: () => [],
        permissionsList: () => [],
      },
      eventLog: { latestSeq: () => 0, append: vi.fn(async () => undefined) },
    });
    controller.attachInspectorEnabler(enableInspector);

    const p1 = controller.launchDesktopApp("claude-desktop");
    const p2 = controller.launchDesktopApp("claude-desktop");
    releaseEnable();
    const [snap1, snap2] = await Promise.all([p1, p2]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(enableInspector).toHaveBeenCalledTimes(1);
    expect(snap1.claudeInspector?.state).toBe("listening");
    expect(snap2.claudeInspector?.state).toBe("listening");
  });
});

describe("Round-4 Boundary 2A.2: Title generator Unicode, injection, gateway errors & lifecycle races", () => {
  it("preserves UTF-16 surrogate pairs, strips lone surrogates, and handles slash commands, XSS strings, giant pastes & multiline quotes", async () => {
    // Surrogate-pair emoji & CJK supplementary plane characters (U+20BB7 𠮷)
    const emojiStream = "🚀🔥✨🧪𠮷".repeat(8);
    expect(sanitizeGeneratedTitle(emojiStream)).toBe(emojiStream);

    const fallbackEmoji = deriveFallbackSessionTitle(emojiStream, false)!;
    expect(Array.from(fallbackEmoji)).toHaveLength(25); // 24 code points + '…'
    expect(fallbackEmoji.endsWith("…")).toBe(true);
    expect(hasLoneSurrogate(fallbackEmoji)).toBe(false);

    expect(sanitizeGeneratedTitle("坏代理\uD800标题\uDC00测试")).toBe("坏代理标题测试");
    expect(sanitizeGeneratedTitle('"""标题"""')).toBe("标题");

    // Empty / whitespace / lone code fence / lone URL / XSS literal / control slash commands
    expect(deriveFallbackSessionTitle("", false)).toBeUndefined();
    expect(deriveFallbackSessionTitle("   \n\t  ", false)).toBeUndefined();
    expect(deriveFallbackSessionTitle("```json\n{\"port\":9229}\n```", false)).toBe('{"port":9229}');
    expect(deriveFallbackSessionTitle("https://claude.ai/settings/developer?debug=9229", false))
      .toBe("https://claude.ai/settin…");
    expect(deriveFallbackSessionTitle("<script>alert(1)</script>", false)).toBe("<script>alert(1)</script…");
    expect(deriveFallbackSessionTitle("<img onerror=alert(1)>", false)).toBe("<img onerror=alert(1)>");
    expect(deriveFallbackSessionTitle("/compact", false)).toBeUndefined();
    expect(deriveFallbackSessionTitle("/btw 顺便问个小问题", false)).toBeUndefined();
    expect(deriveFallbackSessionTitle("/rename 手动指定的新名字", false)).toBeUndefined();

    // 60,000-char giant log paste completes rapidly without OOM or lone surrogates
    const giantPaste = `[2026-11-16 INFO] Worker started 🚀 ${"x".repeat(60_000)}`;
    const t0 = performance.now();
    const giantTitle = deriveFallbackSessionTitle(giantPaste, false)!;
    expect(performance.now() - t0).toBeLessThan(100);
    expect(hasLoneSurrogate(giantTitle)).toBe(false);
    expect(Array.from(giantTitle).length).toBeLessThanOrEqual(25);

    // Gateway failure modes: 429, 500, invalid JSON, empty content[], AbortError timeout
    const gateway = { baseUrl: "https://gateway.example.test", authToken: "tok" };
    for (const badResponse of [
      () => Promise.resolve(new Response("rate limited", { status: 429 })),
      () => Promise.resolve(new Response("internal error", { status: 500 })),
      () => Promise.resolve(new Response("{corrupted-json", { status: 200 })),
      () => Promise.resolve(new Response(JSON.stringify({ content: [] }), { status: 200 })),
      () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    ]) {
      const title = await generateSessionTitle({
        text: "压测网关异常回退逻辑。第二句忽略。",
        gateway,
        fetchImpl: badResponse as unknown as typeof fetch,
        timeoutMs: 25,
      });
      expect(title).toBe("压测网关异常回退逻辑");
    }
  });

  it("guards against deleteSession resurrection, bridge.close() mid-flight, and /rename command races", async () => {
    let releaseGateway!: (res: Response) => void;
    let gatewayCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      if (String(url).includes("/v1/messages")) {
        gatewayCalls += 1;
        return new Promise<Response>((resolve) => {
          releaseGateway = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    });

    const h = await createBridgeHarness({ fetchImpl, autoTitleGraceMs: 5 });
    try {
      // 1. Control slash command (/compact) on blank session does NOT trigger auto-title
      const sSlash = await h.bridge.createSession("/slash-proj");
      await h.bridge.startTurn({
        sessionId: sSlash.sessionId,
        text: "/compact",
        requestId: "r-slash",
        idempotencyKey: "k-slash",
        origin: "mobile",
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(gatewayCalls).toBe(0);

      // 2. /rename via session.command updates session immediately and marks session explicitly titled
      const sRenamed = await h.bridge.createSession("/rename-cmd");
      const renameCmdResult = await h.bridge.runCommand({
        sessionId: sRenamed.sessionId,
        text: "/rename 用户斜杠重命名",
        requestId: "r-ren-1",
        idempotencyKey: "k-ren-1",
        origin: "desktop",
      });
      expect(renameCmdResult).toMatchObject({
        action: "sent",
        session: { sessionId: sRenamed.sessionId, title: "用户斜杠重命名" },
      });
      await h.bridge.startTurn({
        sessionId: sRenamed.sessionId,
        text: "后续发送普通首条业务消息",
        requestId: "r-ren-2",
        idempotencyKey: "k-ren-2",
        origin: "desktop",
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(gatewayCalls).toBe(0);
      expect(h.bridge.session(sRenamed.sessionId)?.title).toBe("用户斜杠重命名");

      // 3. deleteSession() while autoTitleSession is in flight NEVER resurrects the deleted session!
      const sDeleted = await h.bridge.createSession("/delete-race");
      await h.bridge.startTurn({
        sessionId: sDeleted.sessionId,
        text: "这条消息在生成标题途中会话被删除",
        requestId: "r-del",
        idempotencyKey: "k-del",
        origin: "mobile",
      });
      await vi.waitFor(() => expect(gatewayCalls).toBe(1));
      await h.bridge.deleteSession(sDeleted.sessionId);
      expect(h.bridge.session(sDeleted.sessionId)).toBeUndefined();

      releaseGateway(new Response(JSON.stringify({
        content: [{ type: "text", text: "<title>已删除会话不应复活</title>" }],
      }), { status: 200 }));
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(h.bridge.session(sDeleted.sessionId)).toBeUndefined();
      expect(h.bridge.listSessions().some(s => s.sessionId === sDeleted.sessionId)).toBe(false);
      expect(h.native.calls.some(c => c.method === "updateSession" && c.args[0] === sDeleted.sessionId)).toBe(false);

      // 4. bridge.close() mid-flight aborts cleanly before calling updateSession
      const sClosing = await h.bridge.createSession("/close-race");
      await h.bridge.startTurn({
        sessionId: sClosing.sessionId,
        text: "关闭服务时在途自动标题请求",
        requestId: "r-close",
        idempotencyKey: "k-close",
        origin: "mobile",
      });
      await vi.waitFor(() => expect(gatewayCalls).toBe(2));
      await h.bridge.close();
      releaseGateway(new Response(JSON.stringify({
        content: [{ type: "text", text: "<title>关闭后晚到的标题</title>" }],
      }), { status: 200 }));
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(h.native.calls.some(c => c.method === "updateSession" && c.args[0] === sClosing.sessionId)).toBe(false);
    } finally {
      await h.close();
    }
  });
});

describe("Round-4 Boundary 2A.3: Corrupted JSON & EACCES/EPERM write resilience", () => {
  it.each([
    "{corrupted-truncated-json",
    "null",
    "42",
    "[1, 2, 3]",
  ])("recovers cleanly from %s in claude-inspector-startup-v1.json, developer_settings.json, and magpie-connection-v1.json", async (payload) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-r4-corrupt-"));
    directories.push(root);

    // 1. claude-inspector-startup-v1.json: passive check(false) fails closed without clicking OS menu,
    // while check(true) or explicit enableExplicit() recovers and heals the corrupted file!
    const recordPath = join(root, "claude-inspector-startup-v1.json");
    await writeFile(recordPath, payload);
    const corruptMenu = vi.fn<
      (pid: number, press: boolean) => Promise<"waiting" | "ready" | "enabled" | "clicked">
    >(async (_pid, press) => (press ? "clicked" : "ready"));
    const startup = new ClaudeInspectorStartup({
      recordPath,
      processes: async () => [{ pid: 90, identity: "90:start" }],
      menu: corruptMenu,
      ensureDeveloperSettings: async () => undefined,
      sleep: async () => undefined,
    });
    await expect(startup.check(false)).resolves.toMatchObject({ state: "failed" });
    expect(corruptMenu).not.toHaveBeenCalled();
    await expect(startup.check(true)).resolves.toMatchObject({ state: "already-open" });

    // 2. developer_settings.json: non-destructive guard neither throws nor overwrites malformed/non-object user file
    const claudeDir = join(root, "Library", "Application Support", "Claude");
    await mkdir(claudeDir, { recursive: true });
    const devSettingsPath = join(claudeDir, "developer_settings.json");
    await writeFile(devSettingsPath, payload);
    await expect(
      ensureClaudeDeveloperSettingsNonInteractive({ platform: "darwin", environment: {}, home: root }),
    ).resolves.toBeUndefined();
    expect(await readFile(devSettingsPath, "utf8")).toBe(payload);

    // 3. magpie-connection-v1.json
    const magpiePath = join(root, "magpie-connection-v1.json");
    await writeFile(magpiePath, payload);
    const magpieRepo = new MagpieConnectionRepository(magpiePath, {
      isEncryptionAvailable: () => true,
      encryptString: plain => Buffer.from(plain, "utf8"),
      decryptString: cipher => cipher.toString("utf8"),
    });
    await expect(magpieRepo.initialize()).resolves.toBeUndefined();
    expect(magpieRepo.settings()).toEqual({ mode: "auto", keyConfigured: false });
  });

  it("preserves port listening state and security alerts when startup throws or writeFile fails on unwritable paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-r4-eacces-"));
    directories.push(root);

    const rogueClient = { pid: 666, name: "rogue", executablePath: "/tmp/rogue", approved: false };
    const onAlert = vi.fn(() => undefined);
    const onUpdate = vi.fn();

    // Monitor must NOT drop observed.listening or security alerts even if startup callback throws EACCES!
    const monitor = new ClaudeInspectorMonitor({
      platform: "darwin",
      scan: async () => ({ listening: true, clients: [rogueClient] }),
      startup: async () => {
        throw Object.assign(new Error("EACCES: permission denied, open startup.json"), { code: "EACCES" });
      },
      onAlert,
      onUpdate,
    });
    try {
      await monitor.start();
      expect(onAlert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(rogueClient));
      expect(onUpdate.mock.lastCall?.[0]).toMatchObject({
        state: "listening",
        clients: [expect.objectContaining(rogueClient)],
        startup: {
          state: "failed",
          detail: expect.stringContaining("EACCES"),
        },
      });
    } finally {
      monitor.close();
    }

    // Unwritable developer_settings.json (directory collision -> EISDIR) and unwritable recordPath (missing parent -> ENOENT)
    // never crash ensureClaudeDeveloperSettingsNonInteractive or explicit enablement!
    await mkdir(join(root, "Library", "Application Support", "Claude", "developer_settings.json"), { recursive: true });
    await expect(
      ensureClaudeDeveloperSettingsNonInteractive({ platform: "darwin", environment: {}, home: root }),
    ).resolves.toBeUndefined();

    let portOpen = false;
    const menu = vi.fn<
      (pid: number, press: boolean) => Promise<"waiting" | "ready" | "enabled" | "clicked">
    >(async (_pid, press) => {
      if (press) {
        portOpen = true;
        return "clicked";
      }
      return "ready";
    });
    const startup = new ClaudeInspectorStartup({
      // Point recordPath at an existing directory so readFile/writeFile fail with EISDIR!
      recordPath: root,
      processes: async () => [{ pid: 55, identity: "55:start" }],
      menu,
      ensureDeveloperSettings: async () => undefined,
      sleep: async () => undefined,
    });
    const explicitResult = await startup.enableExplicit(async () => portOpen);
    expect(explicitResult.state).toBe("attempted");
    expect(portOpen).toBe(true);
    expect(menu.mock.calls.filter(([, press]) => press)).toHaveLength(1);
  });
});

describe("Round-4 Boundary 2A.4: Section move & claude-unsectioned boundaries", () => {
  it("handles legacy claude-unsectioned creation, external section deletion before move, idempotent null move, and archived/scheduled rejections", async () => {
    const h = await createBridgeHarness();
    try {
      // 1. Creating a session with projectId = "claude-unsectioned" when sectionCatalog is undefined (legacy Desktop)
      expect(h.bridge.capabilities()).not.toContain("section.move");
      const legacyUnsectioned = await h.bridge.createSession(
        "/legacy-folder",
        "兼容旧版未分组创建",
        CLAUDE_UNSECTIONED_PROJECT_ID,
      );
      expect(legacyUnsectioned.cwd).toBe("/legacy-folder");
      expect(legacyUnsectioned.title).toBe("兼容旧版未分组创建");
      expect(legacyUnsectioned.projectId).not.toBe(CLAUDE_UNSECTIONED_PROJECT_ID);

      // 2. Enable native Sections + add archived and scheduled-task sessions
      h.native.sessions.push(
        { sessionId: "s-archived", cwd: "/arch", title: "Archived", isArchived: true, turnRunning: false },
        { sessionId: "s-scheduled", cwd: "/sched", title: "Scheduled", scheduledTaskId: "cron-1", turnRunning: false },
      );
      const sections = await createNativeSectionFixture(h.directory);
      const assignSpy = vi.fn(sections.assignSection);
      Object.assign(h.native, {
        sections: sections.sections,
        createSection: sections.createSection,
        assignSection: assignSpy,
        renameSection: sections.renameSection,
        deleteSection: sections.deleteSection,
      });
      await h.bridge.refreshRuntime();

      const secAlpha = await h.bridge.createSection("Alpha");
      // Archived and scheduled-task sessions cannot be moved
      await expect(h.bridge.moveSessionSection("s-archived", secAlpha.projectId)).rejects.toThrow(NativeCallError);
      await expect(h.bridge.moveSessionSection("s-scheduled", secAlpha.projectId)).rejects.toThrow(NativeCallError);
      await expect(h.bridge.moveSessionSection("s-archived", null)).rejects.toThrow("cannot be moved");

      // 3. Moving an already-unsectioned session to null is idempotent and preserves cwd + 未分组
      expect(h.bridge.session("local-native")).toMatchObject({
        projectId: CLAUDE_UNSECTIONED_PROJECT_ID,
        projectName: CLAUDE_UNSECTIONED_PROJECT_NAME,
        cwd: "/project",
      });
      const stillUnsectioned = await h.bridge.moveSessionSection("local-native", null);
      expect(stillUnsectioned).toMatchObject({
        projectId: CLAUDE_UNSECTIONED_PROJECT_ID,
        projectName: CLAUDE_UNSECTIONED_PROJECT_NAME,
        cwd: "/project",
      });

      // 4. Section deleted externally in Claude Desktop AFTER last refreshRuntime():
      // moveSessionSection refreshes first, rejects cleanly without calling assignSection, and prunes stale section!
      assignSpy.mockClear();
      await writeFile(sections.profile, JSON.stringify({ "account-a/org-a": { sections: [], assignments: {} } }));
      await expect(h.bridge.moveSessionSection("local-native", secAlpha.projectId)).rejects.toThrow("no longer available");
      expect(assignSpy).not.toHaveBeenCalled();
      expect(h.bridge.listProjects().some(p => p.projectId === secAlpha.projectId)).toBe(false);
    } finally {
      await h.close();
    }
  });
});
