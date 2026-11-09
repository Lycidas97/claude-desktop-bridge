import type { BridgeSessionCommandResult, BridgeSlashCommandCatalog } from "@bridge/protocol";
import { useEffect, useRef, useState } from "react";

const BUILTINS = new Set(["help", "context", "usage", "compact", "model", "permissions", "clear", "new", "fork", "btw", "resume", "rename"]);

export function sessionCommandName(text: string): string | undefined {
  return /^\/([^\s/\\]+)(?:\s|$)/u.exec(text)?.[1]?.toLocaleLowerCase();
}

export function findSessionCommand(text: string, catalog?: BridgeSlashCommandCatalog) {
  const name = sessionCommandName(text);
  return catalog?.commands.find(command => command.name.toLocaleLowerCase() === name
    || command.aliases?.some(alias => alias.toLocaleLowerCase() === name));
}

/** Selection only edits the draft. execute is called exclusively by an explicit send. */
export function useSessionCommands({ sessionId, sessionKey = sessionId, enabled, supported, onLoad, onRun, onModel, onRename, onSession }: {
  sessionId: string | undefined;
  sessionKey?: string | undefined;
  enabled: boolean;
  supported: boolean;
  onLoad?: (() => Promise<BridgeSlashCommandCatalog>) | undefined;
  onRun?: ((text: string) => Promise<BridgeSessionCommandResult>) | undefined;
  onModel(): void;
  onRename?(): void;
  onSession(sessionId: string): Promise<void>;
}) {
  const [catalog, setCatalog] = useState<{ key: string | undefined; value: BridgeSlashCommandCatalog }>();
  const [dialog, setDialog] = useState<BridgeSessionCommandResult>();
  const activeKey = useRef(sessionKey);
  activeKey.current = sessionKey;
  const currentCatalog = catalog?.key === sessionKey ? catalog?.value : undefined;
  useEffect(() => { setDialog(undefined); }, [sessionKey]);

  async function load(): Promise<BridgeSlashCommandCatalog> {
    const next = await onLoad!();
    setCatalog({ key: sessionKey, value: next });
    return next;
  }

  function recognizes(text: string): boolean {
    const name = sessionCommandName(text);
    return enabled && Boolean(name && (BUILTINS.has(name) || findSessionCommand(text, currentCatalog)));
  }

  async function execute(text: string, hasAttachments: boolean): Promise<boolean> {
    const name = sessionCommandName(text);
    if (!enabled || !name) return false;
    const builtin = BUILTINS.has(name);
    // Older hosts keep their existing custom-command turn.start behavior.
    if (!builtin && !supported) return false;
    const available = currentCatalog ?? (onLoad ? await load() : undefined);
    const command = findSessionCommand(text, available);
    if (!builtin && !command) return false;
    if (command?.unavailableReason) throw new Error(command.unavailableReason);
    if (!supported || !onRun) throw new Error("当前电脑版本不支持会话命令，请更新 Bridge");
    if (hasAttachments) throw new Error("命令不能附带图片或文件，请先移除附件");
    const result = await onRun(text);
    if (activeKey.current !== sessionKey) return true;
    if (result.catalog) setCatalog({ key: sessionKey, value: result.catalog });
    if (result.action === "model") onModel();
    else if (result.action === "rename" && onRename) onRename();
    else if (result.action === "session" && result.session) await onSession(result.session.sessionId);
    else if (result.action !== "sent") setDialog(result);
    return true;
  }

  return { recognizes, execute, load: onLoad ? load : undefined, dialog, close: () => setDialog(undefined) };
}
