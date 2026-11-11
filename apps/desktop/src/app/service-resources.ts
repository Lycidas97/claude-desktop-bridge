/** The service owns these resources from acquisition through failed startup or exit. */
export class ServiceResources {
  private readonly cleanups: Array<{ name: string; close(): void | Promise<void> }> = [];
  private closing: Promise<void> | undefined;

  defer(name: string, close: () => void | Promise<void>): void {
    this.cleanups.push({ name, close });
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      const errors: Error[] = [];
      for (const cleanup of this.cleanups.reverse()) {
        try { await cleanup.close(); } catch (error) {
          errors.push(new Error(`${cleanup.name}: ${String(error)}`, { cause: error }));
        }
      }
      if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("\n"));
    })();
  }

  async fail(error: unknown): Promise<never> {
    try { await this.close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${String(error)}\nCleanup failed: ${String(cleanupError)}`, { cause: error });
    }
    throw error;
  }
}
