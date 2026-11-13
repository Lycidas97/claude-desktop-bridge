import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_SERVICE_ORIGIN,
  DEFAULT_PUBLIC_RELAY_URL,
  RETIRED_DEFAULT_RELAY_URL,
  isRetiredDefaultRelayUrl,
  isRetiredDefaultServiceOrigin,
  normalizeRelayUrl,
  relayHealthUrl,
  relayReadyUrl,
  relayServiceOrigin,
} from "./endpoints.js";

describe("manual relay addresses", () => {
  it("preserves ports, paths, and queries and derives an origin without path prefixes", () => {
    const url = normalizeRelayUrl("  wss://relay.example:9443/custom/ws?region=one  ");
    expect(url).toBe("wss://relay.example:9443/custom/ws?region=one");
    expect(relayServiceOrigin(url)).toBe("https://relay.example:9443");
    expect(relayServiceOrigin(DEFAULT_PUBLIC_RELAY_URL)).toBe(DEFAULT_BRIDGE_SERVICE_ORIGIN);
    expect(relayServiceOrigin("ws://192.168.1.2:8788/ws")).toBe("http://192.168.1.2:8788");
  });

  it("derives sibling health and ready URLs while preserving subpath prefixes and ports", () => {
    expect(relayHealthUrl(DEFAULT_PUBLIC_RELAY_URL)).toBe("https://bis.zju.edu.cn/bridge-relay/health");
    expect(relayReadyUrl(DEFAULT_PUBLIC_RELAY_URL)).toBe("https://bis.zju.edu.cn/bridge-relay/ready");
    expect(relayHealthUrl("wss://relay.example:9443/bridge-relay/ws/?region=1#frag"))
      .toBe("https://relay.example:9443/bridge-relay/health");
    expect(relayReadyUrl("wss://relay.example:9443/bridge-relay/ws/?region=1#frag"))
      .toBe("https://relay.example:9443/bridge-relay/ready");
    expect(relayHealthUrl("ws://192.168.1.2:8788/ws")).toBe("http://192.168.1.2:8788/health");
    expect(relayReadyUrl("ws://192.168.1.2:8788/socket")).toBe("http://192.168.1.2:8788/ready");
  });

  it("matches only the exact retired default relay and retired default service origins", () => {
    expect(isRetiredDefaultRelayUrl(RETIRED_DEFAULT_RELAY_URL)).toBe(true);
    expect(isRetiredDefaultRelayUrl("  wss://relay.alioxis.com/ws  ")).toBe(true);
    expect(isRetiredDefaultRelayUrl("wss://relay.alioxis.uk/ws")).toBe(false);
    expect(isRetiredDefaultRelayUrl("wss://relay.alioxis.com:9443/ws")).toBe(false);
    expect(isRetiredDefaultRelayUrl("wss://relay.alioxis.com/custom/ws")).toBe(false);
    expect(isRetiredDefaultRelayUrl(DEFAULT_PUBLIC_RELAY_URL)).toBe(false);

    expect(isRetiredDefaultServiceOrigin("https://relay.alioxis.com")).toBe(true);
    expect(isRetiredDefaultServiceOrigin("https://bridge.alioxis.com/")).toBe(true);
    expect(isRetiredDefaultServiceOrigin("https://relay.alioxis.uk")).toBe(false);
    expect(isRetiredDefaultServiceOrigin(DEFAULT_BRIDGE_SERVICE_ORIGIN)).toBe(false);
  });

  it.each(["", "https://relay.example/ws", "wss://", "wss://user:pass@relay.example/ws", "wss://relay.example/ws#fragment"])("rejects %s", (url) => {
    expect(() => normalizeRelayUrl(url)).toThrow();
  });
});
