import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ASSISTANT_MCP, ASSISTANT_TOKEN_ENV } from "./fs-guard.js";
import { MailToolConnection } from "./tool-contract.js";

const CliSessionId = z.string().uuid();
export const CompactHookRequest = z.discriminatedUnion("event", [
  z.object({ event: z.literal("PreCompact"), cliSessionId: CliSessionId, trigger: z.enum(["manual", "auto"]) }).strict(),
  z.object({ event: z.literal("PostCompact"), cliSessionId: CliSessionId, trigger: z.enum(["manual", "auto"]) }).strict(),
  z.object({ event: z.literal("SessionStart"), cliSessionId: CliSessionId, source: z.literal("compact") }).strict(),
]);

export async function runAssistantCompactHook(workspace: string): Promise<void> {
  let stdin = "";
  for await (const chunk of process.stdin.setEncoding("utf8")) stdin += chunk;
  const hook = JSON.parse(stdin) as Record<string, unknown>;
  const result = CompactHookRequest.safeParse({ event: hook.hook_event_name, cliSessionId: hook.session_id,
    ...(hook.hook_event_name === "SessionStart" ? { source: hook.source } : { trigger: hook.trigger }),
  });
  if (!result.success) return;
  const config = JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { env?: Record<string, string> }>;
  };
  const token = config.mcpServers?.[ASSISTANT_MCP]?.env?.[ASSISTANT_TOKEN_ENV];
  if (!token) return;
  const { port } = MailToolConnection.pick({ port: true }).strip().parse(JSON.parse(
    await readFile(join(dirname(workspace), "mail-tools.json"), "utf8"),
  ));
  const response = await fetch(`http://127.0.0.1:${port}/hooks/compact`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Bridge-Assistant-Managed": "1" },
    body: JSON.stringify(result.data), redirect: "error", signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) return;
  const { context } = z.object({ context: z.string().optional() }).parse(await response.json());
  if (context) process.stdout.write(context);
}
