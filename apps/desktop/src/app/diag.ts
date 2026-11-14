import { mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { diag, setDiagLogger } from "@bridge/protocol";

let fd: number | undefined;
let sequence = 0;

/** Diagnostic overlay recorder: stage names and numbers only, local file mode 0600. */
export function initDiag(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  fd = openSync(join(directory, "diag.log"), "a", 0o600);
  setDiagLogger((event, fields) => {
    const parts = [`seq=${++sequence}`, `up=${Math.round(process.uptime() * 1000)}`, `event=${event}`];
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) parts.push(`${key}=${String(value)}`);
      }
    }
    writeSync(fd!, `${new Date().toISOString()} [diag] ${parts.join(" ")}\n`);
  });
  setInterval(() => {
    const usage = process.memoryUsage();
    diag("tick", {
      heapMb: Math.round(usage.heapUsed / 1_048_576),
      rssMb: Math.round(usage.rss / 1_048_576),
    });
  }, 2_000);
}
