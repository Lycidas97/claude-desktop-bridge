import type { BridgeEvent, BridgeHostSnapshot } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { applyEventsToSnapshot, applyEventToSnapshot, rebaseSnapshot } from "./useMobileBridge.js";

function snapshot(): BridgeHostSnapshot {
  return {
    host: { hostId: "desktop", pairingEpoch: 1, name: "Desktop", relayUrl: "wss://relay.example/ws", online: true, lastSeenAt: 1, version: "1.1.0", capabilities: [] },
    projects: [], devices: [], permissions: [], latestSeq: 10,
    runtime: { state: "ready", detail: "Ready", activeTurns: 1, maxParallelTurns: 2, desktopIntegration: { state: "not-managed", detail: "External", enabled: false, canRestart: true } },
    sessions: ["active", "sibling"].map(sessionId => ({
      sessionId, title: sessionId, cwd: "/tmp/project", projectId: "project", projectName: "Project", source: "desktop", transport: "bridge-host", ownership: "DESKTOP_OBSERVED", turnState: "running", pendingCount: 2,
      activeTurnId: "main-turn", executionStage: "running", currentSummary: "Working", lastActivityAt: 5,
      runningSubagents: { count: 2, lastUpdatedAt: 5 }, subagentStopScope: "process", mainTurnStopScope: "process",
    })),
  };
}

function progress(seq: number, lastUpdatedAt: number): BridgeEvent {
  return { eventId: `progress-${seq}`, seq, timestamp: lastUpdatedAt, origin: "system", type: "runtime.updated", sessionId: "active", itemId: "session:subagent-activity", data: { session: { sessionId: "active", runningSubagents: { count: 2, lastUpdatedAt }, lastActivityAt: lastUpdatedAt } } };
}

describe("small subagent progress session updates", () => {
  it("updates only the target aggregate while preserving main-turn state and sibling sessions", () => {
    const before = snapshot();
    const after = applyEventToSnapshot(before, progress(11, 20), [])!;
    expect(after.sessions[0]).toEqual({ ...before.sessions[0], runningSubagents: { count: 2, lastUpdatedAt: 20 }, lastActivityAt: 20 });
    expect(after.sessions[1]).toBe(before.sessions[1]);
    expect(after.projects).toBe(before.projects);
    expect(after.runtime).toBe(before.runtime);
    expect(after.latestSeq).toBe(11);
  });

  it("replays progress through the same reducer as live events", () => {
    const before = snapshot();
    const events = [progress(11, 20), progress(12, 30)];
    const live = events.reduce((current, event) => applyEventToSnapshot(current, event, [])!, before);
    expect(applyEventsToSnapshot(before, events, []).snapshot).toEqual(live);
    expect(live.sessions[0]?.runningSubagents).toEqual({ count: 2, lastUpdatedAt: 30 });
  });

  it("ignores duplicate and older progress after an authoritative snapshot", () => {
    const current = { ...snapshot(), latestSeq: 12 };
    expect(applyEventToSnapshot(current, progress(12, 2), [])).toBe(current);
    expect(applyEventToSnapshot(current, progress(11, 1), [])).toBe(current);
  });

  it("retains newer progress when rebasing a delayed older snapshot", () => {
    const rebased = rebaseSnapshot(snapshot(), [progress(12, 30), progress(11, 20)]);
    expect(rebased.snapshot.sessions[0]?.runningSubagents).toEqual({ count: 2, lastUpdatedAt: 30 });
    expect(rebased.latestSeq).toBe(12);
  });

  it("keeps a newer complete snapshot authoritative when the last subagent has ended", () => {
    const complete = snapshot();
    complete.latestSeq = 12;
    delete complete.sessions[0]!.runningSubagents;
    delete complete.sessions[0]!.subagentStopScope;
    const rebased = rebaseSnapshot(complete, [progress(11, 20)]);
    expect(rebased.snapshot.sessions[0]).not.toHaveProperty("runningSubagents");
    expect(rebased.snapshot.sessions[0]).not.toHaveProperty("subagentStopScope");
    expect(rebased.snapshot.sessions[0]?.turnState).toBe("running");
  });

  it("does not apply a patch whose nested session belongs to another conversation", () => {
    const before = snapshot();
    const event = progress(11, 20);
    event.data.session = { sessionId: "sibling", runningSubagents: { count: 2, lastUpdatedAt: 20 } };
    const after = applyEventToSnapshot(before, event, [])!;
    expect(after.sessions).toEqual(before.sessions);
  });
});
