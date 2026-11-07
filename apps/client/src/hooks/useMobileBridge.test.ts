import type { BridgeEvent, BridgeHostSnapshot, BridgeResponse, PairingBundle } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEventsToSnapshot,
  applySessionToSnapshot,
  applyEventToTurns,
  applyEventToSnapshot,
  applyPermissionEvent,
  confirmedPairingSnapshot,
  mergeBridgeEvents,
  rebaseSnapshot,
  relayLinkAllowsSend,
  type LocalTurn,
} from "./useMobileBridge.js";

describe("relayLinkAllowsSend", () => {
  const home = "wss://relay.example/ws";
  const foreign = "wss://relay-legacy.example/ws";

  it("allows anything until the desktop's home relay is learned", () => {
    expect(relayLinkAllowsSend({
      currentRelayUrl: foreign,
      desktopHere: false,
      directPeer: false,
    })).toBe(true);
  });

  it("allows the home relay even with the desktop offline (queue-on-behalf)", () => {
    expect(relayLinkAllowsSend({
      homeRelayUrl: home,
      currentRelayUrl: home,
      desktopHere: false,
      directPeer: false,
    })).toBe(true);
  });

  it("blocks a foreign relay the desktop is not on (proxy drift)", () => {
    expect(relayLinkAllowsSend({
      homeRelayUrl: home,
      currentRelayUrl: foreign,
      desktopHere: false,
      directPeer: false,
    })).toBe(false);
  });

  it("allows a foreign relay while the desktop is present on it (failover)", () => {
    expect(relayLinkAllowsSend({
      homeRelayUrl: home,
      currentRelayUrl: foreign,
      desktopHere: true,
      directPeer: false,
    })).toBe(true);
  });

  it("always allows an open direct WebRTC peer", () => {
    expect(relayLinkAllowsSend({
      homeRelayUrl: home,
      currentRelayUrl: foreign,
      desktopHere: false,
      directPeer: true,
    })).toBe(true);
  });
});

describe("confirmedPairingSnapshot", () => {
  const pairing = { hostId: "desktop-1", pairingEpoch: 4 } as PairingBundle;
  const snapshot = {
    host: { hostId: "desktop-1", pairingEpoch: 4 },
  } as BridgeHostSnapshot;

  it("accepts only an encrypted response for the QR host and pairing epoch", () => {
    const response = {
      kind: "response",
      requestId: "pairing-proof",
      ok: true,
      result: { snapshot },
    } as BridgeResponse;
    expect(confirmedPairingSnapshot(pairing, response)).toBe(snapshot);
  });

  it("rejects a Relay response that does not prove the QR host identity", () => {
    const response = {
      kind: "response",
      requestId: "pairing-proof",
      ok: true,
      result: { snapshot: { ...snapshot, host: { ...snapshot.host, hostId: "other-desktop" } } },
    } as BridgeResponse;
    expect(() => confirmedPairingSnapshot(pairing, response)).toThrow("身份与二维码不一致");
  });
});

function event(seq: number, eventId = `event-${seq}`): BridgeEvent {
  return {
    eventId,
    seq,
    timestamp: seq,
    origin: "claude-host",
    type: "assistant.delta",
    data: { text: String(seq) },
  };
}

describe("local receipt replay boundaries", () => {
  it.each(([
    ["turn.completed", "completed"], ["turn.failed", "failed"], ["turn.interrupted", "cancelled"],
  ] as const).flatMap(([terminal, delivery]) => (
    ["turn.queued", "message.delivery", "user.message.accepted", "turn.started"] as const
  ).map(stale => ({ terminal, delivery, stale }))))("keeps $delivery after an older $stale arrives", ({ terminal, delivery, stale }) => {
    const turn: LocalTurn = { requestId: "request", idempotencyKey: "key", commandId: "command", sessionId: "session", text: "Continue", attachments: [], createdAt: 1, delivery: "running" };
    const finished = applyEventToTurns([turn], {
      eventId: "terminal", seq: 20, timestamp: 20, origin: "claude-host", type: terminal,
      sessionId: "session", turnId: "turn", data: { requestId: "request", commandId: "command" },
    });
    const replayed = applyEventToTurns(finished, {
      eventId: "stale", seq: 10, timestamp: 10, origin: "claude-host", type: stale,
      sessionId: "session", turnId: "turn", data: { requestId: "request", commandId: "command", delivery: "submitted" },
    });
    expect(replayed[0]?.delivery).toBe(delivery);
    expect(replayed[0]).toBe(finished[0]);
    // A newer explicit retry is allowed to leave a terminal state.
    expect(applyEventToTurns(finished, {
      eventId: "retry", seq: 21, timestamp: 21, origin: "claude-host", type: "turn.queued",
      sessionId: "session", data: { requestId: "request", commandId: "command" },
    })[0]?.delivery).toBe("host-received");
  });
});

