import type { BridgeSessionInfo } from "@bridge/protocol";
import { useEffect, useSyncExternalStore } from "react";

type SeenCompletions = Readonly<Record<string, string>>;
const empty: SeenCompletions = {};
const seenByHost = new Map<string, SeenCompletions>();
const listeners = new Set<() => void>();

function readSeenCompletions(key: string): SeenCompletions {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? empty;
  } catch {
    return empty;
  }
}

function seenCompletions(hostId: string): SeenCompletions {
  const cached = seenByHost.get(hostId);
  if (cached) return cached;
  const seen = readSeenCompletions(`bridge-seen-session-completions:${hostId}`);
  seenByHost.set(hostId, seen);
  return seen;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSeenSessionCompletions(hostId: string | undefined): SeenCompletions {
  return useSyncExternalStore(subscribe, () => hostId ? seenCompletions(hostId) : empty, () => empty);
}

export function useAcknowledgeSessionCompletion(hostId: string, session: BridgeSessionInfo, visible: boolean): void {
  const { sessionId, lastCompletedTurnId } = session;
  useEffect(() => {
    const completionId = lastCompletedTurnId;
    if (!visible || !hostId || !completionId || seenCompletions(hostId)[sessionId] === completionId) return;
    const key = `bridge-seen-session-completions:${hostId}`;
    const acknowledge = () => {
      if (document.visibilityState === "hidden") return;
      const seen = { ...seenCompletions(hostId), ...readSeenCompletions(key), [sessionId]: completionId };
      seenByHost.set(hostId, seen);
      try {
        localStorage.setItem(key, JSON.stringify(seen));
      } catch {
        // Keep the in-memory acknowledgement when storage is unavailable.
      }
      for (const listener of listeners) listener();
    }
    if (document.visibilityState !== "hidden") {
      acknowledge();
      return;
    }
    document.addEventListener("visibilitychange", acknowledge);
    return () => document.removeEventListener("visibilitychange", acknowledge);
  }, [hostId, lastCompletedTurnId, sessionId, visible]);
}
