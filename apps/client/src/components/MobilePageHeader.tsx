import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "./IconButton.js";
import { MobileNavMenu, useMobileNav } from "./MobileAppShell.js";

/**
 * Root pages lead with the navigation menu and a large title; pages pushed on
 * top of a root show a back button with a compact title. A hidden title stays
 * available to screen readers and lets the subtitle lead. Trailing actions are
 * icon buttons only.
 */
export function MobilePageHeader({
  title,
  titleHidden = false,
  subtitle,
  onBack,
  backLabel = "返回",
  backDisabled = false,
  actions,
}: {
  title: ReactNode;
  titleHidden?: boolean;
  subtitle?: ReactNode;
  onBack?(): void;
  backLabel?: string;
  backDisabled?: boolean;
  actions?: ReactNode;
}) {
  const nav = useMobileNav();
  return (
    <header className={`m-header${onBack ? " is-pushed" : nav ? " has-menu" : ""}${titleHidden ? " is-title-hidden" : ""}`}>
      {onBack
        ? <IconButton label={backLabel} disabled={backDisabled} onClick={onBack}><ArrowLeft size={22} /></IconButton>
        : nav && <MobileNavMenu tab={nav.tab} onTabChange={nav.onTabChange} />}
      <div className="m-header-copy">
        <h1>{title}</h1>
        {subtitle && <div className="m-header-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="m-header-actions">{actions}</div>}
    </header>
  );
}
