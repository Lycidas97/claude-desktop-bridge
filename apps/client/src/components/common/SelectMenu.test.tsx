import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileBack } from "../../lib/mobile-back-navigation.js";
import { SelectMenu } from "./SelectMenu.js";

const hooks = vi.hoisted(() => ({
  states: [] as any[],
  index: 0,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>,
  effectIndex: 0,
  pending: [] as Array<() => void>,
}));

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "test-select",
  useRef(initial: unknown) {
    const index = hooks.index++;
    hooks.states[index] ??= { current: initial };
    return hooks.states[index];
  },
  useState(initial: any) {
    const index = hooks.index++;
    if (!(index in hooks.states)) {
      hooks.states[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      hooks.states[index],
      (next: any) => {
        hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
      },
    ];
  },
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (
      previous
      && deps
      && deps.length === previous.deps?.length
      && deps.every((value, i) => Object.is(value, previous.deps?.[i]))
    ) {
      return;
    }
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}

describe("SelectMenu", () => {
  beforeEach(() => {
    hooks.states = [];
    hooks.index = 0;
    hooks.effects = [];
    hooks.effectIndex = 0;
    hooks.pending = [];
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(() => {
    hooks.effects.forEach((effect) => effect.cleanup?.());
    vi.unstubAllGlobals();
  });

  function draw(props: Parameters<typeof SelectMenu>[0]) {
    hooks.index = 0;
    hooks.effectIndex = 0;
    const tree = SelectMenu(props) as ReactElement<Record<string, any>>;
    hooks.pending.splice(0).forEach((effect) => effect());
    return tree;
  }

  it("opens a custom listbox, skips disabled options on keyboard navigation, and closes on selection or mobile back", () => {
    const onChange = vi.fn();
    const options = [
      { value: "opus", label: "Claude Opus 5.5", meta: "单账号最高可用 80%" },
      { value: "disabled", label: "Unavailable", disabled: true },
      { value: "fable", label: "Claude Fable 5.2 · 1M", meta: "routing group" },
    ];

    let tree = draw({ ariaLabel: "模型", value: "opus", options, onChange });
    const trigger = elements(tree).find((el) => el.props.role === "combobox")!;
    expect(trigger.props["aria-expanded"]).toBe(false);
    expect(trigger.props["data-value"]).toBe("opus");
    expect(elements(tree).some((el) => el.props.role === "listbox")).toBe(false);

    trigger.props.onClick();
    tree = draw({ ariaLabel: "模型", value: "opus", options, onChange });
    expect(elements(tree).some((el) => el.props.role === "listbox")).toBe(true);
    expect(elements(tree).find((el) => el.props.role === "combobox")!.props["aria-activedescendant"]).toBe("test-select-listbox-option-0");
    const renderedOptions = elements(tree).filter((el) => el.props.role === "option");
    expect(renderedOptions).toHaveLength(3);
    expect(renderedOptions.map((opt) => opt.props.id)).toEqual([
      "test-select-listbox-option-0",
      "test-select-listbox-option-1",
      "test-select-listbox-option-2",
    ]);
    expect(renderedOptions[0]?.props["aria-selected"]).toBe(true);
    expect(renderedOptions[1]?.props["aria-disabled"]).toBe(true);

    // ArrowDown skips the disabled middle option and lands on "fable" with updated aria-activedescendant
    tree.props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    tree = draw({ ariaLabel: "模型", value: "opus", options, onChange });
    expect(elements(tree).find((el) => el.props.role === "combobox")!.props["aria-activedescendant"]).toBe("test-select-listbox-option-2");
    tree.props.onKeyDown({ key: "Enter", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("fable");
    tree = draw({ ariaLabel: "模型", value: "fable", options, onChange });
    expect(elements(tree).some((el) => el.props.role === "listbox")).toBe(false);
    expect(elements(tree).find((el) => el.props.role === "combobox")!.props["aria-activedescendant"]).toBeUndefined();

    // Capture-phase outside pointerdown closes an open menu even when a sibling SelectMenu stops bubble propagation
    elements(tree).find((el) => el.props.role === "combobox")!.props.onClick();
    tree = draw({ ariaLabel: "模型", value: "fable", options, onChange });
    (hooks.states[0] as { current: unknown }).current = { contains: (target: unknown) => target === "inside" };
    const captureCall = vi.mocked(document.addEventListener).mock.calls.find(
      (call) => call[0] === "pointerdown" && call[2] === true,
    );
    expect(captureCall).toBeDefined();
    (captureCall![1] as unknown as (event: { target: unknown }) => void)({ target: "sibling-select-menu" });
    tree = draw({ ariaLabel: "模型", value: "fable", options, onChange });
    expect(elements(tree).some((el) => el.props.role === "listbox")).toBe(false);
    expect(document.removeEventListener).toHaveBeenCalledWith("pointerdown", captureCall![1], true);

    // Reopen and verify mobile back closes the menu first
    elements(tree).find((el) => el.props.role === "combobox")!.props.onClick();
    tree = draw({ ariaLabel: "模型", value: "fable", options, onChange });
    expect(dispatchMobileBack()).toBe(true);
    tree = draw({ ariaLabel: "模型", value: "fable", options, onChange });
    expect(elements(tree).some((el) => el.props.role === "listbox")).toBe(false);
  });
});
