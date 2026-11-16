import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../common/IconButton.js";
import { MobileNavMenu, useMobileNav } from "./MobileAppShell.js";

/**
 * Root pages lead with the slide-over drawer menu button and a compact title;
 * pages pushed on top of a root show a back button. A hidden title stays
 * available to screen readers and lets the subtitle lead.
 */
export function MobilePageHeader({
  title,
  titleHidden = false,
  subtitle,
  leading,
  onBack,
  backLabel = "返回",
  backDisabled = false,
  actions,
  navigation = true,
}: {
  title: ReactNode;
  titleHidden?: boolean;
  subtitle?: ReactNode;
  leading?: ReactNode | undefined;
  onBack?(): void;
  backLabel?: string;
  backDisabled?: boolean;
  actions?: ReactNode;
  navigation?: boolean;
}) {
  const nav = useMobileNav();
  return (
    <header className={`m-header${!navigation ? " is-embedded" : onBack ? " is-pushed" : nav ? " has-menu" : ""}${leading ? " has-leading" : ""}${titleHidden ? " is-title-hidden" : ""}`}>
      {leading ?? (navigation && (onBack
        ? <IconButton label={backLabel} disabled={backDisabled} onClick={onBack}><ArrowLeft size={20} /></IconButton>
        : nav && <MobileNavMenu {...nav} />))}
      <div className="m-header-copy">
        <h1>{title}</h1>
        {subtitle && <div className="m-header-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="m-header-actions">{actions}</div>}
    </header>
  );
}
