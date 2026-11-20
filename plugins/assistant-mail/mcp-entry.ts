import { readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ASSISTANT_TOKEN_ENV } from "./fs-guard.js";
import { createMailMcpServer } from "./mcp.js";
import { MAIL_TOOLS_STOP_SUFFIX } from "./tool-contract.js";

const [connectionPath, mode] = process.argv.slice(2);
if (!connectionPath || (mode !== undefined && mode !== "--managed" && mode !== "--managed-memory")) {
  throw new Error("Usage: node mcp.cjs <private-mail-tools.json> [--managed|--managed-memory]");
}
const managedToken = mode ? process.env[ASSISTANT_TOKEN_ENV] : undefined;
if (mode && !managedToken) throw new Error("Managed assistant session token is required.");
const server = createMailMcpServer(connectionPath, managedToken, mode === "--managed-memory");
if (mode) {
  const marker = connectionPath + MAIL_TOOLS_STOP_SUFFIX;
  const checkStopped = () => {
    try {
      if (readFileSync(marker, "utf8") === "stopped") process.exit(0);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };
  const watcher = watch(dirname(marker), { persistent: false }, (_event, name) => {
    if (name === null || name === basename(marker)) checkStopped();
  });
  checkStopped();
  process.stdin.once("end", () => watcher.close());
}
process.stdin.once("end", () => { void server.close(); });
void server.connect(new StdioServerTransport());
