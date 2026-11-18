/** Error returned over the bridge RPC protocol with an explicit machine code. */
export class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

/** Reads a required or optional non-empty string RPC parameter. */
export function stringParam(params: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) return value;
  if (required) throw new Error(`${key} is required`);
  return undefined;
}

export function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function integerParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}
