import type { BridgeHostSnapshot, BridgeSessionConfiguration, BridgeSessionInfo } from "@bridge/protocol";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileBack, registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { HostPermissionSettings, PermissionModeControls } from "./HostPermissionSettings.js";
import { SessionConfigurationDialog } from "./SessionConfigurationDialog.js";

// These components have no DOM test dependency; drive their hooks and public
// controls directly, including effect completion and back-handler cleanup.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>,
  effectIndex: 0,
  pending: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.states[index], (next: unknown) => {
      hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
    }];
  },
  useMemo: (create: () => unknown) => create(),
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps && deps.length === previous.deps?.length
      && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));

function render(create: () => ReactElement): ReactElement {
  hooks.stateIndex = 0;
  hooks.effectIndex = 0;
  const root = create();
  const tree = (root.type as (props: unknown) => ReactElement)(root.props);
  hooks.pending.splice(0).forEach((effect) => effect());
  return tree;
}

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
  }
  return "";
}

function button(tree: ReactElement, text: string): ReactElement<Record<string, any>> {
  return elements(tree).find((element) => element.type === "button" && textContent(element.props.children).trim() === text)!;
}

function control(tree: ReactElement): ReactElement<Record<string, any>> {
  return elements(tree).find((element) => element.type === PermissionModeControls)!;
}

function confirmation(tree: ReactElement): ReactElement<Record<string, any>> {
  return elements(tree).find((element) => element.type === ConfirmationDialog)!;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  hooks.states = [];
  hooks.effects = [];
  hooks.pending = [];
});
afterEach(() => hooks.effects.forEach((effect) => effect.cleanup?.()));

const session = {
  sessionId: "session-1", title: "Task", runtimeId: "claude-desktop", turnState: "idle",
} as BridgeSessionInfo;
const configuration: BridgeSessionConfiguration = {
  sessionId: session.sessionId,
  model: "current-model",
  modelSource: "default",
  effortSource: "default",
  availableModels: [{ value: "current-model", displayName: "Current" }],
  availableEffortLevels: ["medium"],
  modelsComplete: true,
  appliesAfterTurn: false,
  permissionPolicy: { hostMode: "full-access", effectiveMode: "full-access", source: "host" },
};

function snapshot(): BridgeHostSnapshot {
  return {
    host: { hostId: "computer", capabilities: ["permission.policy.v1"], defaultPermissionMode: "standard" },
    sessions: [
      { sessionId: "codex-desktop:first", runtimeId: "codex-desktop", lastActivityAt: 2 },
      { sessionId: "hermes-desktop:first", runtimeId: "hermes-desktop", lastActivityAt: 1 },
    ],
    runtimes: [{ id: "codex-desktop" }, { id: "hermes-desktop" }, { id: "dsh-desktop" }],
  } as BridgeHostSnapshot;
}

describe("session authorization scope", () => {
  it("keeps mobile scope on the session through loading, inherit, and save", async () => {
    const onConfigurePermission = vi.fn().mockResolvedValue(configuration);
    const props = {
      session, permissionScope: "session" as const,
      onLoad: vi.fn().mockResolvedValue(configuration),
      onSave: vi.fn(), onConfigurePermission, onClose: vi.fn(),
    };
    const draw = () => render(() => <SessionConfigurationDialog {...props} />);
    draw();
    await settle();
    let tree = draw();
    expect(control(tree).props).toMatchObject({ scope: "session", value: "inherit" });
    expect(button(tree, "整台电脑")).toBeUndefined();
    button(tree, "保存授权模式").props.onClick();
    await settle();
    expect(onConfigurePermission).toHaveBeenCalledWith("session", null);

    props.onLoad.mockResolvedValue({
      ...configuration,
      permissionPolicy: { ...configuration.permissionPolicy, sessionMode: "standard", effectiveMode: "standard", source: "session" },
    });
    props.session = { ...session, sessionId: "session-2" };
    draw();
    await settle();
    tree = draw();
    expect(control(tree).props).toMatchObject({ scope: "session", value: "standard" });
    control(tree).props.onInherit();
    tree = draw();
    expect(control(tree).props.value).toBe("inherit");
  });

  it("preserves desktop host default and dual-scope choice", async () => {
    const props = {
      session, onLoad: vi.fn().mockResolvedValue(configuration), onSave: vi.fn(),
      onConfigurePermission: vi.fn().mockResolvedValue(configuration), onClose: vi.fn(),
    };
    const draw = () => render(() => <SessionConfigurationDialog {...props} />);
    draw();
    await settle();
    let tree = draw();
    expect(control(tree).props).toMatchObject({ scope: "host", value: "full-access" });
    expect(button(tree, "整台电脑")).toBeDefined();
    button(tree, "当前会话").props.onClick();
    tree = draw();
    expect(control(tree).props).toMatchObject({ scope: "session", value: "inherit" });
  });

  it("closes full-access confirmation before the workspace on mobile back", async () => {
    const props = {
      session, permissionScope: "session" as const,
      onLoad: vi.fn().mockResolvedValue(configuration), onSave: vi.fn(),
      onConfigurePermission: vi.fn().mockResolvedValue(configuration), onClose: vi.fn(),
    };
    const workspaceBack = vi.fn(() => true);
    const removeWorkspace = registerMobileBackHandler(workspaceBack, 100);
    try {
      const draw = () => render(() => <SessionConfigurationDialog {...props} />);
      draw();
      await settle();
      let tree = draw();
      control(tree).props.onChange("full-access");
      tree = draw();
      button(tree, "保存授权模式").props.onClick();
      tree = draw();
      expect(confirmation(tree).props.open).toBe(true);
      expect(props.onConfigurePermission).not.toHaveBeenCalled();
      expect(dispatchMobileBack()).toBe(true);
      expect(workspaceBack).not.toHaveBeenCalled();
      tree = draw();
      expect(confirmation(tree).props.open).toBe(false);
      expect(props.onClose).not.toHaveBeenCalled();
      dispatchMobileBack();
      expect(workspaceBack).toHaveBeenCalledOnce();
    } finally {
      removeWorkspace();
    }
  });
});

