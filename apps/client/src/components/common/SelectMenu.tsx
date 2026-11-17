import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";

export interface SelectMenuOption<T extends string = string> {
  value: T;
  label: string;
  meta?: string | undefined;
  disabled?: boolean | undefined;
}

export interface SelectMenuProps<T extends string = string> {
  id?: string | undefined;
  ariaLabel?: string | undefined;
  ariaLabelledBy?: string | undefined;
  value: T;
  options: readonly SelectMenuOption<T>[];
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
  onChange(value: T): void;
}

function nextEnabledIndex<T extends string>(
  options: readonly SelectMenuOption<T>[],
  startIndex: number,
  step: 1 | -1,
): number {
  if (options.length === 0) return -1;
  let index = startIndex;
  for (let count = 0; count < options.length; count += 1) {
    index = (index + step + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function SelectMenu<T extends string = string>({
  id,
  ariaLabel,
  ariaLabelledBy,
  value,
  options,
  placeholder = "请选择",
  disabled = false,
  autoFocus = false,
  className,
  onChange,
}: SelectMenuProps<T>) {
  const generatedId = useId();
  const listboxId = `${id ?? generatedId}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<T>();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = options[selectedIndex];
  const defaultIndex = selectedOption && !selectedOption.disabled
    ? selectedIndex
    : nextEnabledIndex(options, -1, 1);
  const highlightedIndex = options.findIndex((option) => option.value === activeValue && !option.disabled);
  const activeIndex = highlightedIndex >= 0 ? highlightedIndex : defaultIndex;
  const activeOption = options[activeIndex];

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (open && activeValue !== undefined && highlightedIndex < 0) setActiveValue(undefined);
  }, [open, activeValue, highlightedIndex]);

  useEffect(() => {
    if (!open || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return registerMobileBackHandler(() => {
      setOpen(false);
      return true;
    }, 160);
  }, [open]);

  function openMenu(): void {
    setActiveValue(undefined);
    setOpen(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus?.();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        if (options.length > 0) openMenu();
      } else {
        setActiveValue(options[nextEnabledIndex(options, activeIndex, event.key === "ArrowDown" ? 1 : -1)]?.value);
      }
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveValue(options[nextEnabledIndex(options, -1, 1)]?.value);
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      setActiveValue(options[nextEnabledIndex(options, 0, -1)]?.value);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      event.stopPropagation();
      if (activeOption) {
        onChange(activeOption.value);
        setOpen(false);
        triggerRef.current?.focus?.();
      }
    }
  }

  return (
    <div
      ref={containerRef}
      className={`select-menu${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        className="select-menu-trigger"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeOption ? `${listboxId}-option-${activeIndex}` : undefined}
        data-value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onClick={() => {
          if (open) setOpen(false);
          else openMenu();
        }}
      >
        <span className="select-menu-trigger-copy">
          <span className="select-menu-value">{selectedOption ? selectedOption.label : placeholder}</span>
          {selectedOption?.meta && <span className="select-menu-trigger-meta">{selectedOption.meta}</span>}
        </span>
        <ChevronDown size={15} className={`select-menu-chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="select-menu-listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <div
                key={option.value}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                data-option-value={option.value}
                className={`select-menu-option${isSelected ? " is-selected" : ""}${index === activeIndex ? " is-focused" : ""}${option.disabled ? " is-disabled" : ""}`}
                onMouseEnter={() => {
                  if (!option.disabled) setActiveValue(option.value);
                }}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus?.();
                }}
              >
                <span className="select-menu-option-copy">
                  <span className="select-menu-option-label">{option.label}</span>
                  {option.meta && <span className="select-menu-option-meta">{option.meta}</span>}
                </span>
                {isSelected && <Check size={15} className="select-menu-option-check" aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
