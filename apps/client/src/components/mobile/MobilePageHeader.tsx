import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../common/IconButton.js";
import { useMobileNav } from "./MobileAppShell.js";

/**
 * Pushed mobile screens (`ConversationView`, `NewChatCanvas`, `助理`, `电脑`, `设置`,
 * and sub-pages) lead with a `←` Back button returning to their parent or the
 * Layer-1 Home Session List. A hidden title stays available to screen readers
 * and lets the subtitle lead.
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
  const effectiveOnBack = onBack ?? (nav && nav.tab !== "sessions" ? () => nav.onTabChange("sessions") : undefined);
  return (
    <header className={`m-header${!navigation ? " is-embedded" : effectiveOnBack ? " is-pushed" : ""}${leading ? " has-leading" : ""}${titleHidden ? " is-title-hidden" : ""}`}>
      {leading ?? (navigation && effectiveOnBack && (
        <IconButton label={backLabel} disabled={backDisabled} onClick={effectiveOnBack}>
          <ArrowLeft size={20} />
        </IconButton>
      ))}
      <div className="m-header-copy">
        <h1>{title}</h1>
        {subtitle && <div className="m-header-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="m-header-actions">{actions}</div>}
    </header>
  );
}
