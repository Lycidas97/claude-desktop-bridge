import type {
  BridgeArtifactChangeKind,
  BridgeArtifactKind,
  BridgeArtifactManifest,
  BridgeEvidenceBundle,
  BridgeFileChangeSummary,
} from "@bridge/protocol";
import type { ConversationItem, FileChangesSummary } from "../../lib/conversation-timeline.js";
import { mediaKind } from "../../lib/media-preview.js";

/**
 * Split an absolute path into elidable head, always-visible parent directory
 * and basename. Rows are narrow on the phone; a single trailing ellipsis would
 * hide the file name entirely.
 */
export function splitFilePath(path: string): { head: string; parent: string; base: string } {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return { head: "", parent: "", base: trimmed };
  const dir = trimmed.slice(0, index);
  const base = trimmed.slice(index + 1);
  const parentIndex = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
  if (parentIndex < 0) return { head: "", parent: dir, base };
  return { head: dir.slice(0, parentIndex), parent: dir.slice(parentIndex + 1), base };
}

export interface SessionOutputFileItem {
  key: string;
  name: string;
  displayPath: string;
  /** Raw workspace or relative path for `session.open` / `artifact.transfer.open` when no snapshot exists. */
  filePath: string;
  kind: BridgeArtifactKind;
  changeKind: BridgeArtifactChangeKind;
  size?: number | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
  /** Latest artifact manifest snapshot for this file, if recorded in `evidence.items`. */
  artifact?: BridgeArtifactManifest | undefined;
}

function stripSlashes(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "").trim();
}

export function normalizeOutputFileKey(rawPath: string, cwd?: string): string {
  let normalized = stripSlashes(rawPath);
  if (cwd) {
    const normalizedCwd = stripSlashes(cwd);
    if (normalizedCwd) {
      if (normalized === normalizedCwd) {
        normalized = normalized.split("/").at(-1) ?? normalized;
      } else if (normalized.startsWith(`${normalizedCwd}/`)) {
        normalized = normalized.slice(normalizedCwd.length + 1);
      } else if (/^[a-zA-Z]:\//u.test(normalizedCwd) && normalized.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)) {
        normalized = normalized.slice(normalizedCwd.length + 1);
      }
    }
  }
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized || rawPath.trim();
}

function inferArtifactKindFromPath(filePath: string): BridgeArtifactKind {
  const detected = mediaKind(filePath);
  if (detected === "image") return "image";
  if (detected === "pdf") return "pdf";
  if (/\.(?:html?|xhtml)$/iu.test(filePath)) return "html";
  if (/\.(?:diff|patch)$/iu.test(filePath)) return "diff";
  if (/\.(?:log)$/iu.test(filePath)) return "log";
  if (detected === "text") return "code";
  return "binary";
}

function mapSummaryChangeKind(kind: BridgeFileChangeSummary["kind"]): BridgeArtifactChangeKind {
  if (kind === "add") return "created";
  if (kind === "delete") return "deleted";
  return "modified";
}

type ChronologicalFileEvent =
  | {
      timestamp: number;
      order: number;
      type: "artifact";
      artifact: BridgeArtifactManifest;
    }
  | {
      timestamp: number;
      order: number;
      type: "change";
      change: BridgeFileChangeSummary;
      cumulative?: boolean;
    };

export interface DeduplicateOutputFilesInput {
  bundles?: readonly BridgeEvidenceBundle[] | undefined;
  detailArtifactsByBundleId?: Readonly<Record<string, readonly BridgeArtifactManifest[]>> | undefined;
  conversationItems?: readonly ConversationItem[] | undefined;
  fileChanges?: FileChangesSummary | undefined;
  cwd?: string | undefined;
}

/**
 * Deduplicates all output files across turn evidence manifests (including lazily
 * loaded `evidence.details` artifact pages) and transcript `fileChanges`:
 * - Ordered strictly by **first appearance** in the session (`01`, `02`, ... oldest first-seen to newest).
 * - Projects the **latest snapshot** (`artifact`, `changeKind`, `size`, and cumulative `+additions -deletions`).
 */