describe("mergeBridgeEvents", () => {
  it("deduplicates replayed events and restores sequence order", () => {
    expect(mergeBridgeEvents([event(2), event(1)], [event(2), event(3)]).map((item) => item.seq))
      .toEqual([1, 2, 3]);
  });

  it("applies a terminal event only to its matching queued turn", () => {
    const turns: LocalTurn[] = ["one", "two"].map((id) => ({
      requestId: `request-${id}`,
      idempotencyKey: `key-${id}`,
      sessionId: "session-1",
      text: id,
      attachments: [],
      createdAt: 1,
      delivery: "host-received",
      commandId: `command-${id}`,
    }));
    const completed: BridgeEvent = {
      eventId: "completed-one",
      seq: 4,
      timestamp: 4,
      origin: "claude-host",
      type: "turn.completed",
      sessionId: "session-1",
      data: {
        requestId: "request-one",
        commandId: "command-one",
        delivery: "completed",
      },
    };
    expect(applyEventToTurns(turns, completed).map((turn) => turn.delivery))
      .toEqual(["completed", "host-received"]);
  });

  it.each([
    "turn.queued",
    "user.message.accepted",
    "message.delivery",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.interrupted",
  ] as const)("does not apply an uncorrelated %s to unsent, queued, or finished local turns", (type) => {
    const turns: LocalTurn[] = ([
      "local-saved", "relay-received", "host-received", "completed", "failed", "cancelled", "uncertain",
    ] as const).map((delivery) => ({
      requestId: `request-${delivery}`,
      idempotencyKey: `key-${delivery}`,
      sessionId: "session-1",
      text: delivery,
      attachments: [],
      createdAt: 1,
      delivery,
    }));
    const desktopEvent: BridgeEvent = {
      eventId: `desktop-${type}`,
      seq: 2,
      timestamp: 2,
      origin: "codex-host",
      type,
      sessionId: "session-1",
      turnId: "desktop-turn",
      data: { delivery: "running", error: "Desktop turn failed" },
    };

    const updated = applyEventToTurns(turns, desktopEvent);
    expect(updated).toEqual(turns);
    updated.forEach((turn, index) => expect(turn).toBe(turns[index]));
  });

  it.each(["turn.queued", "user.message.accepted", "message.delivery", "turn.started"] as const)(
    "does not advance an accepted local turn from an uncorrelated %s", (type) => {
      const turn: LocalTurn = {
        requestId: "request-1", idempotencyKey: "key-1", sessionId: "session-1",
        text: "Accepted task", attachments: [], createdAt: 1, delivery: "session-received",
      };
      expect(applyEventToTurns([turn], {
        eventId: type, seq: 2, timestamp: 2, origin: "codex-host", type,
        sessionId: "session-1", data: { delivery: "running" },
      })).toEqual([turn]);
    },
  );

  it("preserves submitted delivery until actual turn acknowledgment", () => {
    const turn: LocalTurn = {
      requestId: "request-1", idempotencyKey: "key-1", sessionId: "session-1", text: "Task", attachments: [], createdAt: 1, delivery: "host-received",
    };
    const submitted: BridgeEvent = {
      eventId: "submitted", seq: 1, timestamp: 1, origin: "claude-host", type: "message.delivery", sessionId: "session-1",
      data: { requestId: "request-1", commandId: "command-1", delivery: "submitted" },
    };
    const turns = applyEventToTurns([turn], submitted);
    expect(turns[0]).toMatchObject({ delivery: "submitted", commandId: "command-1" });
    expect(applyEventToTurns(turns, { ...submitted, eventId: "started", seq: 2, type: "turn.started", data: { commandId: "command-1" } })[0]?.delivery).toBe("running");
    expect(applyEventToTurns(turns, { ...submitted, eventId: "failed", seq: 2, type: "turn.failed", data: { commandId: "command-1", error: "Rejected" } })[0]?.delivery).toBe("failed");
  });

  it("tracks waiting confirmation and expiry recovery without failing or duplicating the original input", () => {
    const turn: LocalTurn = { requestId: "request-1", idempotencyKey: "key-1", sessionId: "session-1", text: "Task", attachments: [], createdAt: 1, delivery: "submitted", commandId: "command-1", messageId: "message-1" };
    const held: BridgeEvent = { eventId: "held", seq: 2, timestamp: 2, origin: "system", type: "message.delivery", sessionId: "session-1", data: { requestId: "request-1", commandId: "command-1", messageId: "message-1", delivery: "waiting-confirmation" } };
    const waiting = applyEventToTurns([turn], held);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ delivery: "waiting-confirmation", text: "Task", commandId: "command-1" });
    const recovered = applyEventToTurns(waiting, { ...held, eventId: "expired", seq: 3, data: { ...held.data, delivery: "host-received" } });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ delivery: "host-received", text: "Task", commandId: "command-1" });
  });

  it("retains accepted command and turn correlation for subsequent native lifecycle events", () => {
    const turn: LocalTurn = {
      requestId: "request-1",
      idempotencyKey: "key-1",
      sessionId: "session-1",
      text: "Native task",
      attachments: [],
      createdAt: 1,
      delivery: "host-received",
    };
    const accepted: BridgeEvent = {
      eventId: "accepted-1",
      seq: 2,
      timestamp: 2,
      origin: "codex-host",
      type: "user.message.accepted",
      sessionId: "session-1",
      turnId: "native-turn-1",
      data: { requestId: "request-1", commandId: "command-1" },
    };
    const received = applyEventToTurns([turn], accepted);
    expect(received[0]).toMatchObject({
      delivery: "session-received", commandId: "command-1", turnId: "native-turn-1",
    });
    const running = applyEventToTurns(received, {
      ...accepted,
      eventId: "started-1",
      seq: 3,
      type: "turn.started",
      data: { commandId: "command-1" },
    });
    expect(running[0]?.delivery).toBe("running");
    expect(applyEventToTurns(running, {
      ...accepted,
      eventId: "completed-1",
      seq: 4,
      type: "turn.completed",
      data: {},
    })[0]?.delivery).toBe("completed");
  });

  it.each([
    ["turn.completed", "completed"],
    ["turn.failed", "failed"],
    ["turn.interrupted", "cancelled"],
  ] as const)("applies an uncorrelated %s only to accepted turns in the same native turn", (type, delivery) => {
    const turns = (["session-received", "running"] as const).flatMap((state) => [
      {
        requestId: `request-${state}`,
        idempotencyKey: `key-${state}`,
        sessionId: "session-1",
        text: "Native task",
        attachments: [],
        createdAt: 1,
        delivery: state,
        commandId: `command-${state}`,
        turnId: "native-turn-1",
      },
      {
        requestId: `other-${state}`,
        idempotencyKey: `other-key-${state}`,
        sessionId: "session-1",
        text: "Another native turn",
        attachments: [],
        createdAt: 1,
        delivery: state,
        commandId: `other-command-${state}`,
        turnId: "native-turn-2",
      },
    ]);
    const terminal: BridgeEvent = {
      eventId: `native-${type}`,
      seq: 5,
      timestamp: 5,
      origin: "codex-host",
      type,
      sessionId: "session-1",
      turnId: "native-turn-1",
      data: { error: "Native failure" },
    };
    const updated = applyEventToTurns(turns, terminal);
    expect(updated.map((turn) => turn.delivery)).toEqual([delivery, "session-received", delivery, "running"]);
    expect(applyEventToTurns(turns, { ...terminal, sessionId: "other-session" })).toEqual(turns);
    // Runtime interrupt acknowledgements may omit turnId as well as command/request IDs.
    const { turnId: _turnId, ...withoutTurnId } = terminal;
    expect(applyEventToTurns([turns[0]!], withoutTurnId)[0]?.delivery).toBe(delivery);
    const { turnId: _storedTurnId, ...legacyTurn } = turns[0]!;
    expect(applyEventToTurns([legacyTurn], terminal)[0]?.delivery).toBe(delivery);
  });

  it("restores one completion when reconnect replay contains a duplicate event", () => {
    const turn: LocalTurn = {
      requestId: "request-1",
      idempotencyKey: "key-1",
      sessionId: "session-1",
      text: "Long task",
      attachments: [],
      createdAt: 1,
      delivery: "running",
      commandId: "command-1",
    };
    const completed: BridgeEvent = {
      eventId: "completed-1",
      seq: 10,
      timestamp: 10,
      origin: "claude-host",
      type: "turn.completed",
      sessionId: "session-1",
      data: { requestId: "request-1", commandId: "command-1" },
    };
    const replayed = mergeBridgeEvents([completed], [completed]);

    expect(replayed).toHaveLength(1);
    const restored = replayed.reduce<LocalTurn[]>(
      (current, replayedEvent) => applyEventToTurns(current, replayedEvent),
      [turn],
    );
    expect(restored).toEqual([
      expect.objectContaining({ delivery: "completed", sessionId: "session-1" }),
    ]);
  });

  it("upserts permission requests from events and removes them when resolved", () => {
    const requested: BridgeEvent = {
      eventId: "permission-requested",
      seq: 5,
      timestamp: 100,
      origin: "claude-host",
      type: "permission.requested",
      sessionId: "session-1",
      itemId: "permission-1",
      data: {
        requestId: "permission-1",
        toolUseId: "tool-1",
        toolName: "Write",
        input: { file_path: "/tmp/demo.ts", content: "hello" },
        canAllowAlways: true,
        createdAt: 100,
      },
    };
    const replayed = { ...requested, eventId: "permission-replayed", seq: 6 };
    const pending = applyPermissionEvent(applyPermissionEvent([], requested), replayed);
    expect(pending).toEqual([
      expect.objectContaining({
        requestId: "permission-1",
        sessionId: "session-1",
        toolName: "Write",
        canAllowAlways: true,
      }),
    ]);

    const resolved: BridgeEvent = {
      eventId: "permission-resolved",
      seq: 7,
      timestamp: 120,
      origin: "system",
      type: "permission.resolved",
      sessionId: "session-1",
      itemId: "permission-1",
      data: {
        requestId: "permission-1",
        decision: "allow-once",
        resolvedByDeviceId: "phone-1",
        resolvedByName: "Android 手机",
        resolvedAt: 120,
      },
    };
    expect(applyPermissionEvent(pending, resolved)).toEqual([]);
  });

  it("moves the shared session between running, waiting, and idle from events", () => {
    const snapshot: BridgeHostSnapshot = {
      host: {
        hostId: "desktop-1",
        pairingEpoch: 1,
        name: "Test Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        lastSeenAt: 1,
        version: "0.2.3",
        capabilities: [],
      },
      projects: [],
      sessions: [{
        sessionId: "session-1",
        projectId: "project-1",
        projectName: "project",
        cwd: "/tmp/project",
        title: "Session",
        source: "bridge",
        transport: "bridge-host",
        ownership: "BRIDGE_IDLE",
        turnState: "queued",
        executionStage: "submitted",
        lastActivityAt: 1,
        pendingCount: 1,
      }],
      devices: [],
      runtime: {
        state: "working",
        detail: "Working",
        activeTurns: 1,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "未启用",
          enabled: false,
          canRestart: true,
        },
      },
      permissions: [],
      latestSeq: 1,
    };
    const started: BridgeEvent = {
      eventId: "started",
      seq: 2,
      timestamp: 2,
      origin: "claude-host",
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1",
      data: {},
    };
    const running = applyEventToSnapshot(snapshot, started, []);
    expect(running?.sessions[0]).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
      executionStage: "running",
      pendingCount: 0,
      activeTurnId: "turn-1",
    });

    const requested: BridgeEvent = {
      eventId: "requested",
      seq: 3,
      timestamp: 3,
      origin: "claude-host",
      type: "permission.requested",
      sessionId: "session-1",
      data: {
        requestId: "permission-1",
        toolUseId: "tool-1",
        toolName: "Write",
        input: { file_path: "/tmp/project/demo.ts" },
      },
    };
    const permissions = applyPermissionEvent([], requested);
    expect(applyEventToSnapshot(running, requested, permissions)?.sessions[0]?.turnState).toBe("waiting");

    const completed: BridgeEvent = {
      eventId: "completed",
      seq: 4,
      timestamp: 4,
      origin: "claude-host",
      type: "turn.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      data: {},
    };
    expect(applyEventToSnapshot(running, completed, [])?.sessions[0]).toMatchObject({
      ownership: "BRIDGE_IDLE",
      turnState: "idle",
    });
    expect(applyEventToSnapshot(running, completed, [])?.sessions[0]?.executionStage).toBeUndefined();
  });

  it.each([
    ["turn.completed", "bridge-host", "permission"],
    ["turn.failed", "bridge-host", "permission"],
    ["turn.interrupted", "bridge-host", "permission"],
    ["turn.completed", "claude-desktop-managed", "question"],
    ["turn.failed", "claude-desktop-managed", "question"],
    ["turn.interrupted", "claude-desktop-managed", "question"],
  ] as const)("keeps %s terminal on %s after a pending %s resolves", (type, transport, kind) => {
    const snapshot = {
      sessions: [{
        sessionId: "session-1",
        transport,
        ownership: transport === "bridge-host" ? "BRIDGE_RUNNING" : "DESKTOP_MANAGED_RUNNING",
        turnState: "running",
        activeTurnId: "turn-1",
        currentSummary: "Still working",
        pendingCount: 1,
      }],
      permissions: [],
      latestSeq: 1,
    } as unknown as BridgeHostSnapshot;
    const requested: BridgeEvent = {
      eventId: "requested",
      seq: 2,
      timestamp: 2,
      origin: "claude-host",
      type: kind === "permission" ? "permission.requested" : "question.requested",
      sessionId: "session-1",
      data: { requestId: "permission-1", toolUseId: "tool-1", toolName: "Write", input: {} },
    };
    const terminal: BridgeEvent = {
      ...requested,
      eventId: "terminal",
      seq: 3,
      timestamp: 3,
      type,
      turnId: "turn-1",
      data: {},
    };
    const resolved: BridgeEvent = {
      ...requested,
      eventId: "resolved",
      seq: 4,
      timestamp: 4,
      type: kind === "permission" ? "permission.resolved" : "question.resolved",
      data: { requestId: "permission-1" },
    };
    const permissions = applyPermissionEvent([], requested);
    const waiting = applyEventToSnapshot(snapshot, requested, permissions);
    const ended = applyEventToSnapshot(waiting, terminal, permissions);
    const finished = applyEventToSnapshot(ended, resolved, applyPermissionEvent(permissions, resolved));
    const batch = applyEventsToSnapshot(snapshot, [requested, terminal, resolved], []);
    expect([
      finished?.sessions[0]?.turnState,
      batch.snapshot?.sessions[0]?.turnState,
    ]).toEqual(["queued", "queued"]);
    expect(ended?.sessions[0]).toMatchObject({
      ownership: transport === "bridge-host" ? "BRIDGE_IDLE" : "DESKTOP_MANAGED_IDLE",
      turnState: "waiting",
      pendingCount: 1,
    });
    expect(ended?.sessions[0]).not.toHaveProperty("activeTurnId");
    expect(ended?.sessions[0]).not.toHaveProperty("currentSummary");
    expect(batch.snapshot?.sessions).toEqual(finished?.sessions);
    expect(batch.permissions).toEqual([]);
    const idle = applyEventsToSnapshot({
      ...snapshot, sessions: [{ ...snapshot.sessions[0]!, pendingCount: 0 }],
    }, [requested, terminal, resolved], []);
    expect(idle.snapshot?.sessions[0]?.turnState).toBe("idle");
  });

  it("applies native runtime session updates as soon as they arrive", () => {
    const snapshot: BridgeHostSnapshot = {
      host: {
        hostId: "desktop-1",
        pairingEpoch: 1,
        name: "Test Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        lastSeenAt: 1,
        version: "0.8.0",
        capabilities: [],
      },
      projects: [],
      sessions: [{
        sessionId: "codex-desktop:native-1",
        runtimeId: "codex-desktop",
        nativeSessionId: "native-1",
        projectId: "codex-desktop:/tmp/project",
        projectName: "project",
        cwd: "/tmp/project",
        title: "Before",
        source: "desktop",
        transport: "codex-app-server",
        ownership: "BRIDGE_IDLE",
        turnState: "idle",
        lastActivityAt: 1,
        pendingCount: 0,
      }],
      devices: [],
      runtime: {
        state: "ready",
        detail: "Idle",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "未启用",
          enabled: false,
          canRestart: true,
        },
      },
      permissions: [],
      latestSeq: 1,
    };
    const update: BridgeEvent = {
      eventId: "native-runtime-update",
      seq: 2,
      timestamp: 2,
      origin: "codex-host",
      type: "runtime.updated",
      sessionId: "codex-desktop:native-1",
      data: {
        runtimeId: "codex-desktop",
        session: {
          ...snapshot.sessions[0],
          title: "Updated in Codex Desktop",
          turnState: "running",
          ownership: "BRIDGE_RUNNING",
          activeTurnId: "turn-live",
          lastActivityAt: 2,
        },
      },
    };

    expect(applyEventToSnapshot(snapshot, update, [])?.sessions[0]).toMatchObject({
      title: "Updated in Codex Desktop",
      turnState: "running",
      activeTurnId: "turn-live",
    });
  });

  it("replaces stale model metadata with the session returned on open and applies session.configuration events", () => {
    const stale = { sessionId: "session-1", model: "old", modelDisplayName: "Old model", effort: "low" } as BridgeHostSnapshot["sessions"][number];
    const other = { ...stale, sessionId: "session-2" };
    const snapshot = { sessions: [stale, other], permissions: [] } as unknown as BridgeHostSnapshot;
    const fresh = { ...stale, model: "desktop-current", modelDisplayName: "Desktop current", effort: "xhigh" as const };
    expect(applySessionToSnapshot(snapshot, fresh)?.sessions).toEqual([fresh, other]);
    expect(applySessionToSnapshot(snapshot, undefined)).toBe(snapshot);
    expect(applySessionToSnapshot(undefined, fresh)).toBeUndefined();

    const configuredEvent: BridgeEvent = {
      eventId: "cfg-1",
      seq: 3,
      timestamp: 3,
      origin: "system",
      type: "session.configuration",
      sessionId: "session-1",
      data: {
        model: "mobile-selected",
        modelDisplayName: "Mobile Selected",
        effort: "medium",
        appliesAfterTurn: false,
      },
    };
    expect(applyEventToSnapshot(snapshot, configuredEvent, [])?.sessions[0]).toMatchObject({
      sessionId: "session-1",
      model: "mobile-selected",
      modelDisplayName: "Mobile Selected",
      effort: "medium",
    });
  });

  it.each([
    { appliesAfterTurn: false },
    { model: "new-model", appliesAfterTurn: true },
    { effort: "high", appliesAfterTurn: false },
    { model: null, effort: null, appliesAfterTurn: false },
    { runtimeId: "codex-desktop", model: "native-model", provider: "native-provider", reasoningEffort: "xhigh", fast: false, appliesAfterTurn: false },
  ])("replaces omitted legacy model metadata from a complete configuration event: %j", (data) => {
    const session = {
      sessionId: "session-1", title: "Keep this session", model: "old", modelDisplayName: "Old model", effort: "low", configurationPending: true,
    } as BridgeHostSnapshot["sessions"][number];
    const snapshot = { sessions: [session], permissions: [] } as unknown as BridgeHostSnapshot;
    const configured: BridgeEvent = {
      eventId: "configuration-reset",
      seq: 2,
      timestamp: 2,
      origin: "system",
      type: "session.configuration",
      sessionId: "session-1",
      data,
    };
    const updated = applyEventToSnapshot(snapshot, configured, [])?.sessions[0];
    expect(updated).toMatchObject({ sessionId: "session-1", title: "Keep this session" });
    if (typeof data.model === "string") expect(updated?.model).toBe(data.model);
    else expect(updated).not.toHaveProperty("model");
    expect(updated).not.toHaveProperty("modelDisplayName");
    if (typeof data.effort === "string") expect(updated?.effort).toBe(data.effort);
    else expect(updated).not.toHaveProperty("effort");
    if (data.appliesAfterTurn) expect(updated?.configurationPending).toBe(true);
    else expect(updated).not.toHaveProperty("configurationPending");
    if ("runtimeId" in data) expect(updated).toMatchObject({
      provider: "native-provider", reasoningEffort: "xhigh", fast: false,
    });
    expect(applyEventsToSnapshot(snapshot, [configured], []).snapshot?.sessions[0]).toEqual(updated);
  });

  it.each([
    { runtimeId: "codex-desktop", model: "native-model", appliesAfterTurn: false },
    { runtimeId: "hermes-desktop", model: "native-model", provider: null, reasoningEffort: null, fast: null, appliesAfterTurn: false },
  ])("clears removed native settings from a complete configuration event: %j", (data) => {
    const snapshot = {
      sessions: [{
        sessionId: "session-1", provider: "old-provider", reasoningEffort: "high", fast: true,
      }], permissions: [],
    } as unknown as BridgeHostSnapshot;
    const configured: BridgeEvent = {
      eventId: "native-configuration-reset", seq: 2, timestamp: 2, origin: "codex-host",
      type: "session.configuration", sessionId: "session-1", data,
    };
    const updated = applyEventToSnapshot(snapshot, configured, [])?.sessions[0];
    expect([updated?.provider, updated?.reasoningEffort, updated?.fast]).toEqual([undefined, undefined, undefined]);
    expect(updated).not.toHaveProperty("provider");
    expect(updated).not.toHaveProperty("reasoningEffort");
    expect(updated).not.toHaveProperty("fast");
    expect(applyEventsToSnapshot(snapshot, [configured], []).snapshot?.sessions[0]).toEqual(updated);
  });

  it("removes a cancelled queued turn from the cached session count", () => {
    const snapshot: BridgeHostSnapshot = {
      host: {
        hostId: "desktop-1",
        pairingEpoch: 1,
        name: "Test Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        lastSeenAt: 1,
        version: "0.4.0",
        capabilities: [],
      },
      projects: [],
      sessions: [{
        sessionId: "session-1",
        projectId: "project-1",
        projectName: "project",
        cwd: "/tmp/project",
        title: "Session",
        source: "bridge",
        transport: "bridge-host",
        ownership: "DESKTOP_OBSERVED",
        turnState: "queued",
        lastActivityAt: 1,
        pendingCount: 1,
      }],
      devices: [],
      runtime: {
        state: "ready",
        detail: "Ready",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "未启用",
          enabled: false,
          canRestart: true,
        },
      },
      permissions: [],
      latestSeq: 1,
    };
    const interrupted: BridgeEvent = {
      eventId: "interrupted",
      seq: 2,
      timestamp: 2,
      origin: "system",
      type: "turn.interrupted",
      sessionId: "session-1",
      data: {
        commandId: "queued-command",
        delivery: "cancelled",
        wasQueued: true,
      },
    };

    expect(applyEventToSnapshot(snapshot, interrupted, [])?.sessions[0]).toMatchObject({
      turnState: "idle",
      pendingCount: 0,
    });
  });
});

