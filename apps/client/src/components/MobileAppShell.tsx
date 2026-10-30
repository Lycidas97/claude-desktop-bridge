import { Laptop, MessageSquare, Settings } from "lucide-react";
import type { ReactNode } from "react";

export type MobileTab = "sessions" | "computers" | "settings";

const TABS = [
  { id: "sessions", label: "会话", icon: MessageSquare },
  { id: "computers", label: "电脑", icon: Laptop },
  { id: "settings", label: "设置", icon: Settings },
] as const;

export function MobileAppShell({
  tab,
  fullscreen,
  onTabChange,
  children,
}: {
  tab: MobileTab;
  fullscreen: boolean;
  onTabChange(tab: MobileTab): void;
  children: ReactNode;
}) {
  return (
    <div className={`mobile-app-shell${fullscreen ? " is-fullscreen" : ""}`}>
      <div className="mobile-app-content">{children}</div>
      {!fullscreen && (
        <nav className="mobile-tabbar" aria-label="主要导航">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              className={tab === id ? "is-active" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => onTabChange(id)}
            >
              <Icon size={21} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
