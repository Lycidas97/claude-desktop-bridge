import type { KeyboardEvent } from "react";
import "./section-create.css";

export interface SectionCreateState {
  name: string;
  busy: boolean;
  error: string;
}

export function trapModalTabKey(event: KeyboardEvent<HTMLElement>, dialog: HTMLElement | null): void {
  if (event.key !== "Tab" || !dialog) return;
  const focusables = [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  if (focusables.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

export function SectionCreateDialog({
  state,
  online = true,
  canSubmit,
  onChangeName,
  onSubmit,
  onClose,
}: {
  state: SectionCreateState | undefined;
  online?: boolean | undefined;
  canSubmit: boolean;
  onChangeName(name: string): void;
  onSubmit(): void | Promise<void>;
  onClose(): void;
}) {
  if (!state) return null;

  return (
    <div
      className="modal-backdrop session-create-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !state.busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (!state.busy) onClose();
        }
      }}
    >
      <section
        className="create-session-dialog session-create-dialog section-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新建分组"
        tabIndex={-1}
        onKeyDown={(event) => trapModalTabKey(event, event.currentTarget)}
      >
        <header className="session-create-header">
          <h2>新建分组</h2>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <div className="session-create-body">
            <label>
              <span>分组名称</span>
              <input
                aria-label="分组名称"
                value={state.name}
                autoFocus
                required
                maxLength={200}
                disabled={state.busy}
                onChange={(event) => onChangeName(event.target.value)}
              />
            </label>
            {state.error && <p className="session-create-error" role="alert">{state.error}</p>}
            {!online && <p className="session-create-status" role="status">电脑已离线，连接后可创建分组。</p>}
          </div>
          <footer className="dialog-actions session-create-actions">
            <button type="button" className="secondary-button" disabled={state.busy} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={!canSubmit}>
              {state.busy ? "正在创建…" : "创建分组"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
