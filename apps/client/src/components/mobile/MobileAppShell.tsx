import { Check, Laptop, Menu, MessageSquare, Settings } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { IconButton } from "../common/IconButton.js";

export type MobileTab = "sessions" | "computers" | "settings";

const TABS = [
  { id: "sessions", label: "会话", icon: MessageSquare },
  { id: "computers", label: "电脑", icon: Laptop },
  { id: "settings", label: "设置", icon: Settings },
] as const;

interface MobileNav {
  tab: MobileTab;
  onTabChange(tab: MobileTab): void;
}

const MobileNavContext = createContext<MobileNav | undefined>(undefined);

export function useMobileNav(): MobileNav | undefined {
  return useContext(MobileNavContext);
}

/**
 * Top-level destinations live behind the menu button that leads every root
 * page header, so content keeps the whole screen height.
 */
export function MobileAppShell({ tab, onTabChange, children }: MobileNav & { children: ReactNode }) {
  return (
    <MobileNavContext.Provider value={{ tab, onTabChange }}>
      <div className="mobile-app-shell">
        <div className="mobile-app-content">{children}</div>
      </div>
    </MobileNavContext.Provider>
  );
}

export function MobileNavMenu({ tab, onTabChange }: MobileNav) {
  const [position, setPosition] = useState<{ top: number; left: number }>();

  useEffect(() => {
    if (!position) return;
    return registerMobileBackHandler(() => {
      setPosition(undefined);
      return true;
    }, 300);
  }, [position]);

  return (
    <>
      <IconButton
        label="菜单"
        aria-expanded={Boolean(position)}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition(position ? undefined : { top: rect.bottom + 6, left: Math.max(8, rect.left) });
        }}
      >
        <Menu size={22} />
      </IconButton>
      {position && createPortal(
        <div className="m-nav-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPosition(undefined);
        }}>
          <nav className="m-nav-menu" aria-label="主要导航" style={position}>
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className={tab === id ? "is-active" : ""}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => {
                  setPosition(undefined);
                  onTabChange(id);
                }}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
                {tab === id && <Check size={18} aria-hidden="true" />}
              </button>
            ))}
          </nav>
        </div>,
        document.body,
      )}
    </>
  );
}
