import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MAIL_TOOLS, MANAGED_MAIL_TOOLS, MailToolConnection } from "./tool-contract.js";

const ManagedDescriptor = MailToolConnection.pick({ port: true }).strip();

/** A protocol adapter only: no mail store, receiver, credentials or Desktop IPC imports. */
export function createMailMcpServer(connectionPath: string, managedToken?: string, memory = false): Server {
  const server = new Server({ name: "assistant-mail", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: MAIL_TOOLS.filter(tool => managedToken
    ? memory || tool.name !== "memory.lookup_entry" : !MANAGED_MAIL_TOOLS.has(tool.name)) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const descriptor: unknown = JSON.parse(await readFile(connectionPath, "utf8"));
    const connection = managedToken === undefined ? MailToolConnection.parse(descriptor) : {
      ...ManagedDescriptor.parse(descriptor), token: managedToken,
    };
    const response = await fetch(`http://127.0.0.1:${connection.port}/tools`, {
      method: "POST", headers: {
        Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json",
        ...(managedToken === undefined ? {} : { "X-Bridge-Assistant-Managed": "1" }),
      },
      body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }),
      redirect: "error",
    });
    return { content: [{ type: "text", text: await response.text() }], ...(!response.ok ? { isError: true } : {}) };
  });
  return server;
}
