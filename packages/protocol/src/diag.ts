/**
 * Diagnostic-only stage recorder for the dogfood overlay build.
 * Records stage names and numbers; never payload content.
 */
export type DiagField = string | number | boolean | undefined;
type DiagLogger = (event: string, fields?: Record<string, DiagField>) => void;

let logger: DiagLogger | undefined;

export function setDiagLogger(next: DiagLogger | undefined): void {
  logger = next;
}

export function diag(event: string, fields?: Record<string, DiagField>): void {
  logger?.(event, fields);
}
