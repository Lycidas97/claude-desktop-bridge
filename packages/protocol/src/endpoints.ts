import type { BridgeEndpoint, BridgeEndpointKind } from "./types.js";

export const DEFAULT_PUBLIC_RELAY_URL = "wss://bis.zju.edu.cn/bridge-relay/ws";
export const DEFAULT_BRIDGE_SERVICE_ORIGIN = "https://bis.zju.edu.cn";
export const RETIRED_DEFAULT_RELAY_URL = "wss://relay.alioxis.com/ws";

const RETIRED_DEFAULT_SERVICE_ORIGINS = new Set([
  "https://relay.alioxis.com",
  "https://bridge.alioxis.com",
]);

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second! >= 64 && second! <= 127)
  );
}

export function relayPathForUrl(value: string): Extract<BridgeEndpointKind, "public-relay" | "lan-relay"> {
  try {
    const url = new URL(value);
    const local = (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      isPrivateIpv4(url.hostname)
    );
    return local ? "lan-relay" : "public-relay";
  } catch {
    return "lan-relay";
  }
}

export function normalizeRelayUrl(value: string): string {
  const url = new URL(value.trim());
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password || url.hash) {
    throw new Error("中继地址须为 ws:// 或 wss://，不能包含用户名、密码或片段");
  }
  return url.toString();
}

export function relayServiceOrigin(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

export function isRetiredDefaultRelayUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return normalizeRelayUrl(value) === RETIRED_DEFAULT_RELAY_URL;
  } catch {
    return false;
  }
}

export function isRetiredDefaultServiceOrigin(value: string | undefined): boolean {
  const trimmed = value?.trim().replace(/\/+$/u, "");
  return trimmed ? RETIRED_DEFAULT_SERVICE_ORIGINS.has(trimmed.toLowerCase()) : false;
}

function relaySiblingHttpUrl(endpoint: string, leaf: "health" | "ready"): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = /\/ws\/?$/iu.test(url.pathname)
    ? url.pathname.replace(/\/ws\/?$/iu, `/${leaf}`)
    : `/${leaf}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function relayHealthUrl(endpoint: string): string {
  return relaySiblingHttpUrl(endpoint, "health");
}

export function relayReadyUrl(endpoint: string): string {
  return relaySiblingHttpUrl(endpoint, "ready");
}

export function bridgeEndpoint(
  url: string,
  priority: number,
  id = relayPathForUrl(url) === "public-relay" ? "public" : "lan",
): BridgeEndpoint {
  return {
    id,
    kind: relayPathForUrl(url),
    url,
    priority,
  };
}

export function isBridgeEndpoint(value: unknown): value is BridgeEndpoint {
  if (!value || typeof value !== "object") return false;
  const endpoint = value as Partial<BridgeEndpoint>;
  if (
    typeof endpoint.id !== "string" ||
    !["public-relay", "lan-relay", "direct"].includes(String(endpoint.kind)) ||
    typeof endpoint.url !== "string" ||
    typeof endpoint.priority !== "number" ||
    !Number.isFinite(endpoint.priority)
  ) return false;
  if (endpoint.kind === "direct") return true;
  try {
    const protocol = new URL(endpoint.url).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

export function normalizeBridgeEndpoints(endpoints: BridgeEndpoint[]): BridgeEndpoint[] {
  const byUrl = new Map<string, BridgeEndpoint>();
  for (const endpoint of endpoints.filter(isBridgeEndpoint)) {
    const previous = byUrl.get(endpoint.url);
    if (!previous || endpoint.priority < previous.priority) byUrl.set(endpoint.url, endpoint);
  }
  return [...byUrl.values()].sort((left, right) => (
    left.priority - right.priority || left.id.localeCompare(right.id)
  ));
}

export function selectBridgeEndpoint(
  endpoints: BridgeEndpoint[],
  activeEndpoint?: string,
): BridgeEndpoint | undefined {
  const normalized = normalizeBridgeEndpoints(endpoints);
  return normalized.find((endpoint) => endpoint.id === activeEndpoint) ?? normalized[0];
}
