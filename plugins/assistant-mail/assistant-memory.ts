import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { MemoryRuleProposalAction } from "../../packages/protocol/src/assistant-proposal.js";
import { AgendaEditError } from "./agenda-store.js";
import { ASSISTANT_MEMORY_ROOTS } from "./fs-guard.js";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const ASSISTANT_PROFILE_TEMPLATE = "# 用户确认的助理规则\n\n仅在 Bridge 中确认提案后更新规则。\n";
export interface ProfileIntent {
  backend: "profile";
  baseProfileSha256: string;
  resultProfileSha256: string;
  resultText: string;
}

function regularFile(path: string, allowMissing = false): void {
  const info = lstatSync(path, { throwIfNoEntry: !allowMissing });
  if (info && (!info.isFile() || info.nlink !== 1)) {
    throw new AgendaEditError("CONFLICT", "宿主管理的记忆文件不是普通文件。");
  }
}

/** Files are resolved from the host's fixed provisioned workspace, never from proposal input. */
export class AssistantMemory {
  private readonly profilePath: string;

  constructor(private readonly workspace: string) {
    this.profilePath = join(workspace, "PROFILE.md");
  }

  private profile(): Buffer {
    regularFile(this.profilePath);
    return readFileSync(this.profilePath);
  }

  freeze(action: MemoryRuleProposalAction) {
    const profile = this.profile();
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(profile);
    const heading = `<!-- bridge-rule ${action.category}/${action.ruleId} -->`;
    const end = "<!-- /bridge-rule -->";
    const lines = source.split("\n");
    const start = lines.indexOf(heading);
    const stop = lines.indexOf(end, start + 1);
    if ((action.operation === "add") !== (start < 0) || (start >= 0 && (stop < 0 ||
      lines.indexOf(heading, start + 1) >= 0 || lines.slice(start + 1, stop).some(line => !line.startsWith("> "))))) {
      throw new AgendaEditError("CONFLICT", "规则已变更，请重新核对 PROFILE.md。");
    }
    const before = start < 0 ? null : lines.slice(start + 1, stop).map(line => line.slice(2)).join("\n")
      .replaceAll("&#64;", "@").replaceAll("&amp;", "&");
    // A rule must not recursively import model-written files or introduce a section delimiter.
    const block = action.text === undefined ? [] : [heading,
      ...action.text.replaceAll("&", "&amp;").replaceAll("@", "&#64;").split("\n").map(line => `> ${line}`), end];
    if (start < 0) lines.push(...block, "");
    else lines.splice(start, stop - start + 1, ...block);
    const resultText = lines.join("\n");
    const baseProfileSha256 = sha256(profile);
    return {
      profile: { before, baseProfileSha256 },
      intent: { backend: "profile", baseProfileSha256, resultProfileSha256: sha256(resultText), resultText } satisfies ProfileIntent,
    };
  }

  apply(intent: ProfileIntent): "applied" | "conflict" {
    if (this.profileSha256() !== intent.baseProfileSha256) return "conflict";
    const temporary = join(this.workspace, `.bridge-profile-${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, intent.resultText);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, this.profilePath);
    return "applied";
  }

  reconcile(intent: ProfileIntent): "applied" | "failed" | "conflict" {
    const current = this.profileSha256();
    return current === intent.resultProfileSha256 ? "applied" : current === intent.baseProfileSha256 ? "failed" : "conflict";
  }

  private profileSha256(): string | undefined {
    try { return sha256(this.profile()); }
    catch (error) {
      if ((error instanceof AgendaEditError && error.code === "CONFLICT") || (error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
      throw error;
    }
  }

  private *entries(directories = ASSISTANT_MEMORY_ROOTS.map(area => join(this.workspace, area))): Generator<{ id: string; path: string; updatedAt: number }> {
    for (const directory of directories) {
      if (!lstatSync(directory).isDirectory()) continue;
      // Node's recursive readdir may follow directory links. Descend only into
      // directories checked by lstat, and never open or index a linked file.
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const info = lstatSync(path);
        if (info.isDirectory()) yield* this.entries([path]);
        else if (info.isFile() && info.nlink === 1) {
          const offset = relative(this.workspace, path).split(sep).join("/");
          yield { id: sha256(offset), path: offset, updatedAt: info.mtimeMs };
        }
      }
    }
  }

  lookup(entryId: string): { path: string } | undefined {
    for (const entry of this.entries()) if (entry.id === entryId) return { path: entry.path };
  }

  refreshIndex(): string[] {
    const entries = [...this.entries()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, 100);
    const path = join(this.workspace, "memory", "INDEX.md");
    regularFile(path, true);
    writeFileSync(path, ["# 资料索引", ...entries.map(({ id, updatedAt }) => `${id} ${new Date(updatedAt).toISOString()}`), ""].join("\n"), { mode: 0o600 });
    return entries.map(({ id }) => id);
  }

  compactContext(): string[] {
    return [
      `PROFILE.md 版本：${this.profileSha256() ?? "unavailable"}`,
      `资料条目标识（按需用 memory.lookup_entry 查找，再用 Read 读取）：${this.refreshIndex().join(" ") || "无"}`,
    ];
  }
}
