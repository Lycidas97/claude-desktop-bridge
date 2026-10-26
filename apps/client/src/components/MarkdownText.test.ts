import { describe, expect, it } from "vitest";
import { parseInlineMarkdown, parseMarkdownBlocks } from "./MarkdownText.js";

describe("parseInlineMarkdown", () => {
  it("renders a local Markdown image as an on-demand file reference", () => {
    expect(parseInlineMarkdown("![Figure](output/figure.png)")).toEqual([
      { type: "file_link", path: "output/figure.png", children: [{ type: "text", text: "Figure" }] },
    ]);
  });

  it("preserves media file links containing spaces and angle brackets", () => {
    expect(parseInlineMarkdown("[报告](</work/final report.pdf>)")).toEqual([
      { type: "file_link", path: "/work/final report.pdf", children: [{ type: "text", text: "报告" }] },
    ]);
  });
  it("parses bold, inline code, and nested inline code inside bold with CJK text", () => {
    const nodes = parseInlineMarkdown("按快捷键 **`Cmd + R`**（重载**渲染层**页面）");
    expect(nodes).toEqual([
      { type: "text", text: "按快捷键 " },
      {
        type: "strong",
        children: [{ type: "code", code: "Cmd + R" }],
      },
      { type: "text", text: "（重载" },
      {
        type: "strong",
        children: [{ type: "text", text: "渲染层" }],
      },
      { type: "text", text: "页面）" },
    ]);
  });

  it("does not treat underscores inside snake_case identifiers as emphasis", () => {
    const nodes = parseInlineMarkdown("变量 bridge_relay_port 和 mcp__ccd_turn__wrap_up 保持原样");
    expect(nodes).toEqual([
      {
        type: "text",
        text: "变量 bridge_relay_port 和 mcp__ccd_turn__wrap_up 保持原样",
      },
    ]);
  });

  it("parses safe links and strips unsafe javascript: links to plain text", () => {
    const nodes = parseInlineMarkdown(
      "访问 [Relay](https://relay.example.com) 或 [危险](javascript:alert(1))",
    );
    expect(nodes).toEqual([
      { type: "text", text: "访问 " },
      {
        type: "link",
        href: "https://relay.example.com",
        children: [{ type: "text", text: "Relay" }],
      },
      { type: "text", text: " 或 " },
      { type: "text", text: "危险" },
    ]);
  });
});

describe("parseMarkdownBlocks", () => {
  it("parses headings, horizontal rules, lists, nested lists, and fenced code blocks", () => {
    const md = [
      "### 1. 日常使用说明",
      "---",
      "- **第一项**：包含行内代码 `Cmd + R`",
      "  - 子列表项 A",
      "  - 子列表项 B",
      "- **第二项**：包含缩进代码块",
      "  ```bash",
      "  sudo systemctl status bridge-relay",
      "  ```",
    ].join("\n");

    const blocks = parseMarkdownBlocks(md);
    expect(blocks[0]).toEqual({
      type: "heading",
      level: 3,
      children: [{ type: "text", text: "1. 日常使用说明" }],
    });
    expect(blocks[1]).toEqual({ type: "hr" });
    expect(blocks[2]?.type).toBe("list");
    if (blocks[2]?.type === "list") {
      expect(blocks[2].ordered).toBe(false);
      expect(blocks[2].items).toHaveLength(2);
      expect(blocks[2].items[0]?.blocks[1]?.type).toBe("list");
      expect(blocks[2].items[1]?.blocks[1]).toEqual({
        type: "code_block",
        language: "bash",
        code: "sudo systemctl status bridge-relay",
      });
    }
  });

  it("parses GFM tables with alignment and inline code containing pipes", () => {
    const md = [
      "| 组件 | 状态 | 命令 |",
      "| :--- | :---: | ---: |",
      "| Relay | **运行中** | `a \\| b` |",
    ].join("\n");

    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("table");
    if (blocks[0]?.type === "table") {
      expect(blocks[0].aligns).toEqual(["left", "center", "right"]);
      expect(blocks[0].headers).toHaveLength(3);
      expect(blocks[0].rows).toHaveLength(1);
    }
  });

  it("handles unclosed streaming fenced code blocks gracefully", () => {
    const md = "正在输出代码：\n```ts\nconst x = 1;\n";
    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", text: "正在输出代码：" }],
      },
      {
        type: "code_block",
        language: "ts",
        code: "const x = 1;\n",
      },
    ]);
  });
});