describe("queued command lifecycle", () => {
  function snapshot(session: Partial<BridgeHostSnapshot["sessions"][number]> = {}): BridgeHostSnapshot {
    return {
      sessions: [{
        sessionId: "session-1", transport: "bridge-host", ownership: "BRIDGE_IDLE",
        turnState: "idle", pendingCount: 0, ...session,
      }],
      permissions: [], latestSeq: 10,
    } as unknown as BridgeHostSnapshot;
  }

  function lifecycle(type: BridgeEvent["type"], seq: number, commandId: string, data = {}): BridgeEvent {
    return {
      eventId: `event-${seq}`, sessionId: "session-1", seq, timestamp: seq,
      origin: "system", type, data: { commandId, ...data },
    };
  }

  it.each(["running", "waiting"] as const)("keeps A %s while B and C queue", (turnState) => {
    const initial = snapshot({ ownership: "BRIDGE_RUNNING", turnState, activeTurnId: "A" });
    const permissions = turnState === "waiting" ? applyPermissionEvent([], lifecycle(
      "permission.requested", 9, "A", { requestId: "permission-A", toolUseId: "tool-A", toolName: "Write", input: {} },
    )) : [];
    const result = applyEventsToSnapshot(initial, [
      lifecycle("turn.queued", 11, "B"), lifecycle("turn.queued", 12, "C"),
      lifecycle("turn.queued", 13, "B"),
    ], permissions);
    expect(result.snapshot?.sessions[0]).toMatchObject({
      ownership: "BRIDGE_RUNNING", turnState, activeTurnId: "A",
      pendingCount: 2, pendingCommandIds: ["B", "C"],
    });
  });

  it.each(["turn.failed", "turn.interrupted"] as const)("removes queued B on %s without ending A", (type) => {
    const initial = snapshot({ ownership: "BRIDGE_RUNNING", turnState: "running", activeTurnId: "A", currentSummary: "Working" });
    const result = applyEventsToSnapshot(initial, [
      lifecycle("turn.queued", 11, "B"),
      { ...lifecycle(type, 12, "B", type === "turn.interrupted" ? { wasQueued: true } : { error: "preflight" }), turnId: "B-turn" },
    ], []);
    expect(result.snapshot?.sessions[0]).toMatchObject({
      ownership: "BRIDGE_RUNNING", turnState: "running", activeTurnId: "A", currentSummary: "Working",
      pendingCount: 0, pendingCommandIds: [],
    });
  });

  it.each(["turn.completed", "turn.failed", "turn.interrupted"] as const)("does not settle A from %s for another turn", (type) => {
    const initial = snapshot({ ownership: "BRIDGE_RUNNING", turnState: "running", activeTurnId: "A", pendingCount: 1, pendingCommandIds: ["B"] });
    const result = applyEventToSnapshot(initial, {
      ...lifecycle(type, 11, "older-command"), turnId: "older-turn",
      data: { commandId: "older-command", pendingCount: 1, pendingCommandIds: ["B"] },
    }, []);
    expect(result?.sessions[0]).toMatchObject({
      ownership: "BRIDGE_RUNNING", turnState: "running", activeTurnId: "A", pendingCount: 1, pendingCommandIds: ["B"],
    });
  });

  it("keeps managed A running after queued B fails and its permission resolves", () => {
    const initial = snapshot({ transport: "claude-desktop-managed", ownership: "DESKTOP_MANAGED_RUNNING", turnState: "running", activeTurnId: "A" });
    const result = applyEventsToSnapshot(initial, [
      lifecycle("permission.requested", 11, "A", { requestId: "permission-A", toolUseId: "tool-A", toolName: "Write", input: {} }),
      lifecycle("turn.queued", 12, "B"),
      lifecycle("turn.failed", 13, "B", { wasQueued: true }),
      lifecycle("permission.resolved", 14, "A", { requestId: "permission-A" }),
    ], []);
    expect(result.snapshot?.sessions[0]).toMatchObject({
      ownership: "DESKTOP_MANAGED_RUNNING", turnState: "running", activeTurnId: "A", pendingCount: 0,
    });
  });

  it.each(["turn.completed", "turn.failed", "turn.interrupted"] as const)("settles uncertain active A on %s even when its command is pending", (type) => {
    const initial = snapshot({ transport: "claude-desktop-managed", ownership: "DESKTOP_MANAGED_RUNNING", turnState: "running", activeTurnId: "A-turn", pendingCount: 2, pendingCommandIds: ["A", "B"] });
    const result = applyEventToSnapshot(initial, {
      ...lifecycle(type, 11, "A", { pendingCount: 1, pendingCommandIds: ["B"] }), turnId: "A-turn",
    }, []);
    expect(result?.sessions[0]).toMatchObject({ ownership: "DESKTOP_MANAGED_IDLE", turnState: "queued", pendingCount: 1, pendingCommandIds: ["B"] });
    expect(result?.sessions[0]?.activeTurnId).toBeUndefined();
  });

  it("settles a pre-start failure without a started event", () => {
    const result = applyEventsToSnapshot(snapshot(), [
      lifecycle("turn.queued", 11, "B"), lifecycle("turn.failed", 12, "B", { error: "preflight" }),
    ], []);
    expect(result.snapshot?.sessions[0]).toMatchObject({ turnState: "idle", pendingCount: 0, pendingCommandIds: [] });
  });

  it("seeds identities from a snapshot and removes only the command that starts", () => {
    const initial = snapshot({ turnState: "queued", pendingCount: 2, pendingCommandIds: ["B", "C"] });
    const started = { ...lifecycle("turn.started", 11, "B"), turnId: "B-turn" };
    const running = applyEventToSnapshot(initial, started, []);
    expect(running?.sessions[0]).toMatchObject({
      turnState: "running", activeTurnId: "B-turn", pendingCount: 1, pendingCommandIds: ["C"],
    });
    expect(applyEventToSnapshot(running, lifecycle("turn.completed", 12, "B"), [])?.sessions[0])
      .toMatchObject({ turnState: "queued", pendingCount: 1, pendingCommandIds: ["C"] });
  });

  it("removes a snapshot-seeded command on a legacy pre-start failure", () => {
    const initial = snapshot({ ownership: "BRIDGE_RUNNING", turnState: "running", activeTurnId: "A", pendingCount: 2, pendingCommandIds: ["B", "C"] });
    expect(applyEventToSnapshot(initial, lifecycle("turn.failed", 11, "B"), [])?.sessions[0]).toMatchObject({
      ownership: "BRIDGE_RUNNING", turnState: "running", activeTurnId: "A", pendingCount: 1, pendingCommandIds: ["C"],
    });
  });

  it("uses post-event metadata when a lifecycle event corrects the queue", () => {
    const initial = snapshot();
    const queued = applyEventToSnapshot(initial, lifecycle("turn.queued", 11, "B", {
      pendingCount: 2, pendingCommandIds: ["B", "C"],
    }), []);
    expect(queued?.sessions[0]).toMatchObject({ turnState: "queued", pendingCount: 2, pendingCommandIds: ["B", "C"] });
    const started = applyEventToSnapshot(queued, {
      ...lifecycle("turn.started", 12, "B", { pendingCount: 1, pendingCommandIds: ["C"] }), turnId: "B-turn",
    }, []);
    expect(started?.sessions[0]).toMatchObject({ turnState: "running", pendingCount: 1, pendingCommandIds: ["C"] });
    expect(applyEventToSnapshot(started, lifecycle("turn.completed", 13, "B", {
      pendingCount: 0, pendingCommandIds: [],
    }), [])?.sessions[0]).toMatchObject({ turnState: "idle", pendingCount: 0, pendingCommandIds: [] });
  });

  it("uses post-event queue metadata for a queued failure while A is waiting", () => {
    const initial = snapshot({ ownership: "BRIDGE_RUNNING", turnState: "running", activeTurnId: "A", pendingCount: 2, pendingCommandIds: ["B", "C"] });
    const permissions = applyPermissionEvent([], lifecycle("permission.requested", 9, "A", {
      requestId: "permission-A", toolUseId: "tool-A", toolName: "Write", input: {},
    }));
    const result = applyEventToSnapshot(initial, lifecycle("turn.failed", 11, "B", {
      wasQueued: true, pendingCount: 1, pendingCommandIds: ["C"],
    }), permissions);
    expect(result?.sessions[0]).toMatchObject({
      ownership: "BRIDGE_RUNNING", turnState: "waiting", activeTurnId: "A", pendingCount: 1, pendingCommandIds: ["C"],
    });
  });

  it("does not apply stale queue or permission events to an authoritative snapshot", () => {
    const initial = snapshot();
    initial.latestSeq = 13;
    const replay = [
      lifecycle("turn.queued", 11, "B"),
      lifecycle("permission.requested", 12, "B", { requestId: "old-permission", toolUseId: "old-tool", toolName: "Write", input: {} }),
      lifecycle("turn.failed", 13, "B"),
    ];
    const result = applyEventsToSnapshot(initial, replay, []);
    expect(result.snapshot).toEqual(initial);
    expect(result.permissions).toEqual([]);
    expect(applyEventToSnapshot(initial, replay[0]!, [])).toBe(initial);
  });

  it("advances the snapshot cursor and ignores duplicate starts and queue events", () => {
    const initial = snapshot({ turnState: "queued", pendingCount: 2, pendingCommandIds: ["B", "C"] });
    const started = { ...lifecycle("turn.started", 11, "B"), turnId: "B-turn" };
    const once = applyEventToSnapshot(initial, started, []);
    expect(once?.latestSeq).toBe(11);
    expect(applyEventToSnapshot(once, started, [])).toBe(once);
    const result = applyEventsToSnapshot(once, [
      started, lifecycle("turn.queued", 12, "D"), lifecycle("turn.queued", 12, "D"),
    ], []);
    expect(result.snapshot?.latestSeq).toBe(12);
    expect(result.snapshot?.sessions[0]).toMatchObject({ pendingCount: 2, pendingCommandIds: ["C", "D"] });
  });
});

