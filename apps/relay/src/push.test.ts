import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentPushDispatcher, fcmWakeRequestBody } from "./push.js";
import type { DeviceRecord } from "./store.js";

afterEach(() => vi.unstubAllGlobals());

describe("content-free push wake payloads", () => {
  it("contains only a wake marker for Android", () => {
    const payload = fcmWakeRequestBody("device-token");
    expect(payload).toEqual({
      message: {
        token: "device-token",
        data: { type: "bridge-wake" },
        android: { priority: "high" },
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/session|title|body|message text/iu);
  });

  it("uses RS256 OAuth and caches the access token while sending only Android wake markers", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token", expires_in: 3_600 })))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const dispatcher = new EnvironmentPushDispatcher({
      BRIDGE_FCM_PROJECT_ID: "fixture-project",
      BRIDGE_FCM_CLIENT_EMAIL: "fixture@example.com",
      BRIDGE_FCM_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const device: DeviceRecord = {
      roomId: "room", deviceId: "android-1", role: "mobile", authHash: "hash",
      createdAt: 1, expiresAt: Date.now() + 60_000,
      pushPlatform: "android", pushToken: "android-token-1",
    };

    // Retained iOS records never use the configured FCM service.
    expect(await dispatcher.wake({ ...device, pushPlatform: "ios" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await dispatcher.wake({ ...device, deviceId: "android-2" })).toBe(true);
    expect(await dispatcher.wake({ ...device, deviceId: "android-3", pushToken: "android-token-2" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [oauthUrl, oauthRequest] = fetchMock.mock.calls[0]!;
    expect(oauthUrl).toBe("https://oauth2.googleapis.com/token");
    const assertion = (oauthRequest!.body as URLSearchParams).get("assertion")!;
    const [header, payload, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
      iss: "fixture@example.com", scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    for (const [index, token] of ["android-token-1", "android-token-2"].entries()) {
      const [url, request] = fetchMock.mock.calls[index + 1]!;
      expect(url).toBe("https://fcm.googleapis.com/v1/projects/fixture-project/messages:send");
      expect(request!.headers).toMatchObject({ authorization: "Bearer access-token" });
      expect(JSON.parse(request!.body as string)).toEqual(fcmWakeRequestBody(token));
    }
  });
});
