import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export function ConfirmationDialog({
  open,
  title,
  description,
  error,
  confirmLabel,
  busy = false,
  confirmDisabled = false,
  danger = false,
  backdropClassName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  error?: string | undefined;
  confirmLabel: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  danger?: boolean;
  backdropClassName?: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    const firstControl = dialog.querySelector<HTMLElement>("button:not(:disabled)") ?? dialog;
    firstControl.focus();
    return () => {
      const active = document.activeElement;
      if (
        opener?.isConnected
        && (!active || active === document.body || active === document.documentElement || dialog.contains(active))
      ) {
        opener.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className={backdropClassName ? `confirm-backdrop ${backdropClassName}` : "confirm-backdrop"} onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}>
      <section
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Tab") {
            const controls = event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), [tabindex="0"]',
            );
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (!first || !last) {
              event.preventDefault();
              return;
            }
            if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {error && <p className="confirm-error" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className={danger ? "danger-button" : "primary-button"} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? "正在处理" : confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
