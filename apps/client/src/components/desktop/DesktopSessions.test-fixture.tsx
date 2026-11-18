import type { ComponentProps } from "react";
import { DesktopConversationProvider } from "./DesktopSessionConversation.js";
import { DesktopSessions } from "./DesktopSessionsPane.js";

type ProviderValue = { type: unknown; props: { value: unknown } };
let conversationProvider: ProviderValue | undefined;

export function readDesktopConversationTestContext(context: unknown): unknown {
  return conversationProvider?.type === context ? conversationProvider?.props.value : undefined;
}

// These sidebar tests call components with a mocked React hook store.
export function renderDesktopSessions(props: ComponentProps<typeof DesktopSessions>) {
  conversationProvider = DesktopConversationProvider({ ...props, children: null });
  try {
    return DesktopSessions(props);
  } finally {
    conversationProvider = undefined;
  }
}