export function deduplicateSessionOutputFiles({
  bundles = [],
  detailArtifactsByBundleId,
  conversationItems,
  fileChanges,
  cwd,
}: DeduplicateOutputFilesInput): SessionOutputFileItem[] {
  const events: ChronologicalFileEvent[] = [];
  let order = 0;

  // `evidence.items` arrive newest-first; reverse first so identical `startedAt` preserves oldest-first order.
  const chronologicalBundles = [...bundles]
    .reverse()
    .sort((left, right) => left.startedAt - right.startedAt);

  for (const bundle of chronologicalBundles) {
    const bundleArtifacts = bundle.artifacts.length > 0
      ? bundle.artifacts
      : (detailArtifactsByBundleId?.[bundle.id] ?? []);
    for (const artifact of bundleArtifacts) {
      events.push({
        timestamp: artifact.capturedAt ?? bundle.completedAt ?? bundle.startedAt,
        order: order++,
        type: "artifact",
        artifact,
      });
    }
  }

  let sawItemChanges = false;
  if (conversationItems) {
    for (const item of conversationItems) {
      if (item.role !== "tool" || !item.fileChanges?.length) continue;
      sawItemChanges = true;
      for (const change of item.fileChanges) {
        events.push({
          timestamp: item.createdAt,
          order: order++,
          type: "change",
          change,
        });
      }
    }
  }

  if (!sawItemChanges && fileChanges?.files.length) {
    for (const file of fileChanges.files) {
      events.push({
        timestamp: Number.MAX_SAFE_INTEGER,
        order: order++,
        type: "change",
        change: file,
        cumulative: true,
      });
    }
  }

  events.sort((left, right) => left.timestamp - right.timestamp || left.order - right.order);

  const entries: SessionOutputFileItem[] = [];
  const byKey = new Map<string, SessionOutputFileItem>();

  for (const event of events) {
    if (event.type === "artifact") {
      const { artifact } = event;
      const rawRef = artifact.relativePath || artifact.name;
      const key = normalizeOutputFileKey(rawRef, cwd);
      const previousKey = artifact.previousPath ? normalizeOutputFileKey(artifact.previousPath, cwd) : undefined;
      let existing = byKey.get(key);
      if (!existing && previousKey && byKey.has(previousKey)) {
        existing = byKey.get(previousKey);
        byKey.delete(previousKey);
        if (existing) {
          existing.key = key;
          byKey.set(key, existing);
        }
      }

      if (existing) {
        existing.name = artifact.name || splitFilePath(key).base || key;
        existing.displayPath = key;
        existing.filePath = artifact.relativePath || existing.filePath;
        existing.kind = artifact.kind;
        existing.changeKind = artifact.changeKind;
        existing.size = artifact.size;
        existing.artifact = artifact;
      } else {
        const created: SessionOutputFileItem = {
          key,
          name: artifact.name || splitFilePath(key).base || key,
          displayPath: key,
          filePath: artifact.relativePath || artifact.name,
          kind: artifact.kind,
          changeKind: artifact.changeKind,
          size: artifact.size,
          artifact,
        };
        entries.push(created);
        byKey.set(key, created);
      }
      continue;
    }

    const { change } = event;
    const targetPath = change.movePath || change.path;
    const key = normalizeOutputFileKey(targetPath, cwd);
    const oldKey = change.movePath ? normalizeOutputFileKey(change.path, cwd) : undefined;
    let existing = byKey.get(key);
    if (!existing && oldKey && byKey.has(oldKey)) {
      existing = byKey.get(oldKey);
      byKey.delete(oldKey);
      if (existing) {
        existing.key = key;
        byKey.set(key, existing);
      }
    }

    const baseName = splitFilePath(targetPath).base || key;
    const mappedKind: BridgeArtifactChangeKind = change.movePath
      ? "renamed"
      : mapSummaryChangeKind(change.kind);

    if (existing) {
      existing.name = change.movePath ? baseName : (existing.artifact?.name || baseName);
      existing.displayPath = key;
      if (!existing.artifact || change.movePath) {
        existing.filePath = targetPath;
      }
      if (!existing.artifact) {
        existing.kind = inferArtifactKindFromPath(targetPath);
      }
      if (!event.cumulative || !existing.artifact || existing.changeKind === "observed") {
        existing.changeKind = mappedKind;
      }
      existing.additions = event.cumulative
        ? change.additions
        : (existing.additions ?? 0) + change.additions;
      existing.deletions = event.cumulative
        ? change.deletions
        : (existing.deletions ?? 0) + change.deletions;
    } else {
      const created: SessionOutputFileItem = {
        key,
        name: baseName,
        displayPath: key,
        filePath: targetPath,
        kind: inferArtifactKindFromPath(targetPath),
        changeKind: mappedKind,
        additions: change.additions,
        deletions: change.deletions,
      };
      entries.push(created);
      byKey.set(key, created);
    }
  }

  return entries;
}

export function countSessionOutputFiles(input: DeduplicateOutputFilesInput): number {
  const deduped = deduplicateSessionOutputFiles(input);
  if (deduped.length > 0) return deduped.length;
  // When summary-only bundles have not fetched their artifact details yet, surface a non-zero count hint.
  let pendingSummaryArtifacts = 0;
  for (const bundle of input.bundles ?? []) {
    if (
      bundle.detailsAvailable
      && bundle.artifactCount > 0
      && bundle.artifacts.length === 0
      && !input.detailArtifactsByBundleId?.[bundle.id]
    ) {
      pendingSummaryArtifacts = Math.max(pendingSummaryArtifacts, bundle.artifactCount);
    }
  }
  return pendingSummaryArtifacts;
}
