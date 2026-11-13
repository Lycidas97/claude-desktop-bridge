import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_ICE_SERVERS,
  DEFAULT_BRIDGE_ICE_SERVERS_JSON,
  isLegacyCloudflareIceServers,
  preferredBridgeIceServers,
} from "./index.js";

describe("Bridge ICE defaults", () => {
  it("uses Cloudflare STUN as the packaged default without deriving relay or alioxis STUN", () => {
    expect(DEFAULT_BRIDGE_ICE_SERVERS).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
    ]);
    expect(JSON.parse(DEFAULT_BRIDGE_ICE_SERVERS_JSON)).toEqual(DEFAULT_BRIDGE_ICE_SERVERS);
  });

  it("does not add TURN credentials or TURN URLs to the packaged default", () => {
    expect(DEFAULT_BRIDGE_ICE_SERVERS.every((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return (
        !("username" in server) &&
        !("credential" in server) &&
        urls.every((url) => !/^turns?:/iu.test(url))
      );
    })).toBe(true);
  });

  it("converges both historical Cloudflare-only and retired alioxis+Cloudflare defaults while preserving custom ICE lists", () => {
    const legacyCloudflare = [{ urls: "stun:stun.cloudflare.com:3478" }];
    const retiredPair = [
      { urls: "stun:stun.alioxis.com:3478" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ];
    const customFallback = [{ urls: "stun:stun.custom-build.example:3478" }];
    const customStun = [{ urls: "stun:stun.example.net:3478" }];
    const singleAlioxis = [{ urls: "stun:stun.alioxis.com:3478" }];
    const reversedOrder = [
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.alioxis.com:3478" },
    ];
    const credentialedTurn = [
      { urls: "turn:stun.alioxis.com:3478", username: "bridge", credential: "secret" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ];

    expect(isLegacyCloudflareIceServers(legacyCloudflare)).toBe(true);
    expect(preferredBridgeIceServers(legacyCloudflare)).toEqual(DEFAULT_BRIDGE_ICE_SERVERS);
    expect(preferredBridgeIceServers(retiredPair)).toEqual(DEFAULT_BRIDGE_ICE_SERVERS);
    expect(preferredBridgeIceServers(retiredPair, customFallback)).toEqual(customFallback);
    expect(preferredBridgeIceServers(customStun)).toEqual(customStun);
    expect(preferredBridgeIceServers(singleAlioxis)).toEqual(singleAlioxis);
    expect(preferredBridgeIceServers(reversedOrder)).toEqual(reversedOrder);
    expect(preferredBridgeIceServers(credentialedTurn)).toEqual(credentialedTurn);
  });
});
