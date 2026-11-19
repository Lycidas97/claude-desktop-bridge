import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_TRANSFER_TTL_MS } from "@bridge/protocol";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMailService } from "../../../../plugins/assistant-mail/desktop.js";
import { diagnostics } from "../app/diag.js";
import { ClaudeDesktopBridge } from "../claude/claude-desktop-bridge.js";
import { ClaudeDesktopInspector } from "../claude/claude-desktop-inspector.js";
import { EvidenceManager } from "../evidence/evidence-manager.js";
import { EvidenceStore } from "../evidence/evidence-store.js";
import { FileUploadManager } from "../evidence/file-upload.js";
import { ConversationStateStore } from "./conversation-state-store.js";
import { DesktopController } from "./controller.js";
import { SessionEventLog } from "./session-event-log.js";

class SyntheticMailInbox extends EventEmitter {
  capabilities = new Map([["IDLE", true]]);
  enabled = new Set<string>();
  uidValidity = 1n;
  uidNext = 10;
  messages: FetchMessageObject[] = [];
  finishIdle: (() => void) | undefined;
  connect = vi.fn(async () => {});
  mailboxOpen = vi.fn(async () => ({ uidValidity: this.uidValidity, uidNext: this.uidNext }));
  noop = vi.fn(async () => { this.finishIdle?.(); });
  idle = vi.fn(() => new Promise<void>((resolve) => { this.finishIdle = resolve; }));
  close = vi.fn(() => { this.finishIdle?.(); this.emit("close"); });
  fetchOne = vi.fn(async (uid: string) => this.messages.find((message) => message.uid === Number(uid)) ?? false);

  async *fetch(range: string) {
    const start = Number(range.split(":")[0]);
    const selected = this.messages.filter((message) => message.uid >= start);
    for (const message of selected.length ? selected : this.messages.slice(-1)) yield message;
  }

  deliver(uid: number, subject: string, sender: string, body: string) {
    this.messages.push({
      uid,
      seq: this.messages.length + 1,
      source: Buffer.from(`From: ${sender}\r\nSubject: ${subject}\r\n\r\n${body}`),
      envelope: { subject, from: [{ address: sender }] },
      internalDate: new Date("2026-11-15T00:00:00Z"),
    });
    this.uidNext = uid + 1;
    this.emit("exists", { count: this.messages.length });
  }
}

