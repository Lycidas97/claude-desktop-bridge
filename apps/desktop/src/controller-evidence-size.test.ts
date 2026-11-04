import { expect, it, vi } from "vitest";
import type { BridgeEvent, BridgeEvidenceBundle, BridgeRequest } from "@bridge/protocol";
import { DesktopController } from "./controller.js";

it("keeps a legacy 15076-artifact event below the reconnect page budget", async () => {
  const evidence: BridgeEvidenceBundle = {
    id: "large-evidence", sessionId: "session-1", source: "bridge-host", confidence: "exact",
    state: "ready", startedAt: 1, completedAt: 2, toolCount: 0, changeCount: 15076,
    artifactCount: 15076, tools: [], warnings: [],
    artifacts: Array.from({ length: 15076 }, (_, index) => ({
      id: `artifact-${index}`, evidenceId: "large-evidence", relativePath: `output/file-${index}.txt`,
      name: `file-${index}.txt`, kind: "text", changeKind: "created", mimeType: "text/plain",
      size: 100, availability: "current-file", previewMode: "text", downloadAllowed: true,
    })),
  };
  const event: BridgeEvent = { eventId: "event-1", seq: 1, timestamp: 2, sessionId: "session-1", origin: "claude-host", type: "evidence.ready", data: { evidence } };
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    eventLog: { replay: vi.fn(() => [event]), latestSeq: () => 1 },
  }) as { handleRequest(request: BridgeRequest, origin: "mobile"): Promise<{ events: BridgeEvent[]; nextSeq: number; hasMore: boolean }> };
  const result = await controller.handleRequest({ kind: "request", requestId: "resume", idempotencyKey: "resume", method: "events.resume", params: { afterSeq: 0, limit: 1 } }, "mobile");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(40 * 1024);
  expect(result).toMatchObject({ nextSeq: 1, hasMore: false, events: [{ data: { evidence: { artifactCount: 15076, artifacts: [], detailsAvailable: true } } }] });
  expect(evidence.artifacts).toHaveLength(15076);
});
