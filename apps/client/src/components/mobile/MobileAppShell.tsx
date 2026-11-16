import { Menu } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ThemeControl } from "../../hooks/useTheme.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { useAssistantMail } from "../assistant/AssistantMailProvider.js";
import { IconButton } from "../common/IconButton.js";
import { ThemeMenu } from "../common/ThemeMenu.js";

export type MobileTab = "sessions" | "assistant" | "computers" | "settings";

export interface MobileNav {
  assistantAvailable?: boolean | undefined;
  tab: MobileTab;
  drawerOpen?: boolean | undefined;
  setDrawerOpen?: ((open: boolean | ((current: boolean) => boolean)) => void) | undefined;
  onTabChange(tab: MobileTab): void;
}

const MobileNavContext = createContext<MobileNav | undefined>(undefined);

export function useMobileNav(): MobileNav | undefined {
  return useContext(MobileNavContext);
}

/**
 * Root mobile shell with slide-over drawer state shared across conversation,
 * new-chat, assistant, computers, and settings views.
 */
export function MobileAppShell({
  tab,
  onTabChange,
  assistantAvailable,
  hasWorkspaceDrawer = true,
  themeControl,
  children,
}: {
  tab: MobileTab;
  onTabChange(tab: MobileTab): void;
  assistantAvailable?: boolean | undefined;
  hasWorkspaceDrawer?: boolean | undefined;
  themeControl?: ThemeControl | undefined;
  children: ReactNode;
}) {
  const assistant = useAssistantMail();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!drawerOpen) return;
    return registerMobileBackHandler(() => {
      setDrawerOpen(false);
      return true;
    }, 50);
  }, [drawerOpen]);

  useEffect(() => {
    if (
      !drawerOpen
      || typeof window === "undefined"
      || typeof window.addEventListener !== "function"
      || typeof document === "undefined"
      || typeof document.querySelector !== "function"
    ) {
      return;
    }
    const opener = document.activeElement && "focus" in document.activeElement
      ? (document.activeElement as HTMLElement)
      : null;
    const drawer = document.querySelector<HTMLElement>(".mobile-drawer.is-open");
    const contentRoot = document.querySelector<HTMLElement>(".mobile-app-content");
    const inerted: Array<{ el: HTMLElement; hadAriaHidden: boolean }> = [];
    if (contentRoot && typeof contentRoot.querySelectorAll === "function") {
      const candidates = contentRoot.querySelectorAll<HTMLElement>(
        ":scope > main, :scope > section, :scope > * > .mobile-tab-page:not([hidden]), :scope > * > main, :scope > * > section",
      );
      for (const child of Array.from(candidates)) {
        if (drawer && (child.contains(drawer) || drawer.contains(child))) continue;
        if (!child.inert) {
          const hadAriaHidden = child.hasAttribute("aria-hidden");
          child.inert = true;
          if (!hadAriaHidden) child.setAttribute("aria-hidden", "true");
          inerted.push({ el: child, hadAriaHidden });
        }
      }
    }
    drawer?.focus?.({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const activeDrawer = document.querySelector<HTMLElement>(".mobile-drawer.is-open");
      if (!activeDrawer) return;
      if (document.querySelector('[role="dialog"]:not(.mobile-drawer), [role="alertdialog"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDrawerOpen(false);
        return;
      }
      if (event.key === "Tab") {
        const controls = Array.from(
          activeDrawer.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter((el) => !el.closest("[inert], [hidden]"));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) {
          event.preventDefault();
          activeDrawer.focus?.({ preventScroll: true });
          return;
        }
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey && (!active || active === activeDrawer || active === first || !activeDrawer.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!active || active === last || !activeDrawer.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      for (const { el, hadAriaHidden } of inerted) {
        el.inert = false;
        if (!hadAriaHidden) el.removeAttribute("aria-hidden");
      }
      const active = document.activeElement;
      if (
        opener?.isConnected
        && !opener.closest?.("[inert], [hidden]")
        && (!active || active === document.body || active === document.documentElement || Boolean(drawer?.contains(active)))
      ) {
        opener.focus?.({ preventScroll: true });
      }
    };
  }, [drawerOpen]);

  const resolvedAssistant = assistantAvailable ?? Boolean(assistant);

  return (
    <MobileNavContext.Provider
      value={{
        tab,
        drawerOpen,
        setDrawerOpen,
        onTabChange: (next) => {
          setDrawerOpen(false);
          onTabChange(next);
        },
        assistantAvailable: resolvedAssistant,
      }}
    >
      <div className="mobile-app-shell">
        <div className="mobile-app-content">{children}</div>
        {!hasWorkspaceDrawer && (
          <>
            {drawerOpen && (
              <div
                className="mobile-drawer-scrim"
                role="presentation"
                onClick={() => setDrawerOpen(false)}
              />
            )}
            <div
              className={`mobile-drawer is-flat-tree${drawerOpen ? " is-open" : ""}`}
              role={drawerOpen ? "dialog" : undefined}
              aria-modal={drawerOpen ? "true" : undefined}
              aria-label="导航抽屉"
              aria-hidden={!drawerOpen || undefined}
              inert={!drawerOpen}
              tabIndex={-1}
            >
              <div className="drawer-project-list host-detail" />
              <footer className="mobile-drawer-dock">
                <nav className="mobile-drawer-dock-nav" aria-label="主要导航">
                  <button
                    type="button"
                    className={`mobile-dock-link${tab === "computers" ? " active" : ""}`}
                    aria-current={tab === "computers" ? "page" : undefined}
                    onClick={() => {
                      setDrawerOpen(false);
                      onTabChange("computers");
                    }}
                  >
                    电脑
                  </button>
                  <button
                    type="button"
                    className={`mobile-dock-link${tab === "settings" ? " active" : ""}`}
                    aria-current={tab === "settings" ? "page" : undefined}
                    onClick={() => {
                      setDrawerOpen(false);
                      onTabChange("settings");
                    }}
                  >
                    设置
                  </button>
                </nav>
                {themeControl && <ThemeMenu control={themeControl} side="right" iconSize={16} />}
              </footer>
            </div>
          </>
        )}
      </div>
    </MobileNavContext.Provider>
  );
}

export function MobileNavMenu({ drawerOpen, setDrawerOpen }: MobileNav) {
  return (
    <IconButton
      label="菜单"
      aria-expanded={Boolean(drawerOpen)}
      onClick={() => setDrawerOpen?.((current) => !current)}
    >
      <Menu size={20} />
    </IconButton>
  );
}
