import type {
  BridgeAttachment,
  BridgeHistoryAttachment,
  BridgeHistoryItem,
  BridgeNativeImageRef,
  BridgeSubagentSummary,
  BridgeTaskPlan,
} from "@bridge/protocol";
import type { NativeDesktopReceipt } from "../controller/conversation-state-store.js";
import type { BridgeEventDraft } from "../controller/session-event-log.js";
import { extractInteractivePrompt, updateClaudeTaskPlan, visibleMessage } from "../transcript/claude-history.js";
import { summarizeNativeToolInput } from "../transcript/transcript-tool-detail.js";
import { NativeCallError } from "./claude-desktop-inspector.js";

export interface NativeMessageProjection {
  plan?: BridgeTaskPlan;
  planObserved?: boolean;
  tasks?: Map<string, BridgeSubagentSummary>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function nativePlanMessages(messages: unknown[]) {
  return messages.flatMap(raw => {
    const message = record(raw);
    if (message.isSidechain === true || message.parent_tool_use_id) return [];
    const body = record(message.message);
    return (Array.isArray(body.content) ? body.content : []).flatMap(rawBlock => {
      const block = record(rawBlock);
      if (block.type !== "tool_use" || typeof block.id !== "string" || !["mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up"].includes(String(block.name))) return [];
      return [{ type: message.type, timestamp: message.timestamp, message: { content: [block] } }];
    });
  });
}

/** Shared by history pages and live events; task state is projected from native messages. */
export function nativeHistoryItems(sessionId: string, messages: unknown[], projection: NativeMessageProjection = {}): BridgeHistoryItem[] {
  const items = new Map<string, BridgeHistoryItem>();
  for (const raw of messages) {
    const message = record(raw);
    if (message.isSidechain === true) continue;
    const body = record(message.message);
    const createdAt = typeof message.timestamp === "number" ? message.timestamp
      : typeof message.timestamp === "string" ? Date.parse(message.timestamp) || 0 : 0;
    if (message.type === "system" && typeof message.task_id === "string" && ["task_started", "task_progress", "task_notification"].includes(String(message.subtype))) {
      const tasks = projection.tasks ??= new Map();
      const previous = tasks.get(message.task_id);
      const status = message.subtype === "task_notification" ? message.status : "running";
      const state: BridgeSubagentSummary["state"] = status === "completed" || status === "failed" || status === "stopped" || status === "running" ? status : "unknown";
      const toolUseId = typeof message.tool_use_id === "string" ? message.tool_use_id : previous?.toolUseId;
      const task: BridgeSubagentSummary = {
        agentId: message.task_id, ...(toolUseId ? { toolUseId } : {}), state,
        ...(previous?.model ? { model: previous.model } : {}),
        description: typeof message.description === "string" ? message.description : previous?.description ?? "Agent",
        startedAt: previous?.startedAt ?? createdAt, updatedAt: createdAt,
        toolCount: typeof record(message.usage).tool_uses === "number" ? Number(record(message.usage).tool_uses) : previous?.toolCount ?? 0,
        ...(typeof message.summary === "string" ? { latestText: message.summary, ...(state !== "running" ? { reportText: message.summary } : {}) } : {}),
      };
      tasks.set(task.agentId, task);
      const id = toolUseId ?? task.agentId;
      items.set(id, { id, sessionId, role: "tool", toolName: "Agent", text: task.latestText ?? task.description, createdAt, origin: "claude-desktop", subagent: task });
    }
    if (message.parent_tool_use_id && (message.type === "assistant" || message.type === "user")) continue;
    const visible = visibleMessage(message);
    const interactivePrompt = extractInteractivePrompt(message);
    const id = message.type === "user" && typeof message.uuid === "string" ? message.uuid
      : typeof body.id === "string" ? body.id : typeof message.uuid === "string" ? message.uuid : undefined;
    const attachments: BridgeHistoryAttachment[] = [];
    if (visible?.role === "user" && typeof message.uuid === "string" && Array.isArray(body.content)) {
      let imageIndex = 0;
      for (const rawBlock of body.content) {
        const block = record(rawBlock);
        if (block.type !== "image") continue;
        const index = imageIndex++;
        const source = record(block.source);
        if (source.type !== "base64" || typeof source.data !== "string" || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(String(source.media_type))) continue;
        const mimeType = source.media_type as BridgeAttachment["mimeType"];
        attachments.push({
          id: `native-image:${message.uuid}:${index}`,
          name: typeof block.name === "string" ? block.name : typeof block.filename === "string" ? block.filename : `image-${index + 1}.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice(6)}`,
          mimeType, size: Math.floor(source.data.length * 3 / 4) - (source.data.endsWith("==") ? 2 : source.data.endsWith("=") ? 1 : 0),
          nativeImage: { messageUuid: message.uuid, imageIndex: index },
        });
      }
    }
    if (id && (visible?.role || interactivePrompt)) items.set(id, {
      id, sessionId, role: visible?.role ?? "assistant",
      text: attachments.length && Array.isArray(body.content)
        ? body.content.flatMap(block => typeof block === "string" ? [block] : record(block).type === "text" && typeof record(block).text === "string" ? [String(record(block).text)] : []).join("\n\n")
        : visible?.text ?? "", createdAt,
      origin: "claude-desktop", ...(attachments.length ? { attachments } : {}), ...(interactivePrompt ? { interactivePrompt } : {}),
    });
    if (Array.isArray(body.content)) for (const rawBlock of body.content) {
      const block = record(rawBlock);
      if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      if (block.name === "mcp__ccd_turn__update_plan" || block.name === "mcp__ccd_turn__wrap_up") {
        const wrapUp = block.name === "mcp__ccd_turn__wrap_up";
        const plan = updateClaudeTaskPlan(projection.plan, block.id, record(block.input), wrapUp, createdAt);
        if (plan || wrapUp) projection.planObserved = true;
        if (plan) {
          const planId = `plan:${plan.id}`;
          items.set(planId, { id: planId, sessionId, role: "assistant", text: "", createdAt: items.get(planId)?.createdAt ?? createdAt, origin: "claude-desktop", taskPlan: plan });
          projection.plan = plan;
        }
        if (wrapUp) delete projection.plan;
      } else items.set(block.id, { id: block.id, sessionId, role: "tool", toolName: block.name, text: summarizeNativeToolInput(block.name, block.input), createdAt, origin: "claude-desktop" });
    }
  }
  return [...items.values()];
}

export function enrichNativeSubagentItems(
  items: BridgeHistoryItem[],
  subagents: readonly BridgeSubagentSummary[] | undefined,
): void {
  if (!subagents?.length) return;
  for (const item of items) {
    if (!item.subagent && item.toolName !== "Agent" && item.toolName !== "Task") continue;
    const child = subagents.find(agent => agent.toolUseId === item.id || agent.agentId === item.subagent?.agentId);
    if (child?.model) {
      if (item.subagent) item.subagent.model = child.model;
      else item.subagent = child;
    }
  }
}

export function extractNativeImageAttachment(
  sessionId: string,
  messages: unknown[],
  ref: BridgeNativeImageRef,
): { artifactId: string; name: string; mimeType: string; bytes: Buffer } {
  const message = messages.find(raw => record(raw).type === "user" && record(raw).uuid === ref.messageUuid);
  const attachment = nativeHistoryItems(sessionId, [message])[0]?.attachments?.find(image => image.nativeImage?.imageIndex === ref.imageIndex);
  if (!attachment) throw new NativeCallError("Native image not found");
  const content = record(record(message).message).content as unknown[];
  const block = content.filter(raw => record(raw).type === "image")[ref.imageIndex];
  return {
    artifactId: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    bytes: Buffer.from(String(record(record(block).source).data), "base64"),
  };
}

export function nativeItemEventDraft(
  sessionId: string,
  item: BridgeHistoryItem,
  receipt: NativeDesktopReceipt | undefined,
): BridgeEventDraft {
  return {
    sessionId,
    itemId: item.id,
    ...(receipt ? { turnId: receipt.messageId } : {}),
    origin: "claude-desktop",
    type: item.role === "user"
      ? "user.message.accepted"
      : item.role === "tool"
        ? item.subagent
          ? item.subagent.state === "running"
            ? "tool.progress"
            : "tool.completed"
          : "tool.started"
        : "assistant.completed",
    data: {
      text: item.text,
      ...(item.attachments ? { attachments: item.attachments } : {}),
      ...(receipt ? { commandId: receipt.commandId, requestId: receipt.requestId, messageId: receipt.messageId, delivery: receipt.state === "dispatching" ? "host-received" : receipt.state } : {}),
      ...(item.toolName ? { toolName: item.toolName } : {}),
      ...(item.interactivePrompt ? { interactivePrompt: item.interactivePrompt } : {}),
      ...(item.taskPlan ? { taskPlan: item.taskPlan, taskPlanSource: "native-main" } : {}),
      ...(item.subagent ? { subagent: item.subagent } : {}),
    },
  };
}
