import { X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton.js";

/**
 * The shared overlay for object actions, forms and prompts: a bottom sheet
 * with a title, a scrolling body and optional footer actions. Destructive
 * confirmations stay in ConfirmationDialog so they read as interruptions.
 */
export function Sheet({
  eyebrow,
  title,
  busy = false,
  manageFocus = false,
  focusPaused = false,
  fullScreen = false,
  className,
  closeLabel = "关闭",
  onClose,
  children,
  footer,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  busy?: boolean;
  manageFocus?: boolean;
  focusPaused?: boolean;
  fullScreen?: boolean;
  className?: string;
  closeLabel?: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!manageFocus || typeof document === "undefined") return;
    const sheet = sheetRef.current;
    const opener = document.activeElement as HTMLElement | null;
    sheet?.focus();
    return () => {
      const active = document.activeElement;
      if (
        opener?.isConnected
        && (!active || active === document.body || active === document.documentElement || Boolean(sheet?.contains(active)))
      ) {
        opener.focus();
      }
    };
  }, [manageFocus]);
  return createPortal(
    <div
      className="m-sheet-backdrop"
      role="presentation"
      aria-hidden={focusPaused || undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && !focusPaused) onClose();
      }}
    >
      <section ref={sheetRef} className={`m-sheet${fullScreen ? " is-fullscreen" : ""}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex={manageFocus ? -1 : undefined}
        onKeyDown={(event) => {
          if (!manageFocus || focusPaused) return;
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === "Tab") {
            const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]');
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (!first || !last) return;
            if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}>
        <header className="m-sheet-header">
          <div>
            {eyebrow && <span>{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <IconButton label={closeLabel} disabled={busy} onClick={onClose}><X size={20} /></IconButton>
        </header>
        <div className="m-sheet-body">{children}</div>
        {footer && <footer className="m-sheet-footer">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

export function SheetAction({
  icon,
  label,
  detail,
  danger = false,
  ...props
}: {
  icon: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  danger?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type">) {
  return (
    <button type="button" className={`m-sheet-action${danger ? " is-danger" : ""}`} {...props}>
      <span className="m-sheet-action-icon" aria-hidden="true">{icon}</span>
      <span className="m-sheet-action-copy">
        <strong>{label}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </button>
  );
}
