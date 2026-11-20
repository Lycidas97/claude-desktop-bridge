export class AssistantError extends Error {
  constructor(readonly code: "NOT_FOUND" | "CONFLICT" | "UNSUPPORTED" | "INVALID_PARAMS", message: string) { super(message); }
}
