import { describe, expect, it } from "vitest";
import { normalizeRelayUrl, relayServiceOrigin } from "./endpoints.js";

describe("manual relay addresses", () => {
  it("preserves ports, paths, and queries and derives a health origin", () => {
    const url = normalizeRelayUrl("  wss://relay.example:9443/custom/ws?region=one  ");
    expect(url).toBe("wss://relay.example:9443/custom/ws?region=one");
    expect(relayServiceOrigin(url)).toBe("https://relay.example:9443");
    expect(relayServiceOrigin("ws://192.168.1.2:8788/ws")).toBe("http://192.168.1.2:8788");
  });

  it.each(["", "https://relay.example/ws", "wss://", "wss://user:pass@relay.example/ws", "wss://relay.example/ws#fragment"])("rejects %s", (url) => {
    expect(() => normalizeRelayUrl(url)).toThrow();
  });
});
