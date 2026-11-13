import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";

export type MobileBackHandler = () => boolean;

interface MobileBackHandlerEntry {
  handler: MobileBackHandler;
  order: number;
  priority: number;
}

const handlers = new Map<symbol, MobileBackHandlerEntry>();
let nextOrder = 0;

export function registerMobileBackHandler(
  handler: MobileBackHandler,
  priority = 0,
): () => void {
  const id = Symbol("mobile-back-handler");
  handlers.set(id, { handler, priority, order: nextOrder++ });
  return () => {
    handlers.delete(id);
  };
}

export function dispatchMobileBack(): boolean {
  const ordered = [...handlers.values()].sort((left, right) => (
    right.priority - left.priority || right.order - left.order
  ));
  for (const entry of ordered) {
    if (entry.handler()) return true;
  }
  return false;
}

export function installMobileBackNavigation(): () => void {
  if (Capacitor.getPlatform() !== "android") return () => undefined;

  let disposed = false;
  let androidListener: PluginListenerHandle | undefined;

  void CapacitorApp.addListener("backButton", () => {
    if (!dispatchMobileBack()) void CapacitorApp.minimizeApp();
  }).then((listener) => {
    if (disposed) void listener.remove();
    else androidListener = listener;
  }).catch(() => undefined);

  return () => {
    disposed = true;
    void androidListener?.remove();
  };
}
