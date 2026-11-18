import type { BridgeSessionInfo } from "@bridge/protocol";
import { useEffect, useState } from "react";

type SeenCompletions = Readonly<Record<string, string>>;
const empty: SeenCompletions = {};
const seenByHost = new Map<string, SeenCompletions>();
const listeners = new Set<() => void>();

function seenCompletions(hostId: string): SeenCompletions {
  const cached = seenByHost.get(hostId);
  if (cached) return cached;
  let seen = empty;
  try {
    seen = JSON.parse(localStorage.getItem(`bridge-seen-session-completions:${hostId}`) ?? "null") ?? empty;
  } catch {
    // An unavailable or malformed preference starts with nothing seen.
  }
  seenByHost.set(hostId, seen);
  return seen;
}

export function useSeenSessionCompletions(hostId: string | undefined): SeenCompletions {
  const seen = hostId ? seenCompletions(hostId) : empty;
  const [, setSeen] = useState(seen);
  useEffect(() => {
    if (!hostId) return;
    const update = () => setSeen(seenCompletions(hostId));
    listeners.add(update);
    update();
    return () => { listeners.delete(update); };
  }, [hostId]);
  return seen;
}

export function useAcknowledgeSessionCompletion(hostId: string, session: BridgeSessionInfo, visible: boolean): void {
  const { sessionId, lastCompletedTurnId } = session;
  useEffect(() => {
    if (!visible || !hostId || !lastCompletedTurnId || seenCompletions(hostId)[sessionId] === lastCompletedTurnId) return;
    function acknowledge() {
      if (document.visibilityState === "hidden") return;
      const seen = { ...seenCompletions(hostId), [sessionId]: lastCompletedTurnId! };
      seenByHost.set(hostId, seen);
      try {
        localStorage.setItem(`bridge-seen-session-completions:${hostId}`, JSON.stringify(seen));
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
