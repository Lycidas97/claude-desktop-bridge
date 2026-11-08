import type { BridgeSlashCommand, BridgeSlashCommandCatalog } from "@bridge/protocol";
import type { Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";

/** Directory discovery only: this does not initialize a query or inspect Native history. */
export async function discoverSlashCommands(
  cwd: string,
  claudeRoot: string,
): Promise<Pick<BridgeSlashCommandCatalog, "commands" | "warnings">> {
  const warnings: string[] = [];
  const candidates = new Map<string, {
    command: BridgeSlashCommand;
    requestedName?: string;
    visible: boolean;
    priority: number;
  }>();

  async function list(directory: string, label: string): Promise<Dirent[]> {
    try {
      return (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code) throw error;
      if (code !== "ENOENT") warnings.push(`${label}：无法读取目录（${code}）`);
      return [];
    }
  }

  async function addFile(path: string, name: string, skill: boolean, priority: number, label: string): Promise<void> {
    let header: string[] | undefined;
    let complete = false;
    try {
      const file = await open(path, "r");
      try {
        const lines = file.readLines({ encoding: "utf8", autoClose: false });
        try {
          for await (const line of lines) {
            if (header === undefined) {
              if (line !== "---") break;
              header = [];
            } else if (line === "---") {
              complete = true;
              break;
            } else header.push(line);
          }
        } finally { lines.close(); }
      } finally { await file.close(); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code) throw error;
      if (code !== "ENOENT") warnings.push(`${label}：无法读取文件（${code}）`);
      return;
    }
    let metadata: Record<string, unknown> = {};
    if (header !== undefined) {
      if (!complete) { warnings.push(`${label}：YAML 元数据未闭合`); return; }
      let parsed: unknown;
      try { parsed = parse(header.join("\n"), { prettyErrors: false }); }
      catch (error) {
        if (!(error instanceof YAMLParseError) && !(error instanceof ReferenceError)) throw error;
        warnings.push(`${label}：YAML 元数据格式错误`);
        return;
      }
      if (parsed !== null && parsed !== undefined) {
        if (typeof parsed !== "object" || Array.isArray(parsed)) { warnings.push(`${label}：元数据必须为对象`); return; }
        metadata = parsed as Record<string, unknown>;
      }
    }
    if (!/^[^\s/]+$/u.test(name) ||
      (metadata.description !== undefined && typeof metadata.description !== "string") ||
      (metadata["argument-hint"] !== undefined && typeof metadata["argument-hint"] !== "string") ||
      (metadata["user-invocable"] !== undefined && typeof metadata["user-invocable"] !== "boolean") ||
      (metadata["disable-model-invocation"] !== undefined && typeof metadata["disable-model-invocation"] !== "boolean") ||
      (skill && metadata.name !== undefined && (typeof metadata.name !== "string" || !/^[a-z0-9-]{1,64}$/u.test(metadata.name)))) {
      warnings.push(`${label}：命令元数据字段无效`);
      return;
    }
    const previous = candidates.get(name);
    if (!previous || priority > previous.priority) candidates.set(name, {
      command: { name, description: (metadata.description as string | undefined)?.trim() ?? "",
        ...(typeof metadata["argument-hint"] === "string" ? { argumentHint: metadata["argument-hint"].trim() } : {}) },
      ...(skill && typeof metadata.name === "string" ? { requestedName: metadata.name } : {}),
      visible: metadata["user-invocable"] !== false,
      priority,
    });
  }

  async function legacy(directory: string, prefix: string, priority: number, label: string): Promise<void> {
    for (const entry of await list(directory, label)) {
      if (entry.isDirectory()) await legacy(join(directory, entry.name), `${prefix}${entry.name}:`, priority, `${label}/${entry.name}`);
      else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) {
        await addFile(join(directory, entry.name), `${prefix}${entry.name.slice(0, -3)}`, false, priority, `${label}/${entry.name}`);
      }
    }
  }

  for (const [priority, root] of [join(cwd, ".claude"), claudeRoot].entries()) {
    const label = priority === 0 ? "当前项目" : "个人目录";
    await legacy(join(root, "commands"), "", priority, `${label}/commands`);
    for (const entry of await list(join(root, "skills"), `${label}/skills`)) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await addFile(join(root, "skills", entry.name, "SKILL.md"), entry.name, true, priority + 2, `${label}/skills/${entry.name}/SKILL.md`);
      }
    }
  }

  const claimed = new Set(candidates.keys());
  const commands: BridgeSlashCommand[] = [];
  for (const entry of [...candidates.values()].sort((a, b) => b.priority - a.priority || a.command.name.localeCompare(b.command.name))) {
    if (entry.requestedName && entry.requestedName !== entry.command.name && !claimed.has(entry.requestedName)) {
      claimed.add(entry.requestedName);
      entry.command = { ...entry.command, name: entry.requestedName, aliases: [entry.command.name] };
    }
    if (entry.visible) commands.push(entry.command);
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { commands, ...(warnings.length ? { warnings } : {}) };
}
