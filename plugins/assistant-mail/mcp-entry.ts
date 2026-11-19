import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ASSISTANT_TOKEN_ENV } from "./fs-guard.js";
import { createMailMcpServer } from "./mcp.js";

const [connectionPath, mode] = process.argv.slice(2);
if (!connectionPath || (mode !== undefined && mode !== "--managed")) {
  throw new Error("Usage: node mcp.cjs <private-mail-tools.json> [--managed]");
}
const managedToken = mode === "--managed" ? process.env[ASSISTANT_TOKEN_ENV] : undefined;
if (mode === "--managed" && !managedToken) throw new Error("Managed assistant session token is required.");
const server = createMailMcpServer(connectionPath, managedToken);
process.stdin.on("end", () => { void server.close(); });
void server.connect(new StdioServerTransport());
