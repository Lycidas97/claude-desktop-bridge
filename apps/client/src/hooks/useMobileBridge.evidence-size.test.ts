import { expect, it } from "vitest";
import type { BridgeEvidenceBundle, BridgeEvent } from "@bridge/protocol";
import { mergeBridgeEvents } from "./useMobileBridge.js";

it("retains one lightweight update per evidence bundle instead of every full tool list", () => {
  const evidence: BridgeEvidenceBundle = {
    id: "bundle-1", sessionId: "session-1", source: "bridge-host", confidence: "exact",
    state: "collecting", startedAt: 1, toolCount: 1734, changeCount: 0, artifactCount: 0,
    artifacts: [], warnings: [], tools: Array.from({ length: 1734 }, (_, i) => ({
      id: `tool-${i}`, toolName: "Read", status: "completed", summary: "Read file",
      startedAt: i, input: "x".repeat(800), truncated: false,
    })),
  };
  const events: BridgeEvent[] = Array.from({ length: 40 }, (_, i) => ({
    eventId: `update-${i}`, seq: i + 1, timestamp: i + 1, sessionId: "session-1",
    origin: "claude-host", type: "evidence.updated", data: { evidence },
  }));
  const merged = mergeBridgeEvents([], events);
  expect(JSON.stringify(merged).length).toBeLessThan(4000);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ seq: 40, data: { evidence: { toolCount: 1734, tools: [], detailsAvailable: true } } });
  expect(evidence.tools).toHaveLength(1734);
});
