import { diagnostics } from "../app/diag.js";
import { scanClaudeContextFromMessages } from "../transcript/transcript-context.js";
import { isRecord } from "../transcript/transcript-dag.js";
import { NativeCallError, type ClaudeDesktopInspector } from "./claude-desktop-inspector.js";
import { projectContextMessages } from "./native-context-usage.js";
import { nativePlanMessages } from "./native-history-projection.js";

async function readTranscriptPage(inspector: Pick<ClaudeDesktopInspector, "call">, sessionId: string, cursor: string, limit: number) {
  const page = await inspector.call("getTranscriptPage", [sessionId, cursor, limit, { window: "accept" }]);
  if (!isRecord(page) || !Array.isArray(page.messages)) return undefined;
  const messages: unknown[] = page.messages;
  const hasMore = page.hasMore === true;
  const first = messages[0];
  const nextCursor = hasMore && isRecord(first) && typeof first.uuid === "string" ? first.uuid : undefined;
  return { messages, hasMore, nextCursor };
}

function startsPlan(block: Record<string, unknown>): boolean {
  return isRecord(block.input) && ["first_task", "new_task"].includes(String(block.input.scope));
}

export async function readNativeHistoryPage(
  inspector: Pick<ClaudeDesktopInspector, "call">,
  sessionId: string,
  cursor: string | undefined,
  limit: number,
  planObserved: () => boolean | undefined,
) {
  const page = await readTranscriptPage(inspector, sessionId, cursor ?? "", limit);
  if (!page) throw new NativeCallError("Desktop returned an invalid transcript page");

  const firstPlan = nativePlanMessages(page.messages)[0]?.message.content[0];
  const plainLatestWithKnownPlan = !cursor && !firstPlan && planObserved();
  let needsEarlierPlan = firstPlan
    ? !(firstPlan.name === "mcp__ccd_turn__update_plan" && startsPlan(firstPlan))
    : !cursor && !plainLatestWithKnownPlan;
  const earlierPlanMessages: unknown[] = [];
  const olderContextPages: unknown[][] = [];
  let before = page.nextCursor;
  while (needsEarlierPlan && before) {
    diagnostics.count("history.planPage");
    const older = await readTranscriptPage(inspector, sessionId, before, limit);
    if (!older) throw new NativeCallError("Desktop returned an invalid transcript page");
    if (!cursor) olderContextPages.unshift(projectContextMessages(older.messages));
    for (const message of nativePlanMessages(older.messages).reverse()) {
      const block = message.message.content[0]!;
      earlierPlanMessages.unshift(message);
      if (block.name === "mcp__ccd_turn__wrap_up" || startsPlan(block)) {
        needsEarlierPlan = false;
        break;
      }
    }
    before = older.nextCursor;
  }

  return {
    page,
    earlierPlanMessages,
    async readContextMessages(): Promise<unknown[]> {
      let combined = [...olderContextPages.flat(), ...page.messages];
      let scan = scanClaudeContextFromMessages(combined);
      // Preserve estimated usage at session.open's 18-message default when plan recovery was skipped.
      const canLookBack = plainLatestWithKnownPlan || (page.messages.length >= limit && limit >= 20);
      let olderCursor = before;
      for (let hop = 0; !scan.anchored && olderCursor && canLookBack && hop < 8; hop += 1) {
        diagnostics.count("history.planPage");
        const older = await readTranscriptPage(inspector, sessionId, olderCursor, Math.max(limit, 100));
        if (!older) break;
        combined = [...projectContextMessages(older.messages), ...combined];
        scan = scanClaudeContextFromMessages(combined);
        olderCursor = older.nextCursor;
      }
      return combined;
    },
  };
}
