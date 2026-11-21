import { rm, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopBridge, DEFAULT_CONFIGURATION_SESSION_ID } from "./claude-desktop-bridge.js";
import { ConversationStateStore } from "../controller/conversation-state-store.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import { magpieModelIdHash } from "./claude-runtime-discovery.js";
import { MagpieConnectionRepository } from "./magpie-connection.js";
import { fixture, NativeDesktop, turnInput as input } from "./claude-desktop-bridge-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

describe("native session configuration", () => {
  it("uses only saved model IDs and labels in order, and round-trips the full selected ID", async () => {
    const f = await fixture();
    try {
      const options = Array.from({ length: 24 }, (_, index) => ({ model: index === 3 ? "native-model" : `model-${index}[1m]`, label: `Saved label ${index}`, description: `private-account-${index}` }));
      await writeFile(f.options.settingsPath, JSON.stringify({ env: { PRIVATE_ACCOUNT: "fixture-private-account-value" }, modelPicker: { options } }));
      await f.bridge.refreshRuntime();
      const config = await f.bridge.configuration("local-native");
      expect(config).toMatchObject({ model: "native-model", modelDisplayName: "Saved label 3", modelsComplete: true, availableModels: options.map(option => ({ value: option.model, displayName: option.label })) });
      expect(f.bridge.session("local-native")?.modelDisplayName).toBe("Saved label 3");
      const selected = await f.bridge.configureSession({ sessionId: "local-native", model: options[10]!.model });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", "model-10[1m]"]);
      expect(selected).toMatchObject({ model: "model-10[1m]", modelDisplayName: "Saved label 10" });
      const exposed = JSON.stringify({ config, selected, sessions: f.bridge.listSessions(), events: f.eventLog.replay(0) });
      expect(exposed).not.toContain("private-account");
      expect(exposed).not.toContain("fixture-private-account-value");
      expect(exposed).not.toContain("PRIVATE_ACCOUNT");
      expect(exposed).not.toContain("description");
      expect(f.native.availableCodeModels).toHaveBeenCalledExactlyOnceWith();
      expect(f.native.calls.some(call => call.method === "getAvailableCodeModels")).toBe(false);
    } finally { await f.close(); }
  });

  it.each([
    ["mythos-magpie-", ""],
    ["mythos-magpie-", "[1m]"],
    ["magpie-", ".anthropic.claude-opus-5-5[1m]"],
  ])("resolves the saved header label and picker selection for %s%s", async (prefix, suffix) => {
    const f = await fixture();
    try {
      const baseModel = "fixture-provider/model-alpha";
      const alias = `${prefix}${magpieModelIdHash(baseModel)}${suffix}`;
      const options = [
        { model: `${baseModel}[1m]`, label: "Saved long-context model" },
        { model: baseModel, label: "Saved standard model" },
      ];
      const selected = options[suffix.includes("[1m]") ? 0 : 1]!;
      f.native.sessions[0]!.model = alias;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options } }));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({ model: alias, modelDisplayName: selected.label });
      expect(await f.bridge.configuration("local-native")).toMatchObject({
        model: selected.model, modelDisplayName: selected.label,
        availableModels: options.map(option => ({ value: option.model, displayName: option.label })),
      });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.modelDisplayName).toBe(selected.label);
      await f.bridge.configureSession({ sessionId: "local-native", model: selected.model });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", selected.model]);
    } finally { await f.close(); }
  });

  it.each(["", "[1m]"])("maps a canonical model to the exact native directory alias for an empty session and first send (%s)", async suffix => {
    const f = await fixture();
    try {
      const base = "fixture-provider/model-alpha";
      const canonical = `${base}${suffix}`;
      const alias = `mythos-magpie-${magpieModelIdHash(base)}${suffix ? ".anthropic.claude-opus-5-5[1m]" : ""}`;
      f.native.unsupported.add("getAvailableCodeModels");
      f.native.codeModels = [`mythos-magpie-${magpieModelIdHash(base)}${suffix ? "" : "[1m]"}`, alias];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model: canonical, label: "Selected saved model" }] } }));
      const session = await f.bridge.createSession("/new-project");
      expect(session.model).toBe(canonical);
      expect(f.native.sessions.find(entry => entry.sessionId === session.sessionId)?.model).toBeUndefined();
      const configured = await f.bridge.configureSession({ sessionId: session.sessionId, model: canonical });
      expect(f.native.availableCodeModels).toHaveBeenCalledExactlyOnceWith();
      expect(f.native.calls.some(call => call.method === "getAvailableCodeModels")).toBe(false);
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual([session.sessionId, alias]);
      expect(configured).toMatchObject({ model: canonical, modelDisplayName: "Selected saved model" });
      await f.bridge.startTurn({ ...input, sessionId: session.sessionId });
      expect(f.native.sentModels).toEqual([alias]);
      expect(f.bridge.session(session.sessionId)).toMatchObject({ model: alias, modelDisplayName: "Selected saved model" });
    } finally { await f.close(); }
  });

  it("prefers the exact canonical ID when the native directory includes both representations", async () => {
    const f = await fixture();
    try {
      const model = "fixture-provider/model-alpha[1m]";
      f.native.codeModels = [`mythos-magpie-${magpieModelIdHash("fixture-provider/model-alpha")}[1m]`, model];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model, label: "Canonical" }] } }));
      expect(await f.bridge.configureSession({ sessionId: "local-native", model })).toMatchObject({ model });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", model]);
    } finally { await f.close(); }
  });

  it.each(["canonical", "synthetic"])("preserves the selected context suffix when the native bootstrap lists only the %s base ID", async kind => {
    const f = await fixture();
    try {
      const base = "fixture-provider/model-alpha";
      const model = `${base}[1m]`;
      const nativeBase = kind === "synthetic" ? `mythos-magpie-${magpieModelIdHash(base)}` : base;
      f.native.unsupported.add("getAvailableCodeModels");
      f.native.codeModels = [nativeBase];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model, label: "Long context" }] } }));
      const session = await f.bridge.createSession("/new-project");
      expect(await f.bridge.configureSession({ sessionId: session.sessionId, model })).toMatchObject({ model, modelDisplayName: "Long context" });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual([session.sessionId, `${nativeBase}[1m]`]);
      await f.bridge.startTurn({ ...input, sessionId: session.sessionId });
      expect(f.native.sentModels).toEqual([`${nativeBase}[1m]`]);
    } finally { await f.close(); }
  });

  it("keeps native empty-directory semantics and verifies direct canonical selection", async () => {
    const f = await fixture();
    try {
      f.native.codeModels = [];
      expect(await f.bridge.configureSession({ sessionId: "local-native", model: "fixture-provider/model-alpha" })).toMatchObject({ model: "fixture-provider/model-alpha" });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", "fixture-provider/model-alpha"]);
    } finally { await f.close(); }
  });

  it("reports Native preferred 1M normalization as the actual Gemini selection", async () => {
    const f = await fixture();
    try {
      const model = ["antigravity", "gemini-4-argon"].join("/");
      expect(magpieModelIdHash(model)).toBe("1052229916");
      const alias = `mythos-magpie-${magpieModelIdHash(model)}`;
      f.native.codeModels = [alias];
      // Installed Desktop's modelIdForCli can add [1m] before validation.
      f.native.normalizeModel = value => value === alias ? `${alias}[1m]` : value;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model, label: "Gemini 4 Argon · Antigravity" }] } }));
      const selected = await f.bridge.configureSession({ sessionId: "local-native", model });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", alias]);
      expect(selected).toMatchObject({ model: `${model}[1m]`, modelDisplayName: "Gemini 4 Argon · Antigravity · 1M" });
      expect(selected.availableModels).toContainEqual({ value: `${model}[1m]`, displayName: "Gemini 4 Argon · Antigravity · 1M" });
      expect(f.bridge.session("local-native")).toMatchObject({ model: `${alias}[1m]`, modelDisplayName: selected.modelDisplayName });
      expect((await f.bridge.configuration("local-native")).model).toBe(`${model}[1m]`);
    } finally { await f.close(); }
  });

  it.each(["canonical", "synthetic"])("keeps the only registered %s 1M target when the saved picker has a base model", async kind => {
    const f = await fixture();
    try {
      const model = "fixture-provider/model-alpha";
      const target = `${kind === "synthetic" ? `mythos-magpie-${magpieModelIdHash(model)}` : model}[1m]`;
      f.native.codeModels = [target];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model, label: "Selected model" }] } }));
      expect(await f.bridge.configureSession({ sessionId: "local-native", model })).toMatchObject({ model: `${model}[1m]`, modelDisplayName: "Selected model · 1M" });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", target]);
    } finally { await f.close(); }
  });

  it("does not accept a Native context downgrade or a different normalized model", async () => {
    const f = await fixture();
    try {
      const model = "fixture-provider/model-alpha";
      const alias = `mythos-magpie-${magpieModelIdHash(model)}`;
      const other = "fixture-provider/model-beta";
      f.native.codeModels = [alias, `${alias}[1m]`];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [
        { model, label: "Standard" }, { model: `${model}[1m]`, label: "Long context" }, { model: `${other}[1m]`, label: "Other model" },
      ] } }));
      f.native.normalizeModel = () => `${alias}[1m]`;
      await expect(f.bridge.configureSession({ sessionId: "local-native", model })).rejects.toThrow(/did not apply/iu);
      f.native.normalizeModel = () => alias;
      await expect(f.bridge.configureSession({ sessionId: "local-native", model: `${model}[1m]` })).rejects.toThrow(/did not apply/iu);
      f.native.normalizeModel = () => `mythos-magpie-${magpieModelIdHash(other)}[1m]`;
      await expect(f.bridge.configureSession({ sessionId: "local-native", model })).rejects.toThrow(/did not apply/iu);
    } finally { await f.close(); }
  });

  it("surfaces native model readback mismatch instead of claiming selection succeeded", async () => {
    const f = await fixture();
    try {
      f.native.codeModels = ["fixture-provider/model-alpha"];
      f.native.applyModel = false;
      await expect(f.bridge.configureSession({ sessionId: "local-native", model: "fixture-provider/model-alpha" })).rejects.toThrow(/model.*not applied|did not apply.*model/iu);
    } finally { await f.close(); }
  });

  it("does not invent a native alias when the directory has no matching model", async () => {
    const f = await fixture();
    try {
      f.native.codeModels = ["mythos-magpie-0000000000"];
      await expect(f.bridge.configureSession({ sessionId: "local-native", model: "fixture-provider/model-alpha" })).rejects.toThrow(/model/iu);
      expect(f.native.calls.some(call => call.method === "setModel")).toBe(false);
    } finally { await f.close(); }
  });

  it("prefers an explicitly saved alias label over a derived model label", async () => {
    const f = await fixture();
    try {
      const baseModel = "fixture-provider/model-alpha";
      const alias = `mythos-magpie-${magpieModelIdHash(baseModel)}`;
      f.native.sessions[0]!.model = alias;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [
        { model: baseModel, label: "Derived model label" },
        { model: alias, label: "Explicit alias label" },
      ] } }));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.modelDisplayName).toBe("Explicit alias label");
      expect(await f.bridge.configuration("local-native")).toMatchObject({ model: alias, modelDisplayName: "Explicit alias label" });
    } finally { await f.close(); }
  });

  it("does not label an unknown native alias as an unrelated saved model or expose raw synthetic hashes", async () => {
    const f = await fixture();
    try {
      const alias = "mythos-magpie-0000000000";
      f.native.sessions[0]!.model = alias;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [
        { model: "fixture-provider/model-alpha", label: "Unrelated model" },
      ] } }));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.modelDisplayName).toBeUndefined();
      const config = await f.bridge.configuration("local-native");
      expect(config.model).toBe(alias);
      expect(config.modelDisplayName).toBeUndefined();
    } finally { await f.close(); }
  });

  it("marks a missing model directory incomplete without treating history models as a catalog", async () => {
    const f = await fixture();
    try {
      f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other", model: "historical-model" });
      await f.bridge.refreshRuntime();
      expect(await f.bridge.configuration("local-native")).toMatchObject({ model: "native-model", modelsComplete: false, availableModels: [{ value: "native-model", displayName: "native-model" }] });
    } finally { await f.close(); }
  });

  it("resolves host defaultConfiguration() from the most recent active session or catalog defaults when zero sessions exist", async () => {
    const f = await fixture();
    try {
      // Zero sessions and no model catalog yet.
      f.native.sessions = [];
      await f.bridge.refreshRuntime();
      const emptyUncatalogued = await f.bridge.defaultConfiguration();
      expect(emptyUncatalogued).toEqual({
        sessionId: DEFAULT_CONFIGURATION_SESSION_ID,
        effort: "high",
        nativePermissionMode: "default",
        modelSource: "claude-desktop",
        effortSource: "claude-desktop",
        availableModels: [],
        availableEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        modelsComplete: false,
        appliesAfterTurn: false,
      });

      // Zero sessions with saved modelPicker catalog.
      const primaryModel = "fixture-provider/model-primary";
      const secondaryModel = "fixture-provider/model-secondary[1m]";
      await writeFile(f.options.settingsPath, JSON.stringify({
        modelPicker: {
          options: [
            { model: primaryModel, label: "Primary Saved Model" },
            { model: secondaryModel, label: "Secondary Long Context" },
          ],
        },
      }));
      const emptyCatalogued = await f.bridge.defaultConfiguration();
      expect(emptyCatalogued).toEqual({
        sessionId: DEFAULT_CONFIGURATION_SESSION_ID,
        model: primaryModel,
        modelDisplayName: "Primary Saved Model",
        effort: "high",
        nativePermissionMode: "default",
        modelSource: "claude-desktop",
        effortSource: "claude-desktop",
        availableModels: [
          { value: primaryModel, displayName: "Primary Saved Model" },
          { value: secondaryModel, displayName: "Secondary Long Context" },
        ],
        availableEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        modelsComplete: true,
        appliesAfterTurn: false,
      });

      // Active and archived sessions exist: picks most recent non-archived session and keeps appliesAfterTurn=false.
      const secondaryAlias = `mythos-magpie-${magpieModelIdHash("fixture-provider/model-secondary")}[1m]`;
      f.native.sessions = [
        { sessionId: "older-active", cwd: "/project", model: primaryModel, effort: "low", permissionMode: "default", lastActivityAt: 100, turnRunning: false },
        { sessionId: "recent-active", cwd: "/project", model: secondaryAlias, effort: "max", permissionMode: "acceptEdits", lastActivityAt: 500, turnRunning: true },
        { sessionId: "newest-archived", cwd: "/project", model: primaryModel, effort: "medium", permissionMode: "plan", lastActivityAt: 900, isArchived: true, turnRunning: false },
      ];
      await f.bridge.refreshRuntime();
      expect(await f.bridge.defaultConfiguration()).toEqual({
        sessionId: DEFAULT_CONFIGURATION_SESSION_ID,
        model: secondaryModel,
        modelDisplayName: "Secondary Long Context",
        effort: "max",
        nativePermissionMode: "acceptEdits",
        modelSource: "claude-desktop",
        effortSource: "claude-desktop",
        availableModels: [
          { value: primaryModel, displayName: "Primary Saved Model" },
          { value: secondaryModel, displayName: "Secondary Long Context" },
        ],
        availableEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        modelsComplete: true,
        appliesAfterTurn: false,
      });
    } finally { await f.close(); }
  });

  it("resolves real session models for retired Magpie synthetic hashes, [1m]-only picker entries, and unset/default native models", async () => {
    const f = await fixture();
    try {
      const autoOpus1m = "auto/claude-opus-5-5[1m]";
      const claudeOpus1m = "claude/claude-opus-5-5[1m]";
      const retiredGeminiAlias = `mythos-magpie-${magpieModelIdHash("antigravity/gemini-4-argon")}[1m]`;
      const retiredRouteAlias = "mythos-magpie-5277472942";
      const standardOpusAlias = `mythos-magpie-${magpieModelIdHash("auto/claude-opus-5-5")}`;

      await writeFile(f.options.settingsPath, JSON.stringify({
        model: claudeOpus1m,
        modelPicker: {
          options: [
            { model: autoOpus1m, label: "Claude Opus 5.5 · routing group · 1M" },
            { model: claudeOpus1m, label: "Claude Opus 5.5 · Claude" },
          ],
        },
      }));

      f.native.sessions = [
        { sessionId: "retired-gemini", cwd: "/project", model: retiredGeminiAlias, turnRunning: false, lastActivityAt: 400 },
        { sessionId: "retired-route-opus", cwd: "/project", model: retiredRouteAlias, turnRunning: false, lastActivityAt: 300 },
        { sessionId: "standard-opus", cwd: "/project", model: standardOpusAlias, turnRunning: false, lastActivityAt: 200 },
        { sessionId: "unset-with-turns", cwd: "/project", model: "default", turnRunning: false, lastActivityAt: 150 },
        { sessionId: "unset-empty", cwd: "/project", model: undefined, turnRunning: false, lastActivityAt: 100 },
      ];
      await f.bridge.refreshRuntime();

      // 1. Non-[1m] synthetic hash matches [1m]-only saved picker option and strips trailing " · 1M".
      expect(f.bridge.session("standard-opus")).toMatchObject({
        model: standardOpusAlias,
        modelDisplayName: "Claude Opus 5.5 · routing group",
      });
      expect(await f.bridge.configuration("standard-opus")).toMatchObject({
        model: "auto/claude-opus-5-5",
        modelDisplayName: "Claude Opus 5.5 · routing group",
      });

      // 2. Unset native.model with no turns falls back to settings.json default model instead of undefined / "默认模型".
      expect(f.bridge.session("unset-empty")).toMatchObject({
        model: claudeOpus1m,
        modelDisplayName: "Claude Opus 5.5 · Claude",
      });
      expect(await f.bridge.configuration("unset-empty")).toMatchObject({
        model: claudeOpus1m,
        modelDisplayName: "Claude Opus 5.5 · Claude",
      });

      // 3. Retired opaque synthetic hash [1m] hydrates actual upstream model from transcript tail on configuration().
      f.native.page = {
        messages: [{
          type: "assistant",
          uuid: "msg-gemini",
          message: { id: "msg-gemini", model: "antigravity/gemini-4-argon", usage: { input_tokens: 1_200, output_tokens: 80 } },
        }],
        hasMore: false,
      };
      const geminiConfig = await f.bridge.configuration("retired-gemini");
      expect(geminiConfig).toMatchObject({
        model: retiredGeminiAlias,
        modelDisplayName: "Gemini 4 Argon · 1M",
      });
      expect(f.bridge.session("retired-gemini")).toMatchObject({
        model: retiredGeminiAlias,
        modelDisplayName: "Gemini 4 Argon · 1M",
      });

      // 4. Retired opaque synthetic hash whose transcript model matches a saved Anthropic slug resolves saved label
      // even when the assistant message carries no token usage block.
      f.native.page = {
        messages: [
          { type: "assistant", uuid: "sidechain-ignored", isSidechain: true, message: { id: "side", model: "openai/gpt-5-4" } },
          { type: "assistant", uuid: "msg-opus", message: { id: "msg-opus", model: "claude/claude-opus-5-5" } },
        ],
        hasMore: false,
      };
      const opusConfig = await f.bridge.configuration("retired-route-opus");
      expect(opusConfig).toMatchObject({
        model: "claude/claude-opus-5-5",
        modelDisplayName: "Claude Opus 5.5 · Claude",
      });
      expect(f.bridge.session("retired-route-opus")).toMatchObject({
        model: retiredRouteAlias,
        modelDisplayName: "Claude Opus 5.5 · Claude",
      });

      // 5. Session with native.model === "default" migrates model-less live rawMaxTokens when tail hydration discovers the model.
      f.native.sessions.find(s => s.sessionId === "unset-with-turns")!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 98_000, rawMaxTokens: 196_000 };
      f.native.page = {
        messages: [{
          type: "assistant",
          uuid: "msg-sonnet",
          message: { id: "msg-sonnet", model: "claude-sonnet-4-5" },
        }],
        hasMore: false,
      };
      const hydratedDefaultConfig = await f.bridge.configuration("unset-with-turns");
      expect(hydratedDefaultConfig).toMatchObject({
        model: "claude-sonnet-4-5",
        modelDisplayName: "Claude Sonnet 4.5",
        context: { totalTokens: 98_000, maxTokens: 196_000, percentage: 50, estimated: false },
      });
      expect(f.bridge.session("unset-with-turns")).toMatchObject({
        model: "claude-sonnet-4-5",
        modelDisplayName: "Claude Sonnet 4.5",
      });

      // 6. configureSession rejects unapplied setModel both on unset/default sessions and on retired-hash sessions
      // whose transcript history already matches the requested saved model.
      f.native.codeModels = [claudeOpus1m, "claude/claude-opus-5-5"];
      f.native.applyModel = false;
      await expect(f.bridge.configureSession({ sessionId: "unset-empty", model: claudeOpus1m }))
        .rejects.toThrow(/did not apply/iu);
      await expect(f.bridge.configureSession({ sessionId: "retired-route-opus", model: "claude/claude-opus-5-5" }))
        .rejects.toThrow(/did not apply/iu);
    } finally { await f.close(); }
  });

  it("waits for the new Native session's catalog before applying a preselected output style", async () => {
    const f = await fixture();
    try {
      f.native.globalOutputStyles = { builtIns: ["Concise"], customs: ["Personal notes"] };
      expect((await f.bridge.defaultConfiguration()).availableOutputStyles).toEqual(["Concise", "Personal notes"]);
      const created = await f.bridge.createSession("/project");
      const pending = f.bridge.configureSession({ sessionId: created.sessionId, outputStyle: "Concise" });
      expect(f.native.calls.some(call => call.method === "applyFlagSettings")).toBe(false);
      const session = f.native.sessions.find(entry => entry.sessionId === created.sessionId)!;
      session.availableOutputStyles = ["default", "concise", "Project notes"];
      f.native.emit("event", { type: "session_updated", sessionId: created.sessionId, session: structuredClone(session) });
      await expect(pending).resolves.toMatchObject({ outputStyle: "concise", availableOutputStyles: session.availableOutputStyles });
      expect(f.native.calls.filter(call => call.method === "applyFlagSettings")).toEqual([
        { method: "applyFlagSettings", args: [created.sessionId, { outputStyle: "concise" }] },
      ]);
      expect(f.bridge.session(created.sessionId)).toMatchObject({ outputStyle: "concise", outputStyleCatalogReady: true });
      expect(f.bridge.session("local-native")?.outputStyle).toBeUndefined();
    } finally { await f.close(); }
  });

  it("uses Native readback for an active session's next-turn style and rejects an unavailable or unapplied style", async () => {
    const f = await fixture();
    try {
      const session = f.native.sessions[0]!;
      Object.assign(session, { turnRunning: true, availableOutputStyles: ["default", "Project notes"], outputStyle: "default" });
      await expect(f.bridge.configureSession({
        sessionId: "local-native", outputStyle: "Unknown", model: "other-model", effort: "high", permissionMode: "plan",
      })).rejects.toThrow("此会话不提供输出风格");
      expect(f.native.calls.filter(call => ["applyFlagSettings", "setModel", "setEffort", "setPermissionMode"].includes(call.method))).toEqual([]);
      await expect(f.bridge.configureSession({ sessionId: "local-native", outputStyle: "Project notes" })).resolves.toMatchObject({
        appliesAfterTurn: true, outputStyle: "Project notes",
      });
      f.native.applyOutputStyle = false;
      await expect(f.bridge.configureSession({ sessionId: "local-native", outputStyle: "default" })).rejects.toThrow("未应用输出风格");
      expect(f.native.calls.some(call => call.method === "interrupt" || call.method === "sendMessage")).toBe(false);
    } finally { await f.close(); }
  });

  it("merges effort declarations by gateway route across context variants", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-effort-catalog-"));
    const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite") });
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    await state.initialize();
    await eventLog.initialize();
    const settingsPath = join(root, "settings.json");
    const retired = `magpie-${magpieModelIdHash("group/retired")}.anthropic.claude-opus-5-5`;
    const bridge = new ClaudeDesktopBridge({
      settingsPath, eventLog, conversationState: state, inspector: new NativeDesktop(), home: root, environment: {},
      fetchImpl: async () => Response.json({ data: [
        { id: "group/runner", max_input_tokens: 200_000, reasoning_levels: ["ultra"] },
        { id: "claude/claude-opus-5-5", reasoning_levels: ["low", "ultra"] },
      ] }),
    });
    try {
      await writeFile(settingsPath, JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://catalog.example.test" },
        modelPicker: { options: [{ model: "group/runner[1m]", label: "Runner 1M" }, { model: retired, label: "Retired" }] },
      }));
      await bridge.initialize();
      const { availableModels } = await bridge.defaultConfiguration();
      const runner = availableModels.find(model => model.value === "group/runner[1m]");
      expect.soft(runner).toMatchObject({ displayName: "Runner 1M", supportsEffort: false, declaredEffortLevels: ["ultra"] });
      expect.soft(runner).not.toHaveProperty("maxInputTokens", 200_000);
      expect.soft(availableModels.find(model => model.value === retired)).not.toHaveProperty("declaredEffortLevels");
    } finally {
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("reads gateway and model settings once per refresh (Host credentials file: %s)", async (withHostCredentials) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-magpie-runtime-"));
    const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite") });
    await state.initialize();
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    await eventLog.initialize();
    const native = new NativeDesktop();
    const deepseekId = "remote-magpie/deepseek/deepseek-flash";
    const deepseekAlias = `mythos-magpie-${magpieModelIdHash(deepseekId)}`;
    const fableAlias = `magpie-${magpieModelIdHash("claude/claude-fable-5-2")}.anthropic.claude-fable-5-2[1m]`;
    native.sessions = [
      { sessionId: "win-session", cwd: "/project", title: "Win", isRunning: true, turnRunning: false, permissionMode: "default", model: deepseekAlias, pendingToolPermissions: [] },
      { sessionId: "mac-session", cwd: "/project", title: "Mac", isRunning: true, turnRunning: false, permissionMode: "default", model: fableAlias, pendingToolPermissions: [] },
    ];
    const localAppData = join(root, "AppData", "Local");
    const roamingAppData = join(root, "AppData", "Roaming");
    const configLib = join(localAppData, "Claude-3p", "configLibrary");
    const metaPath = join(configLib, "_meta.json");
    const activePath = join(configLib, "active.json");
    const settingsPath = join(root, "settings.json");
    const hostPath = join(localAppData, "Claude-3p", "host-creds-test.json");
    const reads = vi.mocked(readFile);
    const readCount = (target: string) => reads.mock.calls.filter(([path]) => path === target).length;
    await mkdir(configLib, { recursive: true });
    const hostBearer = "fixture-host-bearer";
    if (withHostCredentials) {
      await writeFile(hostPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: hostBearer } }), { mode: 0o600 });
    }
    await writeFile(metaPath, JSON.stringify({ appliedId: "active" }));
    await writeFile(activePath, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:3425",
      inferenceGatewayAuthScheme: "bearer",
      inferenceGatewayApiKey: "test-magpie-token",
      inferenceModels: [
        { name: "magpie-5782219464.anthropic.claude-fable-5-2", labelOverride: "Claude Fable 5.2 · Offline", prefer1m: true, supports1m: true },
      ],
    }), { mode: 0o600 });

    const magpieConnection = new MagpieConnectionRepository(join(root, "magpie-connection-v1.json"), {
      isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from(text, "utf8"),
      decryptString: buf => buf.toString("utf8"),
    });
    let currentTime = 1_000;
    let failGateway = true;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (failGateway) throw new Error("offline");
      if (String(url).includes("/magpie/quotas")) {
        return Response.json({ data: [{ provider: "deepseek", user: "synthetic", windows: [] }] });
      }
      return Response.json({
        data: [
          { id: deepseekId, display_name: "DeepSeek-V4.1-Flash", magpie_label: "DeepSeek-V4.1-Flash · DeepSeek · Remote magpie", max_input_tokens: 1_048_576 },
          { id: "claude/claude-fable-5-2", display_name: "Claude Fable 5.2", magpie_label: "Claude Fable 5.2 · Claude Code", max_input_tokens: 1_000_000, supports_1m: true },
        ],
      });
    }) as unknown as typeof fetch;

    const bridge = new ClaudeDesktopBridge({
      settingsPath,
      eventLog,
      conversationState: state,
      inspector: native,
      magpieConnection,
      platform: "win32",
      home: root,
      environment: { APPDATA: roamingAppData, LOCALAPPDATA: localAppData, ANTHROPIC_BASE_URL: "https://ambient.other.invalid" },
      fetchImpl,
      now: () => currentTime,
      gatewayModelsCacheMs: 60_000,
      refreshIntervalMs: 60_000,
    });
    try {
      reads.mockClear();
      await bridge.initialize();
      expect.soft([readCount(metaPath), readCount(activePath), readCount(settingsPath)], "initial offline refresh").toEqual([1, 1, 1]);
      expect.soft(readCount(hostPath), "offline Host credentials reads").toBe(Number(withHostCredentials));
      // Even when initial /v1/models fails, snapshot.magpie is populated and offline configLibrary inferenceModels + humanized slug avoid raw IDs.
      expect(bridge.magpieSettings()).toEqual({
        magpie: { mode: "auto", baseUrl: "http://127.0.0.1:3425", authScheme: "bearer", keyConfigured: true },
      });
      expect(bridge.session("mac-session")?.modelDisplayName).toBe("Claude Fable 5.2 · Offline");
      expect(bridge.session("win-session")?.modelDisplayName).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      if (withHostCredentials) {
        expect(fetchImpl).toHaveBeenLastCalledWith("http://127.0.0.1:3425/v1/models?limit=1000", expect.objectContaining({
          headers: expect.objectContaining({ authorization: `Bearer ${hostBearer}` }),
        }));
      }

      // Background refresh within negative cache TTL does not hammer /v1/models.
      currentTime += 2_000;
      reads.mockClear();
      expect(await bridge.refreshRuntime()).toBe(true);
      expect.soft([readCount(metaPath), readCount(activePath), readCount(settingsPath)], "cached refresh").toEqual([1, 1, 1]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Explicit configuration() retries a failed initial fetch immediately and loads full Windows Magpie catalog.
      failGateway = false;
      const winConfig = await bridge.configuration("win-session");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(winConfig.modelsComplete).toBe(true);
      expect(winConfig.model).toBe(deepseekId);
      expect(winConfig.modelDisplayName).toBe("DeepSeek-V4.1-Flash");
      expect(bridge.session("win-session")?.modelDisplayName).toBe("DeepSeek-V4.1-Flash");

      // Subsequent configuration() and refreshRuntime() within 60s reuse the cached catalog without extra HTTP calls.
      currentTime += 5_000;
      await bridge.refreshRuntime();
      await bridge.configuration("mac-session");
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // If a later post-TTL background refresh fails, stale models are retained with ok=false so explicit configuration() retries immediately.
      currentTime += 65_000;
      failGateway = true;
      await bridge.refreshRuntime();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(bridge.session("win-session")?.modelDisplayName).toBe("DeepSeek-V4.1-Flash");
      currentTime += 1_000;
      await bridge.refreshRuntime();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      failGateway = false;
      await bridge.configuration("win-session");
      expect(fetchImpl).toHaveBeenCalledTimes(4);

      // Unsaved testMagpieConnection({ mode: "auto" }) uses full configLibrary gateway discovery even while saved mode is manual.
      reads.mockClear();
      await bridge.saveMagpieConnection({ mode: "manual", baseUrl: "https://manual.example.test", authScheme: "bearer", apiKey: "manual-key" });
      expect(fetchImpl).toHaveBeenCalledTimes(5);
      expect(fetchImpl).toHaveBeenLastCalledWith("https://manual.example.test/v1/models?limit=1000", expect.anything());
      expect.soft([readCount(metaPath), readCount(activePath), readCount(settingsPath)], "manual refresh").toEqual([0, 0, 1]);
      await expect(bridge.testMagpieConnection({ mode: "auto" })).resolves.toEqual({
        models: { state: "ready", count: 4 },
        quota: { state: "available" },
      });
      await bridge.saveMagpieConnection({ mode: "auto" });

      // When settings.json saves unprefixed claude-fable-5-2[1m], slug fallback matches both session display and configureSession.
      await writeFile(join(root, "settings.json"), JSON.stringify({
        modelPicker: { options: [{ model: "claude-fable-5-2[1m]", label: "Claude Fable 5.2 · Claude Code" }] },
      }));
      await bridge.refreshRuntime();
      expect(bridge.session("mac-session")?.modelDisplayName).toBe("Claude Fable 5.2 · Claude Code");
      native.codeModels = ["magpie-5782219464.anthropic.claude-fable-5-2"];
      const updated = await bridge.configureSession({ sessionId: "mac-session", model: "claude-fable-5-2[1m]" });
      expect(native.calls.find(call => call.method === "setModel")?.args).toEqual([
        "mac-session",
        "magpie-5782219464.anthropic.claude-fable-5-2[1m]",
      ]);
      expect(updated.modelDisplayName).toBe("Claude Fable 5.2 · Claude Code");

      // Removing the active gateway makes the next refresh use the same settings file for models and gateway credentials.
      await writeFile(activePath, "{}");
      await writeFile(settingsPath, JSON.stringify({
        model: "saved-default",
        modelPicker: { options: [{ model: "saved-first", label: "Saved first" }, { model: "saved-default", label: "Saved default" }] },
        env: { ANTHROPIC_BASE_URL: "https://settings.example.test", ANTHROPIC_API_KEY: "settings-key", CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_API_KEY" },
      }));
      native.sessions[0]!.model = "default";
      reads.mockClear();
      expect(await bridge.refreshRuntime()).toBe(true);
      expect(fetchImpl).toHaveBeenLastCalledWith("https://settings.example.test/v1/models?limit=1000", expect.anything());
      expect(bridge.magpieSettings()).toEqual({
        magpie: { mode: "auto", baseUrl: "https://settings.example.test", authScheme: "x-api-key", keyConfigured: true },
      });
      expect(bridge.session("win-session")).toMatchObject({ model: "saved-default", modelDisplayName: "Saved default" });
      expect.soft([readCount(metaPath), readCount(activePath), readCount(settingsPath)], "settings gateway refresh").toEqual([1, 1, 1]);
      expect.soft(readCount(hostPath), "settings fallback Host credentials reads").toBe(Number(withHostCredentials));

      await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://disconnected.example.test" } }));
      native.ready = false;
      vi.spyOn(native, "connect").mockRejectedValueOnce(new Error("inspector offline"));
      vi.mocked(fetchImpl).mockClear();
      expect(await bridge.refreshRuntime()).toBe(false);
      expect(bridge.magpieSettings().magpie?.baseUrl).toBe("https://disconnected.example.test");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      reads.mockClear();
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the saved Magpie gateway when a paused inspector refresh resumes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-magpie-save-"));
    const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite") });
    await state.initialize();
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    await eventLog.initialize();
    const native = new NativeDesktop();
    const magpieConnection = new MagpieConnectionRepository(join(root, "magpie-connection-v1.json"), {
      isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from(text, "utf8"),
      decryptString: buf => buf.toString("utf8"),
    });
    const fetchImpl = vi.fn<typeof fetch>(async url => Response.json({
      data: [{ id: "native-model", display_name: new URL(String(url)).hostname }],
    }));
    const bridge = new ClaudeDesktopBridge({
      settingsPath: join(root, "settings.json"), eventLog, conversationState: state, inspector: native,
      magpieConnection, environment: {}, home: root, fetchImpl, refreshIntervalMs: 60_000,
    });
    const saveGateway = (baseUrl: string) => bridge.saveMagpieConnection({ mode: "manual", baseUrl, authScheme: "bearer", apiKey: "fixture-gateway-key" });
    try {
      await bridge.initialize();
      await saveGateway("https://old.example.test");
      expect(bridge.session("local-native")?.modelDisplayName).toBe("old.example.test");
      fetchImpl.mockClear();

      let resumeGetAll!: () => void;
      const holdGetAll = new Promise<void>(resolve => { resumeGetAll = resolve; });
      let enterGetAll!: () => void;
      const getAllEntered = new Promise<void>(resolve => { enterGetAll = resolve; });
      vi.spyOn(native, "call").mockImplementationOnce(async () => {
        enterGetAll();
        await holdGetAll;
        return structuredClone(native.sessions);
      });
      const refresh = bridge.refreshRuntime();
      try {
        await getAllEntered;
        await saveGateway("https://new.example.test");
      } finally {
        resumeGetAll();
        expect(await refresh).toBe(true);
      }
      expect.soft(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["https://new.example.test/v1/models?limit=1000"]);
      expect(bridge.session("local-native")?.modelDisplayName).toBe("new.example.test");
    } finally {
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
