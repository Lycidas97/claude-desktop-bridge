import { createSign } from "node:crypto";
import type { DeviceRecord } from "./store.js";

export interface PushDispatcher {
  wake(device: DeviceRecord): Promise<boolean>;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function jwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: string,
): string {
  const body = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(body);
  signer.end();
  return `${body}.${base64url(signer.sign(privateKey))}`;
}

interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export function fcmWakeRequestBody(pushToken: string): Record<string, unknown> {
  return {
    message: {
      token: pushToken,
      data: { type: "bridge-wake" },
      android: { priority: "high" },
    },
  };
}

function envValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.replaceAll("\\n", "\n").trim();
  return value || undefined;
}

export class EnvironmentPushDispatcher implements PushDispatcher {
  private readonly fcm: FcmConfig | undefined;
  private fcmAccessToken: { value: string; expiresAt: number } | undefined;
  private readonly lastWake = new Map<string, number>();

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const projectId = envValue(environment, "BRIDGE_FCM_PROJECT_ID");
    const clientEmail = envValue(environment, "BRIDGE_FCM_CLIENT_EMAIL");
    const fcmPrivateKey = envValue(environment, "BRIDGE_FCM_PRIVATE_KEY");
    if (projectId && clientEmail && fcmPrivateKey) {
      this.fcm = { projectId, clientEmail, privateKey: fcmPrivateKey };
    }
  }

  async wake(device: DeviceRecord): Promise<boolean> {
    if (!device.pushPlatform || !device.pushToken || device.revokedAt) return false;
    const key = `${device.roomId}:${device.deviceId}`;
    const now = Date.now();
    if (now - (this.lastWake.get(key) ?? 0) < 15_000) return false;
    this.lastWake.set(key, now);
    try {
      if (device.pushPlatform === "android" && this.fcm) return await this.wakeFcm(device.pushToken);
    } catch {
      return false;
    }
    return false;
  }

  private async fcmToken(): Promise<string> {
    if (this.fcmAccessToken && this.fcmAccessToken.expiresAt > Date.now() + 60_000) {
      return this.fcmAccessToken.value;
    }
    const now = Math.floor(Date.now() / 1_000);
    const assertion = jwt(
      { alg: "RS256", typ: "JWT" },
      {
        iss: this.fcm!.clientEmail,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3_600,
      },
      this.fcm!.privateKey,
    );
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) throw new Error(`FCM OAuth failed: ${response.status}`);
    const value = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof value.access_token !== "string") throw new Error("FCM OAuth did not return a token");
    const expiresIn = typeof value.expires_in === "number" ? value.expires_in : 3_600;
    this.fcmAccessToken = {
      value: value.access_token,
      expiresAt: Date.now() + expiresIn * 1_000,
    };
    return value.access_token;
  }

  private async wakeFcm(pushToken: string): Promise<boolean> {
    const accessToken = await this.fcmToken();
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.fcm!.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(fcmWakeRequestBody(pushToken)),
      },
    );
    return response.ok;
  }
}
