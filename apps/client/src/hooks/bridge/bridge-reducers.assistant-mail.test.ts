import type { BridgeAssistantMailSnapshot, BridgeEvent, BridgeHostSnapshot } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { applyEventToSnapshot, applyEventsToSnapshot } from "./bridge-reducers.js";

const previous: BridgeAssistantMailSnapshot = {
  binding: { assistantId: "assistant", nativeSessionId: "native-session", sectionId: null, previousSessionIds: [] },
  bindingState: "ready", receiverState: "connected", changeToken: "before", automaticDelivery: false,
};
const changed: BridgeAssistantMailSnapshot = {
  bindingState: "unbound", receiverState: "disabled", changeToken: "after", automaticDelivery: false,
};

function snapshot(enabled = true): BridgeHostSnapshot {
  return {
    host: {
      hostId: "host", pairingEpoch: 1, name: "Desktop", relayUrl: "ws://127.0.0.1:1/ws",
      online: true, lastSeenAt: 1, version: "1.3.3", capabilities: enabled ? ["plugin.assistant-mail.v1"] : [],
    },
    projects: [], devices: [], permissions: [], latestSeq: 10, assistantMail: previous,
    sessions: [{
      sessionId: "native-session", projectId: "project", projectName: "Project", cwd: "/project",
      title: "Native session", source: "desktop", transport: "claude-desktop-native",
      ownership: "DESKTOP_NATIVE_RUNNING", turnState: "running", activeTurnId: "active-turn",
      lastActivityAt: 1, pendingCount: 1, pendingCommandIds: ["queued-command"],
    }],
    runtime: {
      state: "ready", detail: "", activeTurns: 1, maxParallelTurns: 1,
      desktopIntegration: { state: "ready", detail: "", enabled: true, canRestart: false },
    },
  };
}

function event(seq: number, assistantMail = changed): BridgeEvent {
  return {
    eventId: `mail-change-${seq}`, seq, timestamp: seq, origin: "system",
    type: "plugin.assistant-mail.changed", data: { assistantMail },
  };
}

describe.each([
  { name: "single", apply: (current: BridgeHostSnapshot, update: BridgeEvent) => applyEventToSnapshot(current, update, current.permissions) },
  { name: "batch", apply: (current: BridgeHostSnapshot, update: BridgeEvent) => applyEventsToSnapshot(current, [update], current.permissions).snapshot },
])("$name assistant-mail changed reducer", ({ apply }) => {
  it("replaces host-level mail state without requiring a session ID or changing native execution", () => {
    const current = snapshot();
    const update = event(11);
    const original = structuredClone({ current, update });

    const next = apply(current, update)!;

    expect(next.assistantMail).toEqual(changed);
    expect(next.assistantMail).not.toHaveProperty("binding");
    expect(next.latestSeq).toBe(11);
    expect(next.host).toBe(current.host);
    expect(next.sessions).toEqual(current.sessions);
    expect(next.sessions[0]).toBe(current.sessions[0]);
    expect(next.permissions).toEqual(current.permissions);
    expect({ current, update }).toEqual(original);
  });

  it("initializes the optional mail projection from the first supported change event", () => {
    const { assistantMail: _previous, ...current } = snapshot();

    expect(apply(current, event(11))?.assistantMail).toEqual(changed);
    expect(current).not.toHaveProperty("assistantMail");
  });

  it("ignores mail data from a host without the capability while advancing the event sequence", () => {
    const current = snapshot(false);
    const next = apply(current, event(11))!;

    expect(next.assistantMail).toEqual(previous);
    expect(next.latestSeq).toBe(11);
    expect(next.sessions).toEqual(current.sessions);
  });

  it.each([9, 10])("does not replace mail state from replayed sequence %i", seq => {
    const current = snapshot();
    const next = apply(current, event(seq))!;

    expect(next.assistantMail).toEqual(previous);
    expect(next.latestSeq).toBe(10);
    expect(current.assistantMail).toEqual(previous);
  });
});

it("keeps the last fresh mail update during batch replay alongside native session events", () => {
  const current = snapshot();
  const latest: BridgeAssistantMailSnapshot = { ...changed, receiverState: "connecting", changeToken: "latest" };
  const events: BridgeEvent[] = [
    event(11),
    {
      eventId: "native-completed", seq: 12, timestamp: 12, origin: "claude-desktop",
      sessionId: "native-session", turnId: "active-turn", type: "turn.completed", data: {},
    },
    event(13, latest),
    event(11),
  ];
  const original = structuredClone({ current, events });

  const result = applyEventsToSnapshot(current, events, current.permissions);
  const sequential = events.reduce<BridgeHostSnapshot>((state, update) => applyEventToSnapshot(state, update, state.permissions)!, current);

  expect(result.snapshot).toEqual(sequential);
  expect(result.snapshot?.assistantMail).toEqual(latest);
  expect(result.snapshot?.latestSeq).toBe(13);
  expect(result.snapshot?.sessions[0]).toMatchObject({
    turnState: "queued", ownership: "DESKTOP_NATIVE_IDLE", pendingCount: 1, pendingCommandIds: ["queued-command"],
  });
  expect(result.snapshot?.sessions[0]).not.toHaveProperty("activeTurnId");
  expect(result.permissions).toEqual([]);
  expect({ current, events }).toEqual(original);
});
