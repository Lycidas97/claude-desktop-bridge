import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { BridgeInspectorAlert, BridgeInspectorClient, BridgeInspectorStatus } from "@bridge/protocol";

const run = promisify(execFile);

/** lsof lists both ends: only sockets whose destination is the debug port are clients. */
export function parseInspectorSockets(output: string, port = 9229): { listening: boolean; clients: Array<{ pid: number; name: string }> } {
  let pid = 0;
  let name = "";
  let endpoint = "";
  let state = "";
  let listening = false;
  const clients = new Map<number, { pid: number; name: string }>();
  function socket() {
    if (state === "LISTEN" && !endpoint.includes("->") && endpoint.endsWith(`:${port}`)) listening = true;
    if (state === "ESTABLISHED" && endpoint.includes("->") && endpoint.endsWith(`:${port}`)) clients.set(pid, { pid, name });
    endpoint = "";
    state = "";
  }
  for (const line of output.split("\n")) {
    if (line[0] === "p") { socket(); pid = Number(line.slice(1)); name = ""; }
    else if (line[0] === "c") name = line.slice(1);
    else if (line[0] === "f") socket();
    else if (line[0] === "n") endpoint = line.slice(1);
    else if (line.startsWith("TST=")) state = line.slice(4);
  }
  socket();
  return { listening, clients: [...clients.values()] };
}

export async function readInspectorConnections({
  port = 9229,
  helperPath = fileURLToPath(new URL("./native/inspector-process-path", import.meta.url)).replace(/app\.asar\//u, "app.asar.unpacked/"),
}: { port?: number; helperPath?: string } = {}): Promise<{ listening: boolean; clients: BridgeInspectorClient[] }> {
  let output: string;
  try {
    output = (await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-FpcfnT"], { timeout: 2_500, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    if (failure.code === 1 && !failure.stderr?.trim() && !failure.stdout?.trim()) return { listening: false, clients: [] };
    throw error;
  }
  const sockets = parseInspectorSockets(output, port);
  if (!sockets.clients.length) return { listening: sockets.listening, clients: [] };
  const { stdout } = await run(helperPath, sockets.clients.map(({ pid }) => String(pid)), { timeout: 2_500, maxBuffer: 1024 * 1024 });
  // The native helper writes pid\0executablePath\0error\0 for each requested process.
  const fields = stdout.split("\0");
  const paths = new Map<number, { executablePath: string; pathError: string }>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    paths.set(Number(fields[index]), { executablePath: fields[index + 1]!, pathError: fields[index + 2]! });
  }
  const ownBundle = process.execPath.match(/^(.*\.app)\/Contents\//u)?.[1];
  const approvedRoots = ["/Applications/Bridge.app", "/Applications/Google Chrome.app", ...(ownBundle ? [ownBundle] : [])];
  return {
    listening: sockets.listening,
    clients: sockets.clients.map((client) => {
      const path = paths.get(client.pid);
      return {
        ...client,
        ...(path?.executablePath ? { executablePath: path.executablePath } : { pathError: path?.pathError || "无法获取可执行文件路径" }),
        approved: Boolean(path?.executablePath && approvedRoots.some((root) => path.executablePath.startsWith(`${root}/Contents/`))),
      };
    }),
  };
}

export class ClaudeInspectorMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private status: BridgeInspectorStatus;

  constructor(private readonly options: {
    onUpdate(status: BridgeInspectorStatus): void;
    onAlert(alert: BridgeInspectorAlert): string | undefined;
    scan?: () => Promise<{ listening: boolean; clients: BridgeInspectorClient[] }>;
    platform?: NodeJS.Platform;
    intervalMs?: number;
    port?: number;
  }) {
    this.status = { state: "starting", port: options.port ?? 9229, pollIntervalMs: options.intervalMs ?? 3_000, clients: [], alerts: [] };
  }

  async start(): Promise<void> {
    if ((this.options.platform ?? process.platform) !== "darwin") {
      this.status = { ...this.status, state: "unsupported" };
      this.options.onUpdate(this.status);
      return;
    }
    await this.poll();
  }

  notificationFailed(message: string): void {
    this.status = { ...this.status, notificationError: message };
    this.options.onUpdate(this.status);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private async poll(): Promise<void> {
    let next: BridgeInspectorStatus;
    try {
      const observed = await (this.options.scan ?? (() => readInspectorConnections({ port: this.status.port })))();
      if (this.closed) return;
      const alerts = [...this.status.alerts];
      let notificationError = this.status.notificationError;
      for (const client of observed.clients.filter((candidate) => !candidate.approved)) {
        if (this.status.clients.some((previous) => previous.pid === client.pid && previous.executablePath === client.executablePath && !previous.approved)) continue;
        const alert = { ...client, detectedAt: Date.now() };
        alerts.unshift(alert);
        notificationError = this.options.onAlert(alert);
      }
      next = {
        state: observed.listening ? "listening" : "closed", port: this.status.port, pollIntervalMs: this.status.pollIntervalMs,
        clients: observed.clients, alerts: alerts.slice(0, 20), ...(notificationError ? { notificationError } : {}),
      };
    } catch (error) {
      if (this.closed) return;
      next = { ...this.status, state: "error", clients: [], error: error instanceof Error ? error.message : String(error) };
    }
    if (JSON.stringify(next) !== JSON.stringify(this.status)) {
      this.status = next;
      this.options.onUpdate(next);
    }
    this.timer = setTimeout(() => void this.poll(), this.status.pollIntervalMs);
    this.timer.unref();
  }
}
