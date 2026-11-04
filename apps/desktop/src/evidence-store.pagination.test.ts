import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type {
  BridgeArtifactManifest,
  BridgeEvidenceBundle,
  BridgeToolEvidence,
} from "@bridge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceStore } from "./evidence-store.js";

let directory: string;
let store: EvidenceStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bridge-evidence-pagination-"));
  store = new EvidenceStore({
    databasePath: join(directory, "evidence.sqlite"),
    blobsPath: join(directory, "blobs"),
    masterSecret: "pagination-test-secret",
  });
  await store.initialize();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await promisify(execFile)(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", [directory]);
});

function tool(index: number): BridgeToolEvidence {
  return {
    id: `tool-${index}`,
    toolName: "Read",
    status: "completed",
    summary: `Read file ${index}`,
    startedAt: index,
    completedAt: index + 1,
    truncated: false,
  };
}

function bundle(id = "evidence-1", tools: BridgeToolEvidence[] = []): BridgeEvidenceBundle {
  return {
    id,
    sessionId: "session-1",
    turnId: "turn-1",
    laneId: "lane-1",
    providerProfileId: "profile-1",
    runtimeId: "claude-desktop",
    source: "bridge-host",
    confidence: "exact",
    state: "ready",
    startedAt: 1_000,
    completedAt: 2_000,
    toolCount: tools.length,
    changeCount: 2,
    artifactCount: 1,
    tools,
    artifacts: [],
    warnings: ["A retained warning"],
  };
}

function artifact(index: number, evidenceId = "evidence-1"): BridgeArtifactManifest {
  return {
    id: `artifact-${String(index).padStart(5, "0")}`,
    evidenceId,
    relativePath: `reports/${index}.txt`,
    name: `${index}.txt`,
    kind: "text",
    changeKind: "created",
    mimeType: "text/plain",
    size: index,
    availability: "current-file",
    previewMode: "text",
    downloadAllowed: true,
  };
}

