import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MAIL_TOOLS, MailToolConnection } from "./tool-contract.js";

/** A protocol adapter only: no mail store, receiver, credentials or Desktop IPC imports. */
export function createMailMcpServer(connectionPath: string): Server {
  const server = new Server({ name: "assistant-mail", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: MAIL_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const connection = MailToolConnection.parse(JSON.parse(await readFile(connectionPath, "utf8")));
    const response = await fetch(`http://127.0.0.1:${connection.port}/tools`, {
      method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }),
      redirect: "error",
    });
    return { content: [{ type: "text", text: await response.text() }], ...(!response.ok ? { isError: true } : {}) };
  });
  return server;
}
