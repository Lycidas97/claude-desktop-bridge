/// <reference types="vite/client" />

import type { DesktopApi } from "@bridge/protocol";

declare const __BRIDGE_APP_VERSION__: string;

declare global {
  interface Window {
    bridgeDesktop?: DesktopApi;
  }
}

export {};