describe("EvidenceStore pagination", () => {
  it("lists summaries from headers and stored counts without querying detail payloads", async () => {
    const saved = bundle("evidence-1", [tool(0), tool(1)]);
    store.saveBundle(saved);
    await store.replaceArtifacts(saved.id, [
      { manifest: artifact(0), rootPath: directory },
      { manifest: { ...artifact(1), changeKind: "deleted" }, rootPath: directory },
    ]);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");

    expect(store.list(saved.sessionId)).toEqual({
      sessionId: saved.sessionId,
      items: [{ ...saved, tools: [], artifacts: [], detailsAvailable: true }],
      hasMore: false,
    });
    expect(prepare.mock.calls.length).toBeGreaterThan(0);
    for (const [sql] of prepare.mock.calls) {
      expect(sql).not.toMatch(/\btools_json\b|\bevidence_artifacts\b|SELECT\s+\*/i);
    }
  });

  it("keeps complete internal get behavior including deleted artifacts", async () => {
    const saved = bundle("evidence-1", [tool(0), tool(1)]);
    const artifacts = [artifact(0), { ...artifact(1), changeKind: "deleted" as const }];
    store.saveBundle(saved);
    await store.replaceArtifacts(saved.id, artifacts.map((manifest) => ({ manifest, rootPath: directory })));

    expect(store.get(saved.id)).toEqual({ ...saved, artifacts });
  });

  it("keeps list cursors ordered and marks the last summary page", () => {
    for (let index = 0; index < 65; index++) {
      store.saveBundle(bundle(`evidence-${String(index).padStart(2, "0")}`, [tool(index)]));
    }
    const first = store.list("session-1");
    const second = store.list("session-1", first.nextCursor);
    const last = store.list("session-1", second.nextCursor);

    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(30);
    expect(last.items).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeUndefined();
    expect([...first.items, ...second.items, ...last.items].map((item) => item.id)).toEqual(
      Array.from({ length: 65 }, (_, index) => `evidence-${String(64 - index).padStart(2, "0")}`),
    );
    expect([...first.items, ...second.items, ...last.items].every((item) => (
      item.tools.length === 0 && item.artifacts.length === 0 && item.detailsAvailable
    ))).toBe(true);
  });

  it("pages all 1734 tools by numeric JSON array key without a full get", () => {
    const tools = Array.from({ length: 1_734 }, (_, index) => tool(index));
    store.saveBundle(bundle("evidence-1", tools));
    const get = vi.spyOn(store, "get");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const received: BridgeToolEvidence[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const page = store.details("evidence-1", "tools", cursor)!;
      expect(page.kind).toBe("tools");
      expect(page.evidenceId).toBe("evidence-1");
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(30);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(40 * 1024);
      received.push(...page.items as BridgeToolEvidence[]);
      expect(++pages).toBeLessThanOrEqual(58);
      if (!page.hasMore) {
        expect(page.items).toHaveLength(24);
        expect(page.nextCursor).toBeUndefined();
        break;
      }
      expect(page.nextCursor).toBe(String(received.length - 1));
      cursor = page.nextCursor;
    }

    expect(received).toEqual(tools);
    expect(get).not.toHaveBeenCalled();
    const queries = prepare.mock.calls.map(([sql]) => sql);
    expect(queries.some((sql) => /json_each/i.test(sql))).toBe(true);
    for (const sql of queries.filter((sql) => /tools_json/i.test(sql))) {
      expect(sql).toMatch(/json_each/i);
      expect(sql).toMatch(/LIMIT/i);
    }
    expect(queries.every((sql) => !/SELECT\s+\*/i.test(sql))).toBe(true);
  });

  it("retrieves all 15076 artifacts once with ID keyset cursors", async () => {
    const artifacts = Array.from({ length: 15_076 }, (_, index) => ({
      ...artifact(index),
      ...(index % 100 === 0 ? { changeKind: "deleted" as const } : {}),
    }));
    store.saveBundle(bundle());
    await store.replaceArtifacts("evidence-1", [...artifacts].reverse().map((manifest) => ({
      manifest,
      rootPath: directory,
    })));
    store.saveBundle(bundle("other-evidence"));
    await store.replaceArtifacts("other-evidence", [{
      manifest: artifact(20_000, "other-evidence"),
      rootPath: directory,
    }]);
    const get = vi.spyOn(store, "get");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const received: BridgeArtifactManifest[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const page = store.details("evidence-1", "artifacts", cursor)!;
      expect(page.kind).toBe("artifacts");
      expect(page.evidenceId).toBe("evidence-1");
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(30);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(40 * 1024);
      received.push(...page.items as BridgeArtifactManifest[]);
      expect(++pages).toBeLessThanOrEqual(503);
      if (!page.hasMore) {
        expect(page.items).toHaveLength(16);
        expect(page.nextCursor).toBeUndefined();
        break;
      }
      expect(page.nextCursor).toBe(page.items.at(-1)!.id);
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor;
    }

    expect(received).toEqual(artifacts);
    expect(new Set(received.map((item) => item.id)).size).toBe(15_076);
    expect(get).not.toHaveBeenCalled();
    for (const [sql] of prepare.mock.calls.filter(([sql]) => /evidence_artifacts/i.test(sql))) {
      expect(sql).toMatch(/\bid\s*>\s*\?/i);
      expect(sql).toMatch(/ORDER\s+BY\s+id/i);
      expect(sql).toMatch(/LIMIT/i);
      expect(sql).not.toMatch(/SELECT\s+\*|root_path|source_path|blob_key/i);
    }
  });

  it.each(["tools", "artifacts"] as const)("distinguishes missing and empty %s pages", (kind) => {
    expect(store.details("missing", kind)).toBeUndefined();
    store.saveBundle(bundle());
    expect(store.details("evidence-1", kind)).toEqual({
      evidenceId: "evidence-1", kind, items: [], hasMore: false,
    });
  });

  it.each(["tools", "artifacts"] as const)("caps %s pages at 100 and handles an exactly full final page", async (kind) => {
    store.saveBundle(bundle("evidence-1", Array.from({ length: 120 }, (_, index) => tool(index))));
    await store.replaceArtifacts("evidence-1", Array.from({ length: 120 }, (_, index) => ({
      manifest: artifact(index), rootPath: directory,
    })));

    expect(store.details("evidence-1", kind)!.items).toHaveLength(30);
    expect(store.details("evidence-1", kind, undefined, 1_000)!.items).toHaveLength(100);
    expect(store.details("evidence-1", kind, undefined, 0)!.items).toHaveLength(1);
    const last = store.details("evidence-1", kind, kind === "tools" ? "89" : artifact(89).id)!;
    expect(last.items).toHaveLength(30);
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeUndefined();
    expect(store.details("evidence-1", kind, kind === "tools" ? "119" : artifact(119).id)).toEqual({
      evidenceId: "evidence-1", kind, items: [], hasMore: false,
    });
  });

  it.each(["tools", "artifacts"] as const)("keeps UTF-8 %s pages within 40 KiB without losing budget-trimmed items", async (kind) => {
    const tools = Array.from({ length: 13 }, (_, index) => ({
      ...tool(index), input: "界".repeat(2_730),
    }));
    const artifacts = Array.from({ length: 13 }, (_, index) => ({
      ...artifact(index), blockedReason: "界".repeat(2_730),
    }));
    store.saveBundle(bundle("evidence-1", tools));
    await store.replaceArtifacts("evidence-1", artifacts.map((manifest) => ({ manifest, rootPath: directory })));
    const received: Array<BridgeToolEvidence | BridgeArtifactManifest> = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    while (true) {
      const page = store.details("evidence-1", kind, cursor)!;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(40 * 1024);
      received.push(...page.items);
      pageSizes.push(page.items.length);
      expect(pageSizes.length).toBeLessThanOrEqual(4);
      if (!page.hasMore) {
        expect(page.nextCursor).toBeUndefined();
        break;
      }
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor;
    }
    expect(pageSizes).toEqual([4, 4, 4, 1]);
    expect(received).toEqual(kind === "tools" ? tools : artifacts);
  });
});
