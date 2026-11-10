import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

export interface SessionNotificationTarget {
  hostId: string;
  sessionId?: string;
}

const CHANNEL_ID = "bridge-sessions";
let permissionPromise: Promise<boolean> | undefined;

/**
 * Asks once per launch, while the app is in the foreground. Android 13+ shows
 * the POST_NOTIFICATIONS prompt; earlier versions grant it at install time.
 */
export function ensureSessionNotificationPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(false);
  permissionPromise ??= (async () => {
    let status = await LocalNotifications.checkPermissions();
    if (status.display === "prompt" || status.display === "prompt-with-rationale") {
      status = await LocalNotifications.requestPermissions();
    }
    if (status.display !== "granted") return false;
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
  if (!await ensureSessionNotificationPermission()) return;
  // One notification per session: a newer event replaces the previous one.
  let id = 0;
  for (const char of `${target.hostId}:${target.sessionId ?? ""}`) id = (Math.imul(id, 31) + char.charCodeAt(0)) | 0;
  await LocalNotifications.schedule({
    notifications: [{
      id: id & 0x7fffffff,
      title,
      body,
      channelId: CHANNEL_ID,
      isExactNotification: false,
      autoCancel: true,
      extra: target,
    }],
  });
}

export function onSessionNotificationTap(listener: (target: SessionNotificationTarget) => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => undefined;
  const handle = LocalNotifications.addListener("localNotificationActionPerformed", ({ notification }) => {
    listener(notification.extra as SessionNotificationTarget);
  });
  return () => void handle.then((registered) => registered.remove());
}
