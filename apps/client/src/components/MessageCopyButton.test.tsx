import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageCopyButton } from "./MessageCopyButton.js";

const hooks = vi.hoisted(() => ({ status: "idle" }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: () => [hooks.status, (status: string) => { hooks.status = status; }],
  useEffect: () => undefined,
}));

const text = "# 完整回复\n\n" + "折叠部分也必须复制。\n".repeat(1000) + "```ts\nconst answer = 42;\n```\n最后一行";
let textarea: {
  value: string; readOnly: boolean; style: Record<string, string>;
  select: ReturnType<typeof vi.fn>; setSelectionRange: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>;
};
const execCommand = vi.fn();
const writeText = vi.fn();

beforeEach(() => {
  hooks.status = "idle";
  textarea = { value: "", readOnly: false, style: {}, select: vi.fn(), setSelectionRange: vi.fn(), remove: vi.fn() };
  execCommand.mockReset().mockReturnValue(true);
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("document", { createElement: vi.fn(() => textarea), body: { appendChild: vi.fn() }, execCommand });
});
afterEach(() => vi.unstubAllGlobals());

function click() {
  MessageCopyButton({ text, label: "复制这条回复" }).props.onClick();
}

describe("message copy", () => {
  it("copies complete Markdown without cutting long or folded content", async () => {
    click();
    await vi.waitFor(() => expect(hooks.status).toBe("copied"));
    expect(writeText).toHaveBeenCalledWith(text);
    expect(execCommand).not.toHaveBeenCalled();
    expect(MessageCopyButton({ text, label: "复制这条回复" }).props["aria-label"]).toBe("已复制");
  });

  it.each(["missing", "denied"])("copies through the WebView fallback when clipboard is %s", async (mode) => {
    if (mode === "missing") vi.stubGlobal("navigator", {});
    else writeText.mockRejectedValue(new Error("Permission denied"));
    click();
    await vi.waitFor(() => expect(hooks.status).toBe("copied"));
    expect(textarea.value).toBe(text);
    expect(textarea.readOnly).toBe(true);
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, text.length);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  it.each([false, "throw"])("reports fallback failure and permits retry (%s)", async (failure) => {
    writeText.mockRejectedValue(new Error("Permission denied"));
    if (failure === false) execCommand.mockReturnValue(false);
    else execCommand.mockImplementation(() => { throw new Error("Not supported"); });
    click();
    await vi.waitFor(() => expect(hooks.status).toBe("error"));
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(MessageCopyButton({ text, label: "复制这条回复" }).props["aria-label"]).toBe("复制这条回复");
    writeText.mockResolvedValue(undefined);
    click();
    await vi.waitFor(() => expect(hooks.status).toBe("copied"));
  });
});
