import type { BridgeArtifactManifest, BridgeEvidenceBundle } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import type { ConversationItem } from "../../lib/conversation-timeline.js";
import {
  countSessionOutputFiles,
  deduplicateSessionOutputFiles,
  normalizeOutputFileKey,
  splitFilePath,
} from "./FileChangesCard.js";

function artifact(
  id: string,
  relativePath: string,
  overrides: Partial<BridgeArtifactManifest> = {},
): BridgeArtifactManifest {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return {
    id,
    evidenceId: "ev-1",
    name,
    relativePath,
    kind: "code",
    changeKind: "created",
    mimeType: "text/plain",
    size: 120,
    availability: "snapshot",
    previewMode: "text",
    downloadAllowed: true,
    ...overrides,
  };
}

function bundle(
  id: string,
  startedAt: number,
  artifacts: BridgeArtifactManifest[],
  overrides: Partial<BridgeEvidenceBundle> = {},
): BridgeEvidenceBundle {
  return {
    id,
    sessionId: "s-1",
    source: "claude-desktop",
    confidence: "exact",
    state: "ready",
    startedAt,
    completedAt: startedAt + 5,
    toolCount: 0,
    changeCount: artifacts.length,
    artifactCount: artifacts.length,
    tools: [],
    artifacts,
    warnings: [],
    ...overrides,
  };
}

describe("splitFilePath", () => {
  it("splits absolute POSIX paths into elidable head, parent and basename", () => {
    expect(splitFilePath("/Users/me/Work/repo/apps/client/src/components/MobileWorkspace.tsx"))
      .toEqual({
        head: "/Users/me/Work/repo/apps/client/src",
        parent: "components",
        base: "MobileWorkspace.tsx",
      });
  });

  it("splits Windows paths", () => {
    expect(splitFilePath("C:\\Users\\me\\repo\\package.json"))
      .toEqual({ head: "C:\\Users\\me", parent: "repo", base: "package.json" });
  });

  it("keeps single-segment paths intact", () => {
    expect(splitFilePath("package.json")).toEqual({ head: "", parent: "", base: "package.json" });
    expect(splitFilePath("/package.json")).toEqual({ head: "", parent: "", base: "package.json" });
  });

  it("ignores trailing separators", () => {
    expect(splitFilePath("/Users/me/repo/")).toEqual({ head: "/Users", parent: "me", base: "repo" });
  });
});

