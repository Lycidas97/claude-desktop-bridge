/// <reference types="vite/client" />

import type { DesktopApi } from "@bridge/protocol";

declare global {
  interface Window {
    bridgeDesktop?: DesktopApi;
  }
}

export {};