describe("DesktopController unified diagnostics & redaction", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    diagnostics.close();
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it("distinguishes pending ClaudeDesktopInspector RPC calls from the idle native.stream long-poll", async () => {
    class FakeInspectorWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FakeInspectorWebSocket.OPEN;
      sent: Array<{ id: number; method: string; params: { expression: string } }> = [];

      constructor(readonly url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(raw: string) {
        const parsed = JSON.parse(raw) as { id: number; method: string; params: { expression: string } };
        this.sent.push(parsed);
        const expr = parsed.params.expression;
        if (expr.includes("getAllWebContents")) {
          this.reply(parsed.id, { id: 7, methods: ["getAll", "onOnEvent", "getTranscriptPage"] });
        } else if (expr.includes("onOnToolPermissionRequest")) {
          this.reply(parsed.id, { ok: true, value: true });
        } else if (expr.includes("dispose()")) {
          this.reply(parsed.id, { ok: true, value: undefined });
        }
        // Leave both `next()` (native.stream) and `getTranscriptPage` pending so we can inspect gauges!
      }

      reply(id: number, value: unknown) {
        queueMicrotask(() => {
          const event = Object.assign(new Event("message"), {
            data: JSON.stringify({ id, result: { result: { value } } }),
          });
          this.dispatchEvent(event);
        });
      }

      close() {
        this.readyState = FakeInspectorWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    }

    vi.stubGlobal("WebSocket", FakeInspectorWebSocket);
    let clock = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const inspector = new ClaudeDesktopInspector({
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [{ type: "node", webSocketDebuggerUrl: "ws://127.0.0.1:9229/secret-inspector-uuid" }],
      })) as unknown as typeof fetch,
      rpcTimeoutMs: 60_000,
    });
    cleanups.push(() => inspector.close());

    await inspector.connect();
    // Advance clock 30s while only the standing native.stream poll is waiting: pendingCalls must stay 0!
    clock += 30_000;
    expect(inspector.diagnosticsGauges()).toEqual({
      state: "connected",
      pendingCalls: { count: 0, oldestMs: 0 },
      eventStreamWaiting: true,
      supportedMethods: 3,
    });

    // Start an actual RPC call and advance clock 2,500ms: pendingCalls must report count=1, oldestMs=2500.
    const rpcCall = inspector.call("getTranscriptPage", ["sess-secret"]);
    rpcCall.catch(() => undefined);
    await Promise.resolve();
    clock += 2_500;
    const gauges = inspector.diagnosticsGauges();
    expect(gauges).toEqual({
      state: "connected",
      pendingCalls: { count: 1, oldestMs: 2_500 },
      eventStreamWaiting: true,
      supportedMethods: 3,
    });
    expect(JSON.stringify(gauges)).not.toMatch(/secret-inspector-uuid|sess-secret/);
  });

  it("exports processMemory, traceRecorder, and all 5 service stateGauges with zero plaintext leakage", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-controller-diag-"));
    const workspaceDir = join(root, "SECRET_WORKSPACE_PATH");
    await mkdir(workspaceDir, { recursive: true });

    // 1. Enable traceRecorder on a private SQLite file and open one active stage
    const tracePath = join(root, "diag", "trace.sqlite");
    diagnostics.enabled = true;
    diagnostics.start(tracePath);
    const finishStage = diagnostics.begin("handler.session.history");
    cleanups.push(() => { finishStage(); diagnostics.close(); });

    // 2. Real SessionEventLog + ConversationStateStore
    const eventLog = new SessionEventLog(join(root, "events", "events.ndjson"));
    await eventLog.initialize();
    const conversationState = new ConversationStateStore({
      databasePath: join(root, "state", "conversation.sqlite"),
    });
    await conversationState.initialize();
    cleanups.push(() => conversationState.close());

    // 3. Real EvidenceStore + EvidenceManager with cached preview, active capture, in-flight render, and transfer
    let releasePreviewRender!: () => void;
    const evidenceStore = new EvidenceStore({
      databasePath: join(root, "evidence", "evidence.sqlite"),
      blobsPath: join(root, "evidence", "blobs"),
      masterSecret: "SECRET_MASTER_KEY_MATERIAL",
    });
    const evidence = new EvidenceManager({
      store: evidenceStore,
      eventLog,
      previewRenderer: {
        image: async (bytes, mimeType) => ({ bytes, mimeType }),
        html: async () => {
          await new Promise<void>((resolve) => { releasePreviewRender = resolve; });
          return { bytes: Buffer.from("PNG_PREVIEW_BYTES"), mimeType: "image/png" };
        },
      },
    });
    await evidence.initialize();
    cleanups.push(() => evidence.close());

    const readyTurnId = await evidence.startBridgeTurn({
      sessionId: "sess-secret-1",
      cwd: workspaceDir,
      commandId: "cmd-1",
    });
    await evidence.recordToolStarted({
      sessionId: "sess-secret-1",
      itemId: "tool-1",
      toolName: "Bash",
      toolInput: { command: "echo SECRET_TOOL_COMMAND" },
      at: 100,
    });
    await evidence.recordToolCompleted({
      sessionId: "sess-secret-1",
      itemId: "tool-1",
      output: "SECRET_TOOL_OUTPUT_LINE",
      at: 200,
    });
    await writeFile(join(workspaceDir, "secret-report.html"), "<h1>SECRET_HTML_BODY</h1>", "utf8");
    await writeFile(join(workspaceDir, "secret-image.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const readyBundle = await evidence.finalizeBridgeTurn({ sessionId: "sess-secret-1" });
    expect(readyTurnId).toBeTruthy();
    const imageArtifact = readyBundle!.artifacts.find((item) => item.name === "secret-image.png")!;
    const htmlArtifact = readyBundle!.artifacts.find((item) => item.name === "secret-report.html")!;
    await evidence.preview(imageArtifact.id);
    const inFlightHtmlPreview = evidence.preview(htmlArtifact.id);
    await vi.waitFor(() => expect(releasePreviewRender).toBeTypeOf("function"));

    // Start a second collecting turn + open an in-memory transfer
    await evidence.startBridgeTurn({
      sessionId: "sess-secret-2",
      cwd: workspaceDir,
      commandId: "cmd-2",
    });
    await evidence.recordToolCompleted({
      sessionId: "sess-secret-2",
      itemId: "tool-live",
      output: "SECRET_ACTIVE_OUTPUT",
      at: 300,
    });
    evidence.openBytesTransfer({
      artifactId: imageArtifact.id,
      name: "secret-image.png",
      mimeType: "image/png",
      bytes: Buffer.from("SECRET_TRANSFER_PAYLOAD"),
    }, "device-secret-1");

    // 4. Real FileUploadManager with an active chunked upload holding buffered bytes
    const uploads = new FileUploadManager();
    cleanups.push(() => uploads.close());
    const uploadPayload = Buffer.from("SECRET_UPLOAD_CHUNK_CONTENT");
    const openedUpload = await uploads.open({
      owner: "device-secret-1",
      sessionId: "sess-secret-1",
      cwd: workspaceDir,
      name: "secret-contract.pdf",
      size: uploadPayload.byteLength,
      sha256: createHash("sha256").update(uploadPayload).digest("hex"),
    });
    uploads.write(openedUpload.uploadId, 0, uploadPayload.toString("base64"), "device-secret-1");

    // 5. Real ClaudeDesktopBridge with synthetic InspectorTransport
    const fakeInspector = Object.assign(new EventEmitter(), {
      ready: true,
      supports: () => true,
      connect: async () => {},
      close: async () => {},
      call: async (method: string) => {
        if (method === "getAll") {
          return [{
            sessionId: "sess-secret-1",
            cwd: workspaceDir,
            title: "SECRET_NATIVE_SESSION_TITLE",
            isRunning: true,
            turnRunning: true,
            pendingToolPermissions: [{
              requestId: "perm-secret-1",
              toolUseId: "tool-perm-1",
              toolName: "Bash",
              input: { command: "cat /Users/secret/.env" },
            }],
          }];
        }
        return undefined;
      },
      availableCodeModels: async () => ["claude-sonnet-4-6"],
      diagnosticsGauges: () => ({
        state: "connected" as const,
        pendingCalls: { count: 2, oldestMs: 940 },
        eventStreamWaiting: true,
        supportedMethods: 18,
      }),
    });
    const broker = new ClaudeDesktopBridge({
      settingsPath: join(root, "claude-settings.json"),
      eventLog,
      conversationState,
      evidence,
      inspector: fakeInspector,
      refreshIntervalMs: 60_000,
    });
    await broker.initialize();
    cleanups.push(() => broker.close());

    // 6. Real AssistantMailService with 2 received messages (1 pending unread, 1 processed)
    const secrets = new Map<string, string>();
    const inbox = new SyntheticMailInbox();
    const assistantMail = new AssistantMailService({
      userDataPath: root,
      credentials: {
        supported: true,
        get: async (key) => secrets.get(key),
        set: async (key, value) => { secrets.set(key, value); },
        delete: async key => { secrets.delete(key); },
      },
      createClient: () => inbox as unknown as ImapFlow,
    });
    await assistantMail.initialize();
    cleanups.push(() => assistantMail.close());
    await assistantMail.enable({
      host: "imap.secret-mail.test",
      user: "secret-user@example.com",
      password: "SECRET_IMAP_PASSWORD",
    });
    await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
    inbox.deliver(10, "SECRET_MAIL_SUBJECT_1", "alice-secret@example.com", "SECRET_MAIL_BODY_1");
    inbox.deliver(11, "SECRET_MAIL_SUBJECT_2", "bob-secret@example.com", "SECRET_MAIL_BODY_2");
    await vi.waitFor(() => expect(assistantMail.page().events).toHaveLength(2));
    assistantMail.setProcessingStatus(assistantMail.page().events[0]!.mailRefId, "processed");

    // 7. Assemble DesktopController with initialized config & state
    const controller = new DesktopController(
      { getVersion: () => "1.3.4" } as never,
      {} as never,
      "https://pair.example.test",
      "wss://relay.example.test/ws",
      broker,
      eventLog,
      evidence,
      { definition: { id: "claude-desktop", displayName: "Claude Desktop" }, status: async () => ({ installed: true, running: true, state: "running", detail: "OK", canLaunch: false, canQuit: true }), launch: async () => {}, quit: async () => {} } as never,
      undefined,
      undefined,
      conversationState,
      undefined,
      { diagnostics: () => ({ status: "ok", columns: ["at"], rows: [[1]] }) },
      assistantMail,
    );
    const internal = controller as unknown as Record<string, unknown>;
    internal.config = {
      hostDeviceId: "host-secret-id",
      pairingEpoch: 1,
      roomId: "room-secret-id",
      hostSecret: "SECRET_HOST_KEY",
      desktopName: "SECRET_DESKTOP_HOSTNAME",
      relayUrl: "wss://relay.example.test/ws",
      serviceOrigin: "https://relay.example.test",
      relayEndpoints: [],
      activeEndpoint: "public",
      iceServers: [],
      launchAtLogin: false,
      diagnosticsEnabled: true,
      managedDesktopEnabled: false,
      devices: [
        {
          deviceId: "dev-paired",
          name: "SECRET_PHONE_NAME",
          platform: "ios",
          secret: "SECRET_DEVICE_KEY_1",
          createdAt: 1,
          expiresAt: 100,
          pairedAt: 2,
        },
        {
          deviceId: "dev-pending",
          name: "手机 Bridge",
          platform: "unknown",
          secret: "SECRET_DEVICE_KEY_2",
          createdAt: 1,
          expiresAt: Date.now() + 600_000,
        },
        {
          deviceId: "dev-revoked",
          name: "Old Phone",
          platform: "android",
          secret: "SECRET_DEVICE_KEY_3",
          createdAt: 1,
          expiresAt: 100,
          revokedAt: 50,
        },
      ],
    };
    internal.currentPairingDeviceId = "dev-pending";
    internal.uploads = uploads;
    (internal.onlineDevices as Set<string>).add("dev-paired");
    (internal.deviceCryptos as Map<string, unknown>).set("dev-paired", {});
    (internal.deviceCryptos as Map<string, unknown>).set("dev-pending", {});

    try {
      const exported = controller.diagnostics();
      expect(exported).toMatchObject({
        bridgeVersion: "1.3.4",
        processMemory: {
          rss: expect.any(Number),
          heapUsed: expect.any(Number),
          heapTotal: expect.any(Number),
          external: expect.any(Number),
          arrayBuffers: expect.any(Number),
        },
        traceRecorder: {
          enabled: true,
          schema: 1,
          stages: {
            "handler.session.history": expect.objectContaining({
              started: 1,
              active: 1,
              peak: 1,
            }),
          },
        },
        stateGauges: {
          controller: {
            devicesTotal: 3,
            activeDevices: 2,
            onlineDevices: 1,
            deviceCryptos: 2,
            deflateDevices: 0,
            responseCacheEntries: 0,
            hasPendingPairing: true,
          },
          uploads: {
            activeSessions: 1,
            retainedSessions: 1,
            committedReceipts: 0,
            bufferedChunks: 1,
            bufferedBytes: uploadPayload.byteLength,
          },
          broker: expect.objectContaining({
            closed: false,
            inspectorState: "connected",
            pendingInspectorCalls: { count: 2, oldestMs: 940 },
            inspectorEventStreamWaiting: true,
            inspectorSupportedMethods: 18,
            nativeSessions: 1,
            projectedSessions: 1,
            activeTurns: 1,
            permissions: 1,
          }),
          evidence: expect.objectContaining({
            inFlightPreviewRenders: 1,
            cachedPreviews: 1,
            activeCaptures: 1,
            activeToolOutputBytes: Buffer.byteLength("SECRET_ACTIVE_OUTPUT"),
            activeTransfers: 1,
            retainedTransfers: 1,
            retainedTransferBytes: Buffer.byteLength("SECRET_TRANSFER_PAYLOAD"),
          }),
          assistantMail: {
            available: true,
            configured: true,
            unreadCount: 1,
          },
        },
        memory: { status: "ok", columns: ["at"], rows: [[1]] },
      });

      const serialized = JSON.stringify(exported);
      expect(serialized).not.toMatch(
        /SECRET_|secret-contract\.pdf|secret-report\.html|secret-image\.png|secret-user@example\.com|alice-secret|bob-secret|imap\.secret-mail\.test|\/Users\/secret/,
      );
    } finally {
      releasePreviewRender();
      await inFlightHtmlPreview;
    }
  });

  it("keeps reporting retained upload and artifact-transfer buffers after lease TTL expiry until pruned", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-expired-transfer-diag-"));
    const workspaceDir = join(root, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    let clock = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const uploads = new FileUploadManager();
    cleanups.push(() => uploads.close());
    const uploadBytes = Buffer.alloc(4096, 0x61);
    const openedUpload = await uploads.open({
      owner: "device-1",
      sessionId: "sess-1",
      cwd: workspaceDir,
      name: "abandoned.bin",
      size: uploadBytes.byteLength,
      sha256: createHash("sha256").update(uploadBytes).digest("hex"),
    });
    uploads.write(openedUpload.uploadId, 0, uploadBytes.toString("base64"), "device-1");

    const eventLog = new SessionEventLog(join(root, "events", "events.ndjson"));
    await eventLog.initialize();
    const evidenceStore = new EvidenceStore({
      databasePath: join(root, "evidence", "evidence.sqlite"),
      blobsPath: join(root, "evidence", "blobs"),
      masterSecret: "test-secret",
    });
    const evidence = new EvidenceManager({ store: evidenceStore, eventLog });
    await evidence.initialize();
    cleanups.push(() => evidence.close());
    evidence.openBytesTransfer({
      artifactId: "art-1",
      name: "abandoned-transfer.bin",
      mimeType: "application/octet-stream",
      bytes: Buffer.alloc(8192, 0x62),
    }, "device-1");

    expect(uploads.diagnosticsGauges()).toEqual({
      activeSessions: 1,
      retainedSessions: 1,
      committedReceipts: 0,
      bufferedChunks: 1,
      bufferedBytes: 4096,
    });
    expect(evidence.diagnosticsGauges()).toMatchObject({
      activeTransfers: 1,
      retainedTransfers: 1,
      retainedTransferBytes: 8192,
    });

    // Advance past ARTIFACT_TRANSFER_TTL_MS without performing any intervening upload/transfer operation.
    clock += ARTIFACT_TRANSFER_TTL_MS + 1;

    expect(uploads.diagnosticsGauges()).toEqual({
      activeSessions: 0,
      retainedSessions: 1,
      committedReceipts: 0,
      bufferedChunks: 1,
      bufferedBytes: 4096,
    });
    expect(evidence.diagnosticsGauges()).toMatchObject({
      activeTransfers: 0,
      retainedTransfers: 1,
      retainedTransferBytes: 8192,
    });

    // Once a subsequent operation triggers prune(), the retained buffers drop to zero.
    uploads.cancel(openedUpload.uploadId, "device-1");
    expect(uploads.diagnosticsGauges()).toEqual({
      activeSessions: 0,
      retainedSessions: 0,
      committedReceipts: 0,
      bufferedChunks: 0,
      bufferedBytes: 0,
    });
  });
});
