import { createContext, useContext, type ReactNode } from "react";
import { useAssistantMail } from "../assistant/AssistantMailProvider.js";

export type MobileTab = "sessions" | "assistant" | "computers" | "settings";

export interface MobileNav {
  assistantAvailable?: boolean | undefined;
  tab: MobileTab;
  onTabChange(tab: MobileTab): void;
}

const MobileNavContext = createContext<MobileNav | undefined>(undefined);

export function useMobileNav(): MobileNav | undefined {
  return useContext(MobileNavContext);
}

/**
 * Root mobile shell: Layer-1 full-screen Home Session List under `tab === "sessions"`,
 * with Layer-2 pushed screens (`ConversationView`, `NewChatCanvas`, `助理`, `电脑`, `设置`)
 * returning cleanly via header `←` Back or Android system Back.
 */
export function MobileAppShell({
  tab,
  onTabChange,
  assistantAvailable,
  children,
}: {
  tab: MobileTab;
  onTabChange(tab: MobileTab): void;
  assistantAvailable?: boolean | undefined;
  children: ReactNode;
}) {
  const assistant = useAssistantMail();
  const resolvedAssistant = assistantAvailable ?? Boolean(assistant);

  return (
    <MobileNavContext.Provider
      value={{
        tab,
        onTabChange,
        assistantAvailable: resolvedAssistant,
      }}
    >
      <div className="mobile-app-shell">
        <div className="mobile-app-content">{children}</div>
      </div>
    </MobileNavContext.Provider>
  );
}