describe("rebaseSnapshot", () => {
  it("uses the host snapshot as the cursor instead of retaining a stale cached cursor", () => {
    const snapshot = {
      host: {
        hostId: "desktop-1",
        pairingEpoch: 1,
        name: "Test Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        lastSeenAt: 1,
        version: "0.5.3",
        capabilities: [],
      },
      projects: [],
      sessions: [],
      devices: [],
      runtime: {
        state: "ready",
        detail: "Ready",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "未启用",
          enabled: false,
          canRestart: true,
        },
      },
      permissions: [],
      latestSeq: 3,
    } as BridgeHostSnapshot;
    const refreshed = rebaseSnapshot(snapshot, [event(2), event(4)]);

    expect(refreshed.latestSeq).toBe(4);
    expect(refreshed.snapshot.latestSeq).toBe(4);
  });

  it("applies runtime goal updates and tolerates unknown 0.7+ event types", () => {
    const snapshot: BridgeHostSnapshot = {
      host: {
        hostId: "desktop-1",
        pairingEpoch: 1,
        name: "Test Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        lastSeenAt: 1,
        version: "0.6.9",
        capabilities: [],
      },
      projects: [],
      sessions: [{
        sessionId: "codex-desktop:thread-1",
        projectId: "project-1",
        projectName: "project",
        cwd: "/tmp/project",
        title: "Relay target",
        source: "bridge",
        transport: "codex-app-server",
        ownership: "BRIDGE_IDLE",
        turnState: "idle",
        lastActivityAt: 1,
        pendingCount: 0,
      }],
      devices: [],
      runtime: {
        state: "ready",
        detail: "Ready",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "未启用",
          enabled: false,
          canRestart: true,
        },
      },
      permissions: [],
      latestSeq: 1,
    };
    const handoffEvent: BridgeEvent = {
      eventId: "handoff-started",
      seq: 2,
      timestamp: 2,
      origin: "system",
      type: "runtime.handoff.started",
      sessionId: "codex-desktop:thread-1",
      data: { handoff: { handoffId: "h1", state: "preparing" } },
    };
    // Older clients must ignore unknown events without touching sessions.
    expect(applyEventToSnapshot(snapshot, handoffEvent, [])?.sessions[0]).toMatchObject({
      sessionId: "codex-desktop:thread-1",
      turnState: "idle",
    });

    const goalEvent: BridgeEvent = {
      eventId: "goal-updated",
      seq: 3,
      timestamp: 3,
      origin: "system",
      type: "runtime.goal.updated",
      sessionId: "codex-desktop:thread-1",
      data: {
        goal: {
          objective: "完成重构",
          status: "active",
          native: true,
          continuations: 0,
          updatedAt: 3,
        },
        handoffId: "h1",
      },
    };
    expect(applyEventToSnapshot(snapshot, goalEvent, [])?.sessions[0]?.goal).toMatchObject({
      objective: "完成重构",
      status: "active",
      native: true,
    });

    // The plan gate follows runtime.handoff.* events on the source session
    // so mobile can confirm plans without touching the desktop.
    const planReady: BridgeEvent = {
      eventId: "handoff-plan-ready",
      seq: 4,
      timestamp: 4,
      origin: "system",
      type: "runtime.handoff.plan-ready",
      sessionId: "codex-desktop:thread-1",
      data: {
        handoff: {
          handoffId: "h1",
          state: "plan-ready",
          sourceRuntimeId: "codex-desktop",
          sourceSessionId: "codex-desktop:thread-1",
          targetRuntimeId: "hermes-desktop",
          targetSessionId: "hermes-desktop:stored-1",
          objective: "完成重构",
          summary: "完成重构",
          createdAt: 1,
          updatedAt: 4,
        },
      },
    };
    expect(applyEventToSnapshot(snapshot, planReady, [])?.sessions[0]?.pendingRuntimeHandoff).toMatchObject({
      handoffId: "h1",
      state: "plan-ready",
    });
    const applied: BridgeEvent = {
      eventId: "handoff-applied",
      seq: 5,
      timestamp: 5,
      origin: "system",
      type: "runtime.handoff.applied",
      sessionId: "codex-desktop:thread-1",
      data: {
        handoff: {
          handoffId: "h1",
          state: "applied",
          sourceRuntimeId: "codex-desktop",
          sourceSessionId: "codex-desktop:thread-1",
          targetRuntimeId: "hermes-desktop",
          targetSessionId: "hermes-desktop:stored-1",
          objective: "完成重构",
          summary: "完成重构",
          createdAt: 1,
          updatedAt: 5,
        },
      },
    };
    const withGate = applyEventToSnapshot(snapshot, planReady, []);
    expect(applyEventToSnapshot(withGate, applied, [])?.sessions[0]).not.toHaveProperty("pendingRuntimeHandoff");
  });
});

