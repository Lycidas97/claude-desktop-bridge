import { once } from "node:events";
import { rm, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopBridge } from "./claude-desktop-bridge.js";
import { ConversationStateStore } from "../controller/conversation-state-store.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import { MagpieConnectionRepository } from "./magpie-connection.js";
import { fixture, NativeDesktop, turnInput as input } from "./claude-desktop-bridge-fixture.js";

describe("manual session title persistence and automatic first-turn title generation", () => {
  it("persists an explicit user-provided title via updateSession when start(withoutFirstMessage) leaves native.title empty", async () => {
    const f = await fixture();
    try {
      f.native.ignoreStartTitle = true;
      const created = await f.bridge.createSession("/new-project", "  移动端远程控制重构  ");
      expect(created.title).toBe("移动端远程控制重构");
      expect(f.native.calls.find(call => call.method === "start")?.args[0]).toMatchObject({
        cwd: "/new-project",
        title: "移动端远程控制重构",
        withoutFirstMessage: true,
        message: "",
      });
      expect(f.native.calls.filter(call => call.method === "updateSession")).toEqual([
        { method: "updateSession", args: [created.sessionId, { title: "移动端远程控制重构" }] },
      ]);

      // Subsequent first turn must NOT auto-title a manually titled session.
      await f.bridge.startTurn({ ...input, sessionId: created.sessionId, idempotencyKey: "manual-1", text: "随便聊聊" });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(f.native.calls.filter(call => call.method === "updateSession")).toHaveLength(1);
      expect(f.bridge.session(created.sessionId)?.title).toBe("移动端远程控制重构");
    } finally {
      await f.close();
    }
  });

  it("falls back from an invalid Desktop gateway title asynchronously, ignores the manual gateway, and skips sidechats", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-autotitle-"));
    const state = new ConversationStateStore({
      databasePath: join(directory, "state.sqlite"),
      sessionsPath: join(directory, "sessions.json"),
      queuePath: join(directory, "queue.json"),
      masterSecret: Buffer.alloc(32, 5).toString("base64url"),
    });
    await state.initialize();
    const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
    await eventLog.initialize();
    const native = new NativeDesktop();
    native.ignoreStartTitle = true;

    let releaseTitleResponse!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      if (url === "https://manual.example.test/v1/models?limit=1000") {
        return Promise.resolve(Response.json({ data: [{ id: "manual-only-model" }] }));
      }
      return new Promise<Response>((resolve) => {
        releaseTitleResponse = resolve;
      });
    });

    const titleToken = "fixture-title-key";
    await writeFile(join(directory, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://gateway.example.test",
        ANTHROPIC_AUTH_TOKEN: titleToken,
      },
    }));

    const magpieConnection = new MagpieConnectionRepository(join(directory, "magpie.json"), {
      isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from(text, "utf8"),
      decryptString: buffer => buffer.toString("utf8"),
    });
    await magpieConnection.save({ mode: "manual", baseUrl: "https://manual.example.test", authScheme: "x-api-key", apiKey: "manual-key" });
    const bridge = new ClaudeDesktopBridge({
      settingsPath: join(directory, "settings.json"),
      eventLog,
      conversationState: state,
      inspector: native,
      magpieConnection,
      fetchImpl,
      environment: {},
      home: directory,
      scanCatalog: async () => ({ projects: [], sessions: [], observedAt: 0 }),
      refreshIntervalMs: 60_000,
      autoTitleGraceMs: 5,
    });
    await bridge.initialize();

    try {
      const blank = await bridge.createSession("/new-project", "   ");
      expect(native.calls.find(call => call.method === "start")?.args[0]).not.toHaveProperty("title");
      expect(blank.title).toBe("Claude 会话");

      // startTurn resolves immediately without waiting for the background HTTP title request.
      const receipt = await bridge.startTurn({
        sessionId: blank.sessionId,
        text: "检查松港界面的用户动线。找出风格不统一的页面。",
        requestId: "req-1",
        idempotencyKey: "idem-1",
        origin: "mobile",
      });
      expect(receipt.state).toBe("submitted");
      await vi.waitFor(() => expect(releaseTitleResponse).toBeTypeOf("function"));
      expect.soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([
        ["https://gateway.example.test/v1/messages", expect.objectContaining({
          headers: expect.objectContaining({ authorization: `Bearer ${titleToken}`, "x-api-key": titleToken }),
          body: expect.stringContaining('"model":"claude-3-5-haiku-latest"'),
        })],
      ]);
      expect(bridge.session(blank.sessionId)?.title).toBe("Claude 会话");

      const changed = once(bridge, "changed");
      releaseTitleResponse(Response.json({
        content: [{ type: "text", text: "关于示例开发工具的背景信息与功能介绍：此工具由示例公司开发，可在终端中执行多种自动化任务。" }],
      }));
      await changed;

      expect(bridge.session(blank.sessionId)?.title).toBe("检查松港界面的用户动线");
      expect(native.calls.filter(call => call.method === "updateSession")).toEqual([
        { method: "updateSession", args: [blank.sessionId, { title: "检查松港界面的用户动线" }] },
      ]);

      // A second turn on the same session never triggers another title generation request.
      const messageCallsBefore = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/v1/messages")).length;
      await bridge.startTurn({
        sessionId: blank.sessionId,
        text: "继续补充边界测试",
        requestId: "req-2",
        idempotencyKey: "idem-2",
        origin: "mobile",
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/v1/messages"))).toHaveLength(messageCallsBefore);

      // Sidechat (/btw) with empty title must never be auto-titled.
      native.sessions.push({
        sessionId: "side-1",
        cwd: "/new-project",
        title: "",
        isRunning: false,
        turnRunning: false,
        spawnedFrom: { sessionId: blank.sessionId, btw: true },
      });
      await bridge.refreshRuntime();
      await bridge.startTurn({
        sessionId: "side-1",
        text: "顺便问一下这个类型怎么写",
        requestId: "req-side",
        idempotencyKey: "idem-side",
        origin: "mobile",
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(native.calls.some(call => call.method === "updateSession" && call.args[0] === "side-1")).toBe(false);

      await writeFile(join(directory, "settings.json"), "{}");
      fetchImpl.mockClear().mockResolvedValue(Response.json({ content: [{ type: "text", text: "来自手动网关" }] }));
      const noGateway = await bridge.createSession("/new-project");
      const titleTask = vi.spyOn(bridge as unknown as { autoTitleSession(): Promise<void> }, "autoTitleSession");
      await bridge.startTurn({ ...input, sessionId: noGateway.sessionId, text: "没有可用的 Desktop 网关" });
      expect(titleTask).toHaveBeenCalledOnce();
      await titleTask.mock.results[0]!.value;
      expect.soft(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
      expect(bridge.session(noGateway.sessionId)?.title).toBe("Claude 会话");
    } finally {
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["fixed", "host-auth", "host-url"] as const)("keeps Desktop models for %s titles across Magpie modes", async (source) => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-autotitle-profile-"));
    const state = new ConversationStateStore({ databasePath: join(directory, "state.sqlite") });
    await state.initialize();
    const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
    await eventLog.initialize();
    const native = new NativeDesktop();
    const appData = join(directory, "AppData", "Roaming");
    const library = join(appData, "Claude-3p", "configLibrary");
    await mkdir(library, { recursive: true });
    await writeFile(join(library, "_meta.json"), JSON.stringify({ appliedId: "active" }));
    await writeFile(join(library, "active.json"), JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://desktop.example.test",
      inferenceGatewayAuthScheme: "x-api-key",
      inferenceGatewayApiKey: "desktop-key",
      inferenceModels: [{ name: "desktop-profile-model", labelOverride: "Desktop profile model" }],
    }), { mode: 0o600 });

    const hostPath = join(appData, "Claude-3p", "host-creds-title.json");
    const baseUrl = source === "host-url" ? "https://host.example.test" : "https://desktop.example.test";
    if (source !== "fixed") {
      await writeFile(hostPath, JSON.stringify({ env: {
        ANTHROPIC_API_KEY: "host-key",
        CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_API_KEY",
        ...(source === "host-url" ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
      } }), { mode: 0o600 });
    }
    let now = 1_000;
    let desktopCatalogAvailable = false;
    const desktopModelsUrl = `${baseUrl}/v1/models?limit=1000`;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === "https://manual.example.test/v1/models?limit=1000") {
        return Response.json({ data: [{ id: "manual-only-model" }] });
      }
      if (url === desktopModelsUrl && desktopCatalogAvailable) {
        return Response.json({ data: [{ id: "host-only-model" }] });
      }
      if (url === `${baseUrl}/v1/messages`) {
        return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "<title>Fix <Button> focus</title>" }] });
      }
      return new Response(null, { status: 503 });
    });
    const bridge = new ClaudeDesktopBridge({
      settingsPath: join(directory, "settings.json"), eventLog, conversationState: state, inspector: native,
      magpieConnection: new MagpieConnectionRepository(join(directory, "magpie.json"), {
        isEncryptionAvailable: () => true,
        encryptString: text => Buffer.from(text, "utf8"),
        decryptString: buffer => buffer.toString("utf8"),
      }),
      fetchImpl, platform: "win32", environment: { APPDATA: appData, ...(source === "fixed" ? {} : { CLAUDE_CODE_HOST_CREDS_FILE: hostPath }) }, home: directory,
      scanCatalog: async () => ({ projects: [], sessions: [], observedAt: 0 }), refreshIntervalMs: 60_000, autoTitleGraceMs: 0,
      now: () => now,
    });
    async function expectTitleModel(requestId: string, model: string) {
      fetchImpl.mockClear();
      const session = await bridge.createSession("/new-project");
      await bridge.startTurn({ ...input, sessionId: session.sessionId, text: "Fix keyboard focus for the <Button> component", requestId, idempotencyKey: requestId });
      await vi.waitFor(() => expect(bridge.session(session.sessionId)?.title).toBe("Fix <Button> focus"));
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST"), requestId).toEqual([
        [`${baseUrl}/v1/messages`, expect.objectContaining({
          headers: expect.objectContaining({ "x-api-key": source === "fixed" ? "desktop-key" : "host-key" }),
          body: expect.stringContaining(`"model":"${model}"`),
        })],
      ]);
    }
    try {
      await bridge.initialize();
      const offlineModel = source === "host-url" ? "claude-3-5-haiku-latest" : "desktop-profile-model";
      await expectTitleModel("auto", offlineModel);
      await bridge.saveMagpieConnection({ mode: "manual", baseUrl: "https://manual.example.test", authScheme: "x-api-key", apiKey: "manual-key" });
      await expectTitleModel("manual", offlineModel);

      if (source === "host-url") {
        desktopCatalogAvailable = true;
        await bridge.saveMagpieConnection({ mode: "auto" });
        await expectTitleModel("after-fetch", "host-only-model");

        desktopCatalogAvailable = false;
        now += 65_000;
        expect(await bridge.refreshRuntime()).toBe(true);
        expect(fetchImpl).toHaveBeenLastCalledWith(desktopModelsUrl, expect.anything());
        await expectTitleModel("after-failed-refresh", "host-only-model");

        await bridge.saveMagpieConnection({ mode: "manual", baseUrl: "https://manual.example.test", authScheme: "x-api-key", apiKey: "manual-key" });
        expect((await bridge.defaultConfiguration()).availableModels).toEqual([
          expect.objectContaining({ value: "manual-only-model" }),
        ]);
        await expectTitleModel("manual-after-fetch", "host-only-model");
      }
    } finally {
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never overwrites a title populated natively or via user rename while auto-title generation is in flight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-autotitle-race-"));
    const state = new ConversationStateStore({
      databasePath: join(directory, "state.sqlite"),
      sessionsPath: join(directory, "sessions.json"),
      queuePath: join(directory, "queue.json"),
      masterSecret: Buffer.alloc(32, 6).toString("base64url"),
    });
    await state.initialize();
    const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
    await eventLog.initialize();
    const native = new NativeDesktop();
    native.ignoreStartTitle = true;

    let releaseFetch!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { releaseFetch = resolve; }));
    await writeFile(join(directory, "settings.json"), JSON.stringify({
      env: { ANTHROPIC_API_KEY: "test-key" },
    }));

    const bridge = new ClaudeDesktopBridge({
      settingsPath: join(directory, "settings.json"),
      eventLog,
      conversationState: state,
      inspector: native,
      fetchImpl,
      environment: {},
      home: directory,
      scanCatalog: async () => ({ projects: [], sessions: [], observedAt: 0 }),
      refreshIntervalMs: 60_000,
      autoTitleGraceMs: 5,
    });
    await bridge.initialize();

    try {
      // Case 1: Native Desktop populates title while HTTP generation is in flight.
      const s1 = await bridge.createSession("/race-1");
      await bridge.startTurn({
        sessionId: s1.sessionId,
        text: "测试原生标题竞态保护",
        requestId: "r1",
        idempotencyKey: "k1",
        origin: "mobile",
      });
      await vi.waitFor(() => expect(releaseFetch).toBeTypeOf("function"));
      const target1 = native.sessions.find(item => item.sessionId === s1.sessionId)!;
      target1.title = "原生自动生成标题";
      releaseFetch(new Response(JSON.stringify({
        content: [{ type: "text", text: "<title>原生标题竞态保护</title>" }],
      }), { status: 200 }));
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(native.calls.some(call => call.method === "updateSession" && call.args[0] === s1.sessionId)).toBe(false);
      expect(bridge.session(s1.sessionId)?.title).toBe("原生自动生成标题");

      // Case 2: Image-only titles do not need a gateway request.
      const s2 = await bridge.createSession("/race-2");
      const changed = once(bridge, "changed");
      await bridge.startTurn({
        sessionId: s2.sessionId,
        text: "",
        attachments: [{ id: "img-1", name: "screen.png", mimeType: "image/png", size: 16, data: "AAAA" }],
        requestId: "r2",
        idempotencyKey: "k2",
        origin: "mobile",
      });
      await changed;
      expect(bridge.session(s2.sessionId)?.title).toBe("图片分析");
      expect(fetchImpl).toHaveBeenCalledOnce();

      // Case 3: Concurrent rename() while autoTitleSession's final getSession read is already in flight.
      const titleResponse = vi.fn(async () => Response.json({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "<title>并发手动重命名</title>" }],
      }));
      fetchImpl.mockImplementationOnce(titleResponse);
      const s3 = await bridge.createSession("/race-3");
      let getSessionCountForS3 = 0;
      let releaseFinalGetSession!: () => void;
      let finalGetSessionEntered!: () => void;
      const enteredFinalGetSession = new Promise<void>(resolve => { finalGetSessionEntered = resolve; });
      const holdFinalGetSession = new Promise<void>(resolve => { releaseFinalGetSession = resolve; });
      const originalCall = native.call.bind(native);
      native.call = async (method, args = []) => {
        if (method === "getSession" && args[0] === s3.sessionId) {
          getSessionCountForS3 += 1;
          // 1st getSession is pre-check; 2nd getSession is the final serialized re-check before updateSession!
          if (getSessionCountForS3 === 2) {
            const staleSnapshot = await originalCall(method, args);
            finalGetSessionEntered();
            await holdFinalGetSession;
            return staleSnapshot;
          }
        }
        return originalCall(method, args);
      };

      await bridge.startTurn({
        sessionId: s3.sessionId,
        text: "测试并发手动重命名不丢失",
        requestId: "r3",
        idempotencyKey: "k3",
        origin: "mobile",
      });
      await enteredFinalGetSession;
      const renamePromise = bridge.rename(s3.sessionId, "用户并发手动改名");
      releaseFinalGetSession();
      await renamePromise;
      await new Promise(resolve => setTimeout(resolve, 25));
      native.call = originalCall;

      expect(titleResponse).toHaveBeenCalledOnce();
      expect(native.calls.filter(call => call.method === "updateSession" && call.args[0] === s3.sessionId)).toEqual([
        { method: "updateSession", args: [s3.sessionId, { title: "用户并发手动改名" }] },
      ]);
      expect(bridge.session(s3.sessionId)?.title).toBe("用户并发手动改名");
    } finally {
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
