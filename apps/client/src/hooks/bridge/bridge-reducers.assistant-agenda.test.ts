import { ASSISTANT_AGENDA_CAPABILITY, type BridgeAgendaSnapshot, type BridgeEvent, type BridgeHostSnapshot } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { applyEventToSnapshot, applyEventsToSnapshot } from "./bridge-reducers.js";

const before: BridgeAgendaSnapshot = { changeToken: "before", credentialsSupported: true, sources: [] };
const after: BridgeAgendaSnapshot = {
  changeToken: "after", credentialsSupported: true,
  sources: [{ id: "local", label: "本地", enabled: true, writable: true, configurable: false, status: "ready" }],
};

function snapshot(supported: boolean): BridgeHostSnapshot {
  return {
    host: {
      hostId: "host", pairingEpoch: 1, name: "Desktop", relayUrl: "ws://127.0.0.1:1/ws",
      online: true, lastSeenAt: 1, version: "1.3.7", capabilities: supported ? [ASSISTANT_AGENDA_CAPABILITY] : [],
    },
    projects: [], devices: [], permissions: [], latestSeq: 10, assistantAgenda: before,
    sessions: [{
      sessionId: "native-session", projectId: "project", projectName: "Project", cwd: "/project",
      title: "Native session", source: "desktop", transport: "claude-desktop-native",
      ownership: "DESKTOP_NATIVE_IDLE", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
    }],
    runtime: {
      state: "ready", detail: "", activeTurns: 0, maxParallelTurns: 1,
      desktopIntegration: { state: "ready", detail: "", enabled: true, canRestart: false },
    },
  };
}

function change(seq: number, assistantAgenda: BridgeAgendaSnapshot): BridgeEvent {
  return { type: "plugin.assistant-agenda.changed", eventId: `agenda-${seq}`, seq, timestamp: seq, origin: "system", data: { assistantAgenda } };
}

const single = (current: BridgeHostSnapshot, event: BridgeEvent) => applyEventToSnapshot(current, event, current.permissions);
const batch = (current: BridgeHostSnapshot, event: BridgeEvent) => applyEventsToSnapshot(current, [event], current.permissions).snapshot;

describe.each([
  { name: "single", apply: single },
  { name: "batch", apply: batch },
])("Agenda event reduction via $name", ({ apply }) => {
  it("applies a fresh host-level projection without changing session data", () => {
    const current = snapshot(true);
    const next = apply(current, change(11, after));
    expect(next).toMatchObject({ assistantAgenda: after, latestSeq: 11 });
    expect(next?.sessions).toEqual(current.sessions);
    expect(current.assistantAgenda).toBe(before);
  });

  it("ignores either an unsupported host or a replayed sequence", () => {
    expect(apply(snapshot(false), change(11, after))).toMatchObject({ assistantAgenda: before, latestSeq: 11 });
    expect(apply(snapshot(true), change(10, after))).toMatchObject({ assistantAgenda: before, latestSeq: 10 });
  });
});

it("keeps the newest projection when reconnect replays several changes", () => {
  const current = snapshot(true);
  const latest = { ...before, changeToken: "latest" };
  const result = applyEventsToSnapshot(current, [change(11, after), change(12, latest), change(11, after)], []);
  expect(result.snapshot).toMatchObject({ assistantAgenda: latest, latestSeq: 12 });
});
