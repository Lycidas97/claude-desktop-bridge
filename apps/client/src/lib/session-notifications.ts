import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

export interface SessionNotificationTarget {
  hostId: string;
  sessionId?: string;
}

export type SessionNotificationPermissionState = "granted" | "prompt" | "denied" | "unsupported";

export const SESSION_NOTIFICATIONS_PREF_KEY = "bridge-mobile-notifications:v1";

const CHANNEL_ID = "bridge-sessions";
let permissionPromise: Promise<boolean> | undefined;
let activeViewedSession: { hostId: string; sessionId: string } | undefined;

export function isSessionNotificationsEnabled(): boolean {
  try {
    if (typeof localStorage === "undefined") return true;
    const raw = localStorage.getItem(SESSION_NOTIFICATIONS_PREF_KEY);
    return raw !== "0" && raw !== "false";
  } catch {
    return true;
  }
}

export function setSessionNotificationsEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SESSION_NOTIFICATIONS_PREF_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage write failures in restricted WebViews.
  }
}

export function setActiveViewedSession(
  target: { hostId: string; sessionId: string } | undefined,
): void {
  activeViewedSession = target && target.hostId && target.sessionId
    ? { hostId: target.hostId, sessionId: target.sessionId }
    : undefined;
}

export function isActivelyViewingSession(hostId: string, sessionId?: string): boolean {
  if (!activeViewedSession || !sessionId) return false;
  return activeViewedSession.hostId === hostId && activeViewedSession.sessionId === sessionId;
}

export async function getSessionNotificationPermissionState(): Promise<SessionNotificationPermissionState> {
  if (Capacitor.isNativePlatform()) {
    try {
      const status = await LocalNotifications.checkPermissions();
      if (status.display === "granted") return "granted";
      if (status.display === "denied") return "denied";
      return "prompt";
    } catch {
      return "unsupported";
    }
  }
  if (typeof window !== "undefined" && window.bridgeDesktop) return "unsupported";
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return "prompt";
}

export async function requestSessionNotificationPermission(): Promise<"granted" | "denied" | "unsupported"> {
  if (Capacitor.isNativePlatform()) {
    try {
      let status = await LocalNotifications.checkPermissions();
      if (status.display !== "granted") {
        status = await LocalNotifications.requestPermissions();
      }
      if (status.display !== "granted") {
        permissionPromise = undefined;
        return "denied";
      }
      if (Capacitor.getPlatform() === "android") {
        await LocalNotifications.createChannel({ id: CHANNEL_ID, name: "会话动态", importance: 4 });
      }
      permissionPromise = Promise.resolve(true);
      return "granted";
    } catch {
      permissionPromise = undefined;
      return "unsupported";
    }
  }
  if (typeof window !== "undefined" && window.bridgeDesktop) return "unsupported";
  if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") {
    return "unsupported";
  }
  try {
    const result = await Notification.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

/**
 * Requests permission in the foreground and reuses a successful grant/channel.
 * An earlier denial must not hide a later grant from Android Settings.
 */
export function ensureSessionNotificationPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(false);
  permissionPromise ??= (async () => {
    let status = await LocalNotifications.checkPermissions();
    if (
      typeof document !== "undefined"
      && document.visibilityState === "visible"
      && (status.display === "prompt" || status.display === "prompt-with-rationale")
    ) {
      status = await LocalNotifications.requestPermissions();
    }
    if (status.display !== "granted") {
      permissionPromise = undefined;
      return false;
    }
    if (Capacitor.getPlatform() === "android") {
      await LocalNotifications.createChannel({ id: CHANNEL_ID, name: "会话动态", importance: 4 });
    }
    return true;
  })();
  return permissionPromise;
}

export async function showSessionNotification(
  target: SessionNotificationTarget,
  title: string,
  body: string,
): Promise<void> {
  if (!isSessionNotificationsEnabled()) return;
  if (Capacitor.isNativePlatform()) {
    if (!await ensureSessionNotificationPermission()) return;
    // One notification per session: a newer event replaces the previous one.
    let hash = 0;
    for (const char of `${target.hostId}:${target.sessionId ?? ""}`) {
      hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
    }
    const id = (hash & 0x7fffffff) || 1;
    await LocalNotifications.schedule({
      notifications: [{
        id,
        title,
        body,
        channelId: CHANNEL_ID,
        isExactNotification: false,
        autoCancel: true,
        extra: target,
      }],
    });
    return;
  }
  if (typeof window !== "undefined" && window.bridgeDesktop) return;
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, {
      body,
      icon: "/icon-192.png",
      tag: `${target.hostId}:${target.sessionId ?? ""}`,
    });
  }
}

export function onSessionNotificationTap(listener: (target: SessionNotificationTarget) => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => undefined;
  const handle = LocalNotifications.addListener("localNotificationActionPerformed", ({ notification }) => {
    listener(notification.extra as SessionNotificationTarget);
  });
  return () => void handle.then((registered) => registered.remove());
}
