import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionEventLog } from "./session-event-log.js";

it("retains the last executor handoff through compaction and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-handoff-receipt-"));
  const path = join(root, "events.jsonl");
  const log = new SessionEventLog(path, 1, { bytesThreshold: 1, retainEvents: 2 });
  const reopened = new SessionEventLog(path, 1, { bytesThreshold: 1, retainEvents: 2 });
  try {
    await log.append({ sessionId: "logical", itemId: "native", origin: "system", type: "session.desktop-handoff", timestamp: 100, data: { state: "bridge" } });
    await log.append({ sessionId: "logical", itemId: "native", origin: "system", type: "session.desktop-handoff", timestamp: 200, data: { state: "released" } });
    for (let index = 0; index < 20; index++) await log.append({ origin: "system", type: "host.presence", data: {} });
    await log.close();
    await reopened.initialize();
    expect(reopened.latestItem("logical", "session.desktop-handoff", "native")).toMatchObject({ timestamp: 200, data: { state: "released" } });
    expect(reopened.latestDesktopHandoffs()).toMatchObject([{ sessionId: "logical", itemId: "native", data: { state: "released" } }]);
    expect(reopened.history("logical").items).toEqual([]);
  } finally {
    await log.close();
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
