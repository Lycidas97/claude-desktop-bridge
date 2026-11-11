import type { BridgeSlashCommand, BridgeSlashCommandCatalog } from "@bridge/protocol";
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";

export function SlashCommandInput({
  value,
  onChange,
  onLoad,
  textareaRef,
  disabled,
  placeholder,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange(value: string): void;
  onLoad?: (() => Promise<BridgeSlashCommandCatalog>) | undefined;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const ownTextareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = textareaRef ?? ownTextareaRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<number | undefined>(undefined);
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selection, setSelection] = useState({ start: value.length, end: value.length });
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<
    { status: "loading" }
    | { status: "ready"; catalog: BridgeSlashCommandCatalog }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const token = /^\/[^\s]*/u.exec(value)?.[0];
  const prefix = value.slice(1, selection.start).toLocaleLowerCase();
  const open = Boolean(onLoad && !disabled && focused && !dismissed && token
    && !token.slice(1).includes("/") && !token.includes("\\")
    && selection.start === selection.end && selection.start >= 1 && selection.start <= token.length);
  const commands = result.status === "ready" ? result.catalog.commands.filter(command => (
    command.name.toLocaleLowerCase().startsWith(prefix)
    || command.aliases?.some(alias => alias.toLocaleLowerCase().startsWith(prefix))
  )) : [];

  useEffect(() => {
    if (!open) return;
    let closed = false;
    setResult({ status: "loading" });
    setActive(0);
    void onLoad!().then(catalog => {
      if (!closed) setResult({ status: "ready", catalog });
    }).catch(error => {
      if (!closed) setResult({ status: "error", message: error instanceof Error ? error.message : "会话命令读取失败" });
    });
    return () => { closed = true; };
    // The loader belongs to this opening; inline parent callbacks must not refetch on each keystroke.
  }, [open]);

  useEffect(() => { setActive(0); }, [prefix]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) {
        setDismissed(true);
        setFocused(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || composing.current || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    const unregister = registerMobileBackHandler(() => {
      setDismissed(true);
      return true;
    }, 140);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      unregister();
    };
  }, [open]);

  useLayoutEffect(() => {
    if (pendingCaret.current === undefined) return;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = undefined;
  }, [value]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [open, active, prefix, result]);

  function select(command: BridgeSlashCommand): void {
    if (composing.current || command.unavailableReason) return;
    pendingCaret.current = command.name.length + 2;
    onChange(`/${command.name} ${value.slice(token!.length).replace(/^ /u, "")}`);
    setDismissed(true);
  }

  return (
    <div className="slash-command-input" ref={containerRef}>
      <textarea
        ref={inputRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        aria-label={ariaLabel ?? "消息"}
        {...(onLoad ? {
          role: "combobox",
          "aria-autocomplete": "list" as const,
          "aria-haspopup": "listbox" as const,
          "aria-expanded": open,
          ...(open ? {
            "aria-controls": `${id}-list`,
            ...(commands[active] ? { "aria-activedescendant": `${id}-option-${active}` } : {}),
          } : {}),
        } : {})}
        onFocus={(event) => {
          setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
          setFocused(true);
          setDismissed(false);
        }}
        onChange={(event) => {
          setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
          setDismissed(false);
          onChange(event.currentTarget.value);
        }}
        onSelect={(event) => {
          const { selectionStart: start, selectionEnd: end } = event.currentTarget;
          if (start !== selection.start || end !== selection.end) {
            setSelection({ start, end });
            setDismissed(false);
          }
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (!open || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (!["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) return;
          if ((event.key === "Enter" || event.key === "Tab") && !commands[active]) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") setDismissed(true);
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (commands.length) setActive((current) => (current + (event.key === "ArrowDown" ? 1 : commands.length - 1)) % commands.length);
          } else if (commands[active]) select(commands[active]);
        }}
      />
      {open && (
        <div className="slash-command-menu">
          <div className="slash-command-heading" id={`${id}-label`}>会话命令</div>
          <div className="slash-command-options" role="listbox" id={`${id}-list`} aria-labelledby={`${id}-label`} ref={listRef} aria-busy={result.status === "loading"}>
            {commands.map((command, index) => (
              <button
                type="button"
                role="option"
                key={command.name}
                id={`${id}-option-${index}`}
                aria-selected={index === active}
                aria-disabled={Boolean(command.unavailableReason)}
                disabled={Boolean(command.unavailableReason)}
                tabIndex={-1}
                className={`slash-command-option${index === active ? " is-active" : ""}`}
                onMouseDown={(event) => { event.preventDefault(); }}
                onClick={() => select(command)}
              >
                <span className="slash-command-name"><strong>/{command.name}</strong>{command.argumentHint && <small>{command.argumentHint}</small>}</span>
                {(command.unavailableReason || command.description) && <span className="slash-command-description">{command.unavailableReason ?? command.description}</span>}
              </button>
            ))}
          </div>
          {result.status === "loading" && <div className="slash-command-status" role="status">正在读取会话命令…</div>}
          {result.status === "error" && <div className="slash-command-status is-error" role="alert">{result.message}</div>}
          {result.status === "ready" && commands.length === 0 && <div className="slash-command-status" role="status">{result.catalog.commands.length ? "没有匹配的会话命令" : "没有可用的会话命令"}</div>}
          {result.status === "ready" && Boolean(result.catalog.warnings?.length) && (
            <div className="slash-command-warning" role="status">{result.catalog.warnings![0]}{result.catalog.warnings!.length > 1 ? `（另 ${result.catalog.warnings!.length - 1} 项）` : ""}</div>
          )}
        </div>
      )}
    </div>
  );
}
