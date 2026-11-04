import { X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton.js";

/**
 * The one mobile overlay for object actions, forms and prompts: a bottom sheet
 * with a title, a scrolling body and optional footer actions. Destructive
 * confirmations stay in ConfirmationDialog so they read as interruptions.
 */
export function MobileSheet({
  eyebrow,
  title,
  busy = false,
  closeLabel = "关闭",
  onClose,
  children,
  footer,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  busy?: boolean;
  closeLabel?: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  return createPortal(
    <div className="m-sheet-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="m-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
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