describe("deduplicateSessionOutputFiles", () => {
  it("normalizes workspace paths against session cwd across POSIX and Windows", () => {
    expect(normalizeOutputFileKey("/Users/me/repo/src/App.tsx", "/Users/me/repo")).toBe("src/App.tsx");
    expect(normalizeOutputFileKey("./src/App.tsx", "/Users/me/repo")).toBe("src/App.tsx");
    expect(normalizeOutputFileKey("C:\\work\\repo\\src\\index.ts", "c:\\work\\repo\\")).toBe("src/index.ts");
  });

  it("orders descending by latest modification/appearance time while projecting latest snapshot and cumulative diff stats", () => {
    // Bundles arrive newest-first from evidence.list: turn 3, turn 2, turn 1.
    const bundles: BridgeEvidenceBundle[] = [
      bundle("turn-3", 300, [
        artifact("snap-a-v2", "src/first.ts", { changeKind: "modified", size: 480 }),
        artifact("snap-c-v1", "docs/report.html", { kind: "html", changeKind: "created", size: 4096 }),
      ]),
      bundle("turn-2", 200, [
        artifact("snap-b-v1", "src/second.ts", { changeKind: "created", size: 220 }),
      ]),
      bundle("turn-1", 100, [
        artifact("snap-a-v1", "src/first.ts", { changeKind: "created", size: 180 }),
      ]),
    ];

    const conversationItems: ConversationItem[] = [
      {
        id: "t-1",
        sessionId: "s-1",
        role: "tool",
        toolName: "File change",
        text: "",
        createdAt: 105,
        origin: "claude-desktop",
        fileChanges: [{ path: "/repo/src/first.ts", kind: "add", additions: 20, deletions: 0 }],
      },
      {
        id: "t-3",
        sessionId: "s-1",
        role: "tool",
        toolName: "File change",
        text: "",
        createdAt: 305,
        origin: "claude-desktop",
        fileChanges: [{ path: "/repo/src/first.ts", kind: "update", additions: 14, deletions: 6 }],
      },
    ];

    const result = deduplicateSessionOutputFiles({
      bundles,
      conversationItems,
      cwd: "/repo",
    });

    // src/first.ts touched at 305 -> #1; docs/report.html created at 300 -> #2; src/second.ts created at 200 -> #3.
    expect(result.map((entry) => entry.key)).toEqual([
      "src/first.ts",
      "docs/report.html",
      "src/second.ts",
    ]);
    expect(result[0]).toMatchObject({
      key: "src/first.ts",
      name: "first.ts",
      changeKind: "modified",
      size: 480,
      additions: 34,
      deletions: 6,
      artifact: { id: "snap-a-v2" },
    });
    expect(result[1]).toMatchObject({
      key: "docs/report.html",
      kind: "html",
      artifact: { id: "snap-c-v1" },
    });
    expect(result[2]).toMatchObject({
      key: "src/second.ts",
      changeKind: "created",
      artifact: { id: "snap-b-v1" },
    });
  });

  it("moves a renamed file to the top when renamed in a later turn while deduplicating its previous path", () => {
    const bundles: BridgeEvidenceBundle[] = [
      bundle("turn-2", 200, [
        artifact("snap-renamed", "src/NewName.tsx", {
          changeKind: "renamed",
          previousPath: "src/OldName.tsx",
          size: 320,
        }),
      ]),
      bundle("turn-1", 100, [
        artifact("snap-old", "src/OldName.tsx", { changeKind: "created", size: 300 }),
        artifact("snap-other", "src/Other.tsx", { changeKind: "created", size: 150 }),
      ]),
    ];

    const result = deduplicateSessionOutputFiles({ bundles });
    expect(result.map((entry) => ({ key: entry.key, name: entry.name, changeKind: entry.changeKind }))).toEqual([
      { key: "src/NewName.tsx", name: "NewName.tsx", changeKind: "renamed" },
      { key: "src/Other.tsx", name: "Other.tsx", changeKind: "created" },
    ]);
  });

  it("merges lazy-loaded detail artifacts and reports summary count hints before loading", () => {
    const summaryOnly = bundle("summary-1", 100, [], {
      detailsAvailable: true,
      artifactCount: 4,
    });
    expect(countSessionOutputFiles({ bundles: [summaryOnly] })).toBe(4);

    const loaded = deduplicateSessionOutputFiles({
      bundles: [summaryOnly],
      detailArtifactsByBundleId: {
        "summary-1": [
          artifact("d-1", "a.txt", { capturedAt: 110 }),
          artifact("d-2", "b.txt", { capturedAt: 120 }),
        ],
      },
    });
    expect(loaded.map((entry) => entry.key)).toEqual(["b.txt", "a.txt"]);
    expect(countSessionOutputFiles({
      bundles: [summaryOnly],
      detailArtifactsByBundleId: {
        "summary-1": [artifact("d-1", "a.txt"), artifact("d-2", "b.txt")],
      },
    })).toBe(2);
  });

  it("updates changeKind chronologically and sorts most recently modified/recreated file first without letting cumulative fallback override real bundle timestamps", () => {
    const bundles: BridgeEvidenceBundle[] = [
      bundle("turn-1", 100, [
        artifact("snap-mod", "src/updated.ts", { changeKind: "created", size: 120 }),
        artifact("snap-recreated", "src/recreated.ts", { changeKind: "created", size: 80 }),
      ], { completedAt: 150 }),
    ];
    const conversationItems: ConversationItem[] = [
      {
        id: "edit-update",
        sessionId: "session",
        role: "tool",
        text: "",
        createdAt: 200,
        origin: "claude-desktop",
        fileChanges: [{ path: "/repo/src/updated.ts", kind: "update", additions: 5, deletions: 2 }],
      },
      {
        id: "edit-delete",
        sessionId: "session",
        role: "tool",
        text: "",
        createdAt: 210,
        origin: "claude-desktop",
        fileChanges: [{ path: "/repo/src/recreated.ts", kind: "delete", additions: 0, deletions: 10 }],
      },
      {
        id: "edit-recreate",
        sessionId: "session",
        role: "tool",
        text: "",
        createdAt: 220,
        origin: "claude-desktop",
        fileChanges: [{ path: "/repo/src/recreated.ts", kind: "add", additions: 12, deletions: 0 }],
      },
    ];

    const result = deduplicateSessionOutputFiles({
      bundles,
      conversationItems,
      cwd: "/repo",
    });

    expect(result[0]).toMatchObject({
      key: "src/recreated.ts",
      changeKind: "created",
      additions: 12,
      deletions: 10,
      artifact: { id: "snap-recreated" },
    });
    expect(result[1]).toMatchObject({
      key: "src/updated.ts",
      changeKind: "modified",
      additions: 5,
      deletions: 2,
      artifact: { id: "snap-mod" },
    });

    // Fallback cumulative fileChanges must not override real bundle timestamps
    const withCumulativeFallback = deduplicateSessionOutputFiles({
      bundles: [
        bundle("b-new", 500, [artifact("art-new", "src/newest.ts", { changeKind: "created", size: 90 })]),
        bundle("b-old", 100, [artifact("art-old", "src/older.ts", { changeKind: "created", size: 70 })]),
      ],
      fileChanges: {
        totalAdditions: 15,
        totalDeletions: 2,
        files: [
          { path: "/repo/src/older.ts", kind: "update", additions: 10, deletions: 2 },
          { path: "/repo/src/fallback-only.ts", kind: "add", additions: 5, deletions: 0 },
        ],
      },
      cwd: "/repo",
    });
    expect(withCumulativeFallback.map((entry) => entry.key)).toEqual([
      "src/newest.ts",
      "src/older.ts",
      "src/fallback-only.ts",
    ]);
  });
});