describe("host default authorization", () => {
  it("saves Claude without a session, requires confirmation, and handles back first", async () => {
    const props = {
      snapshot: snapshot(), onLoadSessionConfiguration: vi.fn(),
      onConfigureHostPermission: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceBack = vi.fn(() => true);
    const removeWorkspace = registerMobileBackHandler(workspaceBack, 100);
    try {
      const draw = () => render(() => <HostPermissionSettings {...props} />);
      draw();
      let tree = draw();
      expect(control(tree).props.value).toBe("standard");
      control(tree).props.onChange("full-access");
      tree = draw();
      button(tree, "保存 Claude 默认授权").props.onClick();
      tree = draw();
      expect(confirmation(tree).props.open).toBe(true);
      expect(props.onConfigureHostPermission).not.toHaveBeenCalled();
      dispatchMobileBack();
      expect(workspaceBack).not.toHaveBeenCalled();
      tree = draw();
      expect(confirmation(tree).props.open).toBe(false);
      button(tree, "保存 Claude 默认授权").props.onClick();
      tree = draw();
      confirmation(tree).props.onConfirm();
      await settle();
      expect(props.onConfigureHostPermission).toHaveBeenCalledWith("claude-desktop", "full-access", undefined);
      expect(props.onLoadSessionConfiguration).not.toHaveBeenCalled();
    } finally {
      removeWorkspace();
    }
  });

  it("loads each app's host default and reloads that app after saving", async () => {
    const props = {
      snapshot: snapshot(),
      onLoadSessionConfiguration: vi.fn().mockResolvedValue({
        ...configuration,
        permissionPolicy: { hostMode: "full-access", sessionMode: "standard", effectiveMode: "standard", source: "session" },
      }),
      onConfigureHostPermission: vi.fn().mockResolvedValue(undefined),
    };
    const draw = () => render(() => <HostPermissionSettings {...props} />);
    let tree = draw();
    button(tree, "Codex").props.onClick();
    draw();
    await settle();
    tree = draw();
    expect(props.onLoadSessionConfiguration).toHaveBeenCalledWith("codex-desktop:first");
    expect(control(tree).props.value).toBe("full-access");
    control(tree).props.onChange("standard");
    tree = draw();
    props.onLoadSessionConfiguration.mockResolvedValue({ ...configuration, permissionPolicy: {
      hostMode: "standard", effectiveMode: "standard", source: "host",
    } });
    button(tree, "保存 Codex 默认授权").props.onClick();
    await settle();
    tree = draw();
    expect(props.onConfigureHostPermission).toHaveBeenCalledWith("codex-desktop", "standard", "codex-desktop:first");
    expect(props.onLoadSessionConfiguration).toHaveBeenCalledTimes(2);
    expect(control(tree).props.value).toBe("standard");
    button(tree, "Hermes").props.onClick();
    draw();
    await settle();
    expect(props.onLoadSessionConfiguration).toHaveBeenLastCalledWith("hermes-desktop:first");
  });

  it("shows the external session limit and prevents saving a malformed runtime reference", async () => {
    const host = snapshot();
    host.sessions = [{ sessionId: "unscoped-id", runtimeId: "dsh-desktop" } as BridgeSessionInfo];
    const props = { snapshot: host, onLoadSessionConfiguration: vi.fn(), onConfigureHostPermission: vi.fn() };
    const draw = () => render(() => <HostPermissionSettings {...props} />);
    let tree = draw();
    button(tree, "DSH").props.onClick();
    draw();
    tree = draw();
    expect(elements(tree).some((element) => element.type === "p"
      && element.props.children?.includes?.("需要先在这台电脑上创建或同步一个 "))).toBe(true);
    expect(button(tree, "保存 DSH 默认授权")).toBeUndefined();
    expect(control(tree)).toBeUndefined();
    expect(props.onLoadSessionConfiguration).not.toHaveBeenCalled();
    expect(props.onConfigureHostPermission).not.toHaveBeenCalled();
  });
});
