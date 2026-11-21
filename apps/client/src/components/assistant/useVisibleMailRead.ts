import { useState } from "react";

/** Defer new reads while hidden without interrupting a read already in progress. */
export function useVisibleMailRead<T>(input: T | undefined, visible: boolean): T | undefined {
  const [scheduled, setScheduled] = useState(visible ? input : undefined);
  if (scheduled !== input && (visible || input === undefined)) setScheduled(input);
  return scheduled;
}
