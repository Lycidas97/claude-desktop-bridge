import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMailMcpServer } from "./mcp.js";

if (!process.argv[2]) throw new Error("Usage: node mcp.cjs <private-mail-tools.json>");
const server = createMailMcpServer(process.argv[2]);
process.stdin.on("end", () => { void server.close(); });
void server.connect(new StdioServerTransport());
