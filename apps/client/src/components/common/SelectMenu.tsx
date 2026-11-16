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
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = useState<number>(() => (
    selectedIndex >= 0 ? selectedIndex : nextEnabledIndex(options, -1, 1)
  ));

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    const nextIdx = selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : nextEnabledIndex(options, -1, 1);
    setActiveIndex(nextIdx);
  }, [open, options, selectedIndex]);

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

  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const activeOptionId = open && activeIndex >= 0 && !options[activeIndex]?.disabled
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  function openMenuWithStep(step?: 1 | -1): void {
    if (disabled || options.length === 0) return;
    setOpen(true);
    if (step) {
      const base = selectedIndex >= 0 ? selectedIndex : (step === 1 ? -1 : 0);
      const idx = selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : nextEnabledIndex(options, base, step);
      if (idx >= 0) setActiveIndex(idx);
    }
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
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openMenuWithStep(1);
      } else {
        const nextIdx = nextEnabledIndex(options, activeIndex, 1);
        if (nextIdx >= 0) setActiveIndex(nextIdx);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenuWithStep(-1);
      } else {
        const nextIdx = nextEnabledIndex(options, activeIndex < 0 ? 0 : activeIndex, -1);
        if (nextIdx >= 0) setActiveIndex(nextIdx);
      }
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      const first = nextEnabledIndex(options, -1, 1);
      if (first >= 0) setActiveIndex(first);
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      const last = nextEnabledIndex(options, 0, -1);
      if (last >= 0) setActiveIndex(last);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      event.stopPropagation();
      const candidate = options[activeIndex];
      if (candidate && !candidate.disabled) {
        onChange(candidate.value);
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
        aria-activedescendant={activeOptionId}
        data-value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((current) => !current);
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
                  if (!option.disabled) setActiveIndex(index);
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