describe("provider route events", () => {
  it("updates provider status and the logical session route without replacing the session", () => {
    const snapshot = {
      host: {
        hostId: "desktop-1",
        pairingEpoch: 1,
        name: "Test Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        lastSeenAt: 1,
        version: "0.5.0",
        capabilities: ["provider.profile.v1", "conversation.handoff.v1"],
      },
      projects: [],
      sessions: [{
        sessionId: "session-1",
        projectId: "project-1",
        projectName: "project",
        cwd: "/tmp/project",
        title: "Session",
        source: "bridge",
        transport: "bridge-host",
        ownership: "BRIDGE_IDLE",
        turnState: "idle",
        lastActivityAt: 1,
        pendingCount: 0,
      }],
      devices: [],
      runtime: {
        state: "ready",
        detail: "Ready",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "未启用",
          enabled: false,
          canRestart: true,
        },
      },
      permissions: [],
      latestSeq: 1,
    } as BridgeHostSnapshot;
    const providerUpdated: BridgeEvent = {
      eventId: "provider-updated",
      seq: 2,
      timestamp: 2,
      origin: "system",
      type: "provider.updated",
      data: {
        profile: {
          id: "anthropic-api",
          kind: "anthropic-api",
          name: "Anthropic API",
          status: "ready",
          detail: "Ready",
          configured: true,
          localOnlyConfiguration: true,
          readOnly: false,
          models: [],
        },
      },
    };
    const withProvider = applyEventToSnapshot(snapshot, providerUpdated, []);
    expect(withProvider?.providers?.[0]).toMatchObject({
      id: "anthropic-api",
      status: "ready",
    });

    const routeChanged: BridgeEvent = {
      eventId: "route-changed",
      seq: 3,
      timestamp: 3,
      origin: "system",
      type: "conversation.route.changed",
      sessionId: "session-1",
      data: {
        route: {
          conversationId: "session-1",
          activeLaneId: "lane-1",
          activeProviderProfileId: "anthropic-api",
          state: "ready",
          lanes: [],
          allowedActions: {
            canSend: true,
            canSteer: true,
            canInterrupt: true,
            canSwitchProvider: true,
            canContinueOfficial: false,
            canConfigure: true,
          },
        },
      },
    };
    expect(applyEventToSnapshot(withProvider, routeChanged, [])?.sessions[0]).toMatchObject({
      sessionId: "session-1",
      activeLaneId: "lane-1",
      activeProviderProfileId: "anthropic-api",
      routeState: "ready",
      allowedActions: { canSend: true },
    });
  });

  it("applies session archive and delete events to the snapshot", () => {
    const snapshot: BridgeHostSnapshot = {
      host: {
        hostId: "desktop-1",
        pairingEpoch: 1,
        name: "Test Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        lastSeenAt: 1,
        version: "0.7.4",
        capabilities: ["session.visibility.v1"],
      },
      projects: [],
      sessions: [{
        sessionId: "session-1",
        projectId: "project-1",
        projectName: "project",
        cwd: "/tmp/project",
        title: "维护任务",
        source: "bridge",
        transport: "bridge-host",
        ownership: "BRIDGE_IDLE",
        turnState: "idle",
        lastActivityAt: 1,
        pendingCount: 0,
      }],
      devices: [],
      runtime: {
        state: "ready",
        detail: "Ready",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "未启用",
          enabled: false,
          canRestart: true,
        },
      },
      permissions: [],
      latestSeq: 1,
    } as BridgeHostSnapshot;

    const archived: BridgeEvent = {
      eventId: "archive-1",
      seq: 2,
      timestamp: 2,
      origin: "desktop",
      type: "session.archived",
      sessionId: "session-1",
      data: { sessionId: "session-1", archived: true, archivedAt: 2 },
    };
    expect(applyEventToSnapshot(snapshot, archived, [])?.sessions[0]?.archivedAt).toBe(2);

    const restored: BridgeEvent = {
      eventId: "archive-2",
      seq: 3,
      timestamp: 3,
      origin: "desktop",
      type: "session.archived",
      sessionId: "session-1",
      data: { sessionId: "session-1", archived: false },
    };
    const withArchived = applyEventToSnapshot(snapshot, archived, []);
    expect(applyEventToSnapshot(withArchived, restored, [])?.sessions[0]?.archivedAt).toBeUndefined();

    const deleted: BridgeEvent = {
      eventId: "delete-1",
      seq: 4,
      timestamp: 4,
      origin: "desktop",
      type: "session.deleted",
      sessionId: "session-1",
      data: { sessionId: "session-1" },
    };
    expect(applyEventToSnapshot(snapshot, deleted, [])?.sessions).toHaveLength(0);
  });

  it("applies a catch-up batch in one pass with the same outcome as per-event replay", () => {
    const snapshot: BridgeHostSnapshot = {
      host: {
        hostId: "desktop-1",
        pairingEpoch: 1,
        name: "Test Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        lastSeenAt: 1,
        version: "0.7.6",
        capabilities: [],
      },
      projects: [],
      sessions: [1, 2, 3].map((index) => ({
        sessionId: `session-${index}`,
        projectId: "project-1",
        projectName: "project",
        cwd: "/tmp/project",
        title: `任务 ${index}`,
        source: "bridge" as const,
        transport: "bridge-host" as const,
        ownership: "BRIDGE_IDLE" as const,
        turnState: "idle" as const,
        lastActivityAt: 1,
        pendingCount: 0,
      })),
      devices: [],
      runtime: {
        state: "ready",
        detail: "Ready",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "未启用",
          enabled: false,
          canRestart: true,
        },
      },
      permissions: [],
      latestSeq: 1,
    } as BridgeHostSnapshot;
    const events: BridgeEvent[] = [
      {
        eventId: "e1",
        seq: 2,
        timestamp: 2,
        origin: "desktop",
        type: "turn.started",
        sessionId: "session-1",
        turnId: "turn-1",
        data: {},
      },
      {
        eventId: "e2",
        seq: 3,
        timestamp: 3,
        origin: "desktop",
        type: "session.archived",
        sessionId: "session-2",
        data: { sessionId: "session-2", archived: true, archivedAt: 3 },
      },
      // Events the snapshot reducer ignores must not disturb the batch.
      {
        eventId: "e3",
        seq: 4,
        timestamp: 4,
        origin: "system",
        type: "session.desktop-registration",
        sessionId: "session-1",
        data: { state: "registered" },
      },
      {
        eventId: "e4",
        seq: 5,
        timestamp: 5,
        origin: "desktop",
        type: "session.deleted",
        sessionId: "session-3",
        data: { sessionId: "session-3" },
      },
    ];

    const batch = applyEventsToSnapshot(snapshot, events, []);
    expect(batch.snapshot?.sessions.map((session) => session.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
    expect(batch.snapshot?.sessions[0]).toMatchObject({ turnState: "running", activeTurnId: "turn-1" });
    expect(batch.snapshot?.sessions[1]?.archivedAt).toBe(3);

    // Final state must equal sequential per-event application.
    let sequential = snapshot;
    let sequentialPermissions = snapshot.permissions;
    for (const event of events) {
      sequentialPermissions = applyPermissionEvent(sequentialPermissions, event);
      sequential = applyEventToSnapshot(sequential, event, sequentialPermissions)!;
    }
    expect(batch.snapshot?.sessions).toEqual(sequential.sessions);
    expect(batch.permissions).toEqual(sequentialPermissions);
  });
});
