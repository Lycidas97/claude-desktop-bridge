import { useState } from "react";

export function useSessionMenuAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run(failureMessage: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : failureMessage);
    } finally {
      setBusy(false);
    }
  }

  return { busy, setBusy, error, setError, run };
}
