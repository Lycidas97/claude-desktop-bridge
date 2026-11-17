import { useState } from "react";

export function useSessionMenuAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run(
    failureMessage: string,
    action: () => Promise<void>,
    setActionError: (error: string | undefined) => void = setError,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : failureMessage);
    } finally {
      setBusy(false);
    }
  }

  return { busy, setBusy, error, setError, run };
}
