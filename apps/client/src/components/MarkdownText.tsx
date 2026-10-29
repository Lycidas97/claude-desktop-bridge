import { Check, Copy, Download, Eye } from "lucide-react";
import { mediaKind } from "../lib/media-preview.js";
import { useId, useState, type ReactNode } from "react";

export type TableAlign = "left" | "center" | "right" | undefined;

export type MarkdownInlineNode =
  | { type: "text"; text: string }
  | { type: "code"; code: string }
  | { type: "strong"; children: MarkdownInlineNode[] }
  | { type: "em"; children: MarkdownInlineNode[] }
  | { type: "del"; children: MarkdownInlineNode[] }
  | { type: "link"; href: string; children: MarkdownInlineNode[] }
  | { type: "file_link"; path: string; children: MarkdownInlineNode[] }
  | { type: "br" };

export interface MarkdownListItem {
  checked?: boolean;
  blocks: MarkdownBlockNode[];
}

export type MarkdownBlockNode =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInlineNode[] }
  | { type: "paragraph"; children: MarkdownInlineNode[] }
  | { type: "code_block"; language: string; code: string }
  | { type: "blockquote"; blocks: MarkdownBlockNode[] }
  | { type: "list"; ordered: boolean; start: number; items: MarkdownListItem[] }
  | {
      type: "table";
      headers: MarkdownInlineNode[][];
      aligns: TableAlign[];
      rows: MarkdownInlineNode[][][];
    }
  | { type: "hr" };

const SAFE_LINK_PROTOCOL = /^(https?:|mailto:)/i;
const DOWNLOADABLE_FILE_EXT_RE = /\.(apk|pdf|zip|tar|gz|tgz|docx|pptx|xlsx|csv|tsv|json|jsonl|md|txt|log|png|jpg|jpeg|gif|webp|svg|html|py|ts|tsx|js|mjs|cjs|css|sh|zsh|sql|yaml|yml|toml|xml|tex|bib)$/i;

function sanitizeHref(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return SAFE_LINK_PROTOCOL.test(url.protocol) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export function extractDownloadableFilePath(raw: string, allowSpaces = false): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 320 || /[\r\n]/u.test(trimmed) || (!allowSpaces && /\s/u.test(trimmed))) return undefined;
  if (trimmed.startsWith("#") || trimmed.startsWith("-")) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return undefined;
  if (/^[^/\\]+:[/\\]/.test(trimmed)) return undefined;
  const withoutLine = trimmed.replace(/:\d+(?::\d+)?$/u, "");
  if (!withoutLine || withoutLine === "." || withoutLine === "..") return undefined;
  if (!DOWNLOADABLE_FILE_EXT_RE.test(withoutLine)) return undefined;
  return withoutLine;
}

export function parseInlineMarkdown(input: string): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = [];
  let buffer = "";
  let i = 0;
  const len = input.length;

  const flushText = () => {
    if (buffer) {
      nodes.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  while (i < len) {
    const ch = input[i];

    // Hard or soft line break inside a paragraph
    if (ch === "\n") {
      flushText();
      nodes.push({ type: "br" });
      i += 1;
      continue;
    }

    // Backslash escape for markdown punctuation
    if (ch === "\\" && i + 1 < len && /[\\`*_{}[\]()#+\-.!~|>]/.test(input[i + 1]!)) {
      buffer += input[i + 1];
      i += 2;
      continue;
    }

    // 1. Inline code span (`...` or ``...``)
    if (ch === "`") {
      let tickCount = 1;
      while (i + tickCount < len && input[i + tickCount] === "`") {
        tickCount += 1;
      }
      const fence = "`".repeat(tickCount);
      const closeIdx = input.indexOf(fence, i + tickCount);
      if (closeIdx !== -1) {
        flushText();
        let code = input.slice(i + tickCount, closeIdx);
        if (tickCount > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim().length > 0) {
          code = code.slice(1, -1);
        }
        nodes.push({ type: "code", code });
        i = closeIdx + tickCount;
        continue;
      }
      buffer += fence;
      i += tickCount;
      continue;
    }

    // 2. Markdown links and image references open on demand.
    if (ch === "[" || (ch === "!" && input[i + 1] === "[")) {
      const linkMatch = matchMarkdownLink(input, ch === "!" ? i + 1 : i);
      if (linkMatch) {
        const safeHref = sanitizeHref(linkMatch.href);
        const filePath = safeHref ? undefined : extractDownloadableFilePath(linkMatch.href, true);
        flushText();
        if (safeHref) {
          nodes.push({
            type: "link",
            href: safeHref,
            children: parseInlineMarkdown(linkMatch.label),
          });
        } else if (filePath) {
          nodes.push({
            type: "file_link",
            path: filePath,
            children: parseInlineMarkdown(linkMatch.label),
          });
        } else {
          nodes.push(...parseInlineMarkdown(linkMatch.label));
        }
        i = linkMatch.nextIndex;
        continue;
      }
    }

    // 3. Bold + Italic (***...***)
    if (input.startsWith("***", i)) {
      const closeIdx = findClosingDelimiter(input, i + 3, "***");
      if (closeIdx !== -1 && closeIdx > i + 3) {
        flushText();
        nodes.push({
          type: "strong",
          children: [{ type: "em", children: parseInlineMarkdown(input.slice(i + 3, closeIdx)) }],
        });
        i = closeIdx + 3;
        continue;
      }
    }

    // 4. Bold (**...** or __...__)
    if (input.startsWith("**", i) || input.startsWith("__", i)) {
      const delim = input.slice(i, i + 2);
      const prevChar = i > 0 ? input[i - 1]! : "";
      if (delim === "__" && /\w/.test(prevChar)) {
        buffer += delim;
        i += 2;
        continue;
      }
      const closeIdx = findClosingDelimiter(input, i + 2, delim);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flushText();
        nodes.push({
          type: "strong",
          children: parseInlineMarkdown(input.slice(i + 2, closeIdx)),
        });
        i = closeIdx + 2;
        continue;
      }
    }

    // 5. Strikethrough (~~...~~)
    if (input.startsWith("~~", i)) {
      const closeIdx = findClosingDelimiter(input, i + 2, "~~");
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flushText();
        nodes.push({
          type: "del",
          children: parseInlineMarkdown(input.slice(i + 2, closeIdx)),
        });
        i = closeIdx + 2;
        continue;
      }
    }

    // 6. Italic (*...* or _..._)
    if (ch === "*" || ch === "_") {
      const prevChar = i > 0 ? input[i - 1]! : "";
      const nextChar = i + 1 < len ? input[i + 1]! : "";
      const blockedByWord = ch === "_" && /\w/.test(prevChar);
      if (!blockedByWord && nextChar && nextChar !== ch && !/\s/.test(nextChar)) {
        const closeIdx = findSingleClosingDelimiter(input, i + 1, ch);
        if (closeIdx !== -1 && closeIdx > i + 1) {
          flushText();
          nodes.push({
            type: "em",
            children: parseInlineMarkdown(input.slice(i + 1, closeIdx)),
          });
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // 7. Bare URLs (https://... or http://...)
    if (
      (input.startsWith("https://", i) || input.startsWith("http://", i)) &&
      (i === 0 || /[\s([<'"`：；，。（【「『]/.test(input[i - 1]!))
    ) {
      const rest = input.slice(i);
      const urlMatch = /^https?:\/\/[^\s<>()[\]"'`，。；：！？）】」』]+/.exec(rest);
      if (urlMatch) {
        let rawUrl = urlMatch[0];
        while (/[.,;:!?]$/.test(rawUrl)) {
          rawUrl = rawUrl.slice(0, -1);
        }
        const safeHref = sanitizeHref(rawUrl);
        if (safeHref) {
          flushText();
          nodes.push({
            type: "link",
            href: safeHref,
            children: [{ type: "text", text: rawUrl }],
          });
          i += rawUrl.length;
          continue;
        }
      }
    }

    buffer += ch;
    i += 1;
  }

  flushText();
  return nodes;
}

function findClosingDelimiter(input: string, startIndex: number, delimiter: string): number {
  let i = startIndex;
  while (i < input.length) {
    if (input[i] === "\\") {
      i += 2;
      continue;
    }
    if (input[i] === "`") {
      let ticks = 1;
      while (i + ticks < input.length && input[i + ticks] === "`") ticks += 1;
      const closeTick = input.indexOf("`".repeat(ticks), i + ticks);
      if (closeTick !== -1) {
        i = closeTick + ticks;
        continue;
      }
    }
    if (input.startsWith(delimiter, i)) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function findSingleClosingDelimiter(input: string, startIndex: number, ch: "*" | "_"): number {
  let i = startIndex;
  while (i < input.length) {
    if (input[i] === "\\") {
      i += 2;
      continue;
    }
    if (input[i] === "`") {
      let ticks = 1;
      while (i + ticks < input.length && input[i + ticks] === "`") ticks += 1;
      const closeTick = input.indexOf("`".repeat(ticks), i + ticks);
      if (closeTick !== -1) {
        i = closeTick + ticks;
        continue;
      }
    }
    if (input[i] === ch && input[i - 1] !== ch && input[i + 1] !== ch) {
      const prev = input[i - 1] ?? "";
      const next = input[i + 1] ?? "";
      if (!/\s/.test(prev) && (ch !== "_" || !/\w/.test(next))) {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}

function matchMarkdownLink(
  input: string,
  startIndex: number,
): { label: string; href: string; nextIndex: number } | undefined {
  let depth = 0;
  let i = startIndex;
  let labelEnd = -1;

  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      let ticks = 1;
      while (i + ticks < input.length && input[i + ticks] === "`") ticks += 1;
      const closeTick = input.indexOf("`".repeat(ticks), i + ticks);
      if (closeTick !== -1) {
        i = closeTick + ticks;
        continue;
      }
    }
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        labelEnd = i;
        break;
      }
    }
    i += 1;
  }

  if (labelEnd === -1 || input[labelEnd + 1] !== "(") return undefined;

  let parenDepth = 1;
  let j = labelEnd + 2;
  while (j < input.length && parenDepth > 0) {
    const ch = input[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "(") parenDepth += 1;
    if (ch === ")") parenDepth -= 1;
    if (parenDepth === 0) break;
    j += 1;
  }

  if (parenDepth !== 0) return undefined;

  const label = input.slice(startIndex + 1, labelEnd);
  const rawTarget = input.slice(labelEnd + 2, j).trim();
  const href = rawTarget.startsWith("<") && rawTarget.includes(">")
    ? rawTarget.slice(1, rawTarget.indexOf(">"))
    : rawTarget.replace(/\s+["'][^"']*["']$/u, "");
  if (!href) return undefined;

  return {
    label,
    href,
    nextIndex: j + 1,
  };
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLOCKQUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM_RE = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_DELIMITER_CELL_RE = /^:?-{3,}:?$/;

function splitTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 2;
      continue;
    }
    if (trimmed[i] === "`") {
      let ticks = 1;
      while (i + ticks < trimmed.length && trimmed[i + ticks] === "`") ticks += 1;
      const fence = "`".repeat(ticks);
      const closeIdx = trimmed.indexOf(fence, i + ticks);
      if (closeIdx !== -1) {
        current += trimmed.slice(i, closeIdx + ticks);
        i = closeIdx + ticks;
        continue;
      }
    }
    if (trimmed[i] === "|") {
      cells.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += trimmed[i];
    i += 1;
  }
  cells.push(current.trim());
  return cells;
}

function isTableDelimiterLine(line: string, expectedColumns: number): TableAlign[] | undefined {
  if (!line.includes("|") && !line.trim().startsWith(":-") && !line.trim().startsWith("---")) {
    return undefined;
  }
  const cells = splitTableCells(line);
  if (cells.length !== expectedColumns || cells.length === 0) return undefined;
  if (!cells.every((cell) => TABLE_DELIMITER_CELL_RE.test(cell))) return undefined;
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return undefined;
  });
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!line.trim()) return true;
  if (FENCE_OPEN_RE.test(line)) return true;
  if (HEADING_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (BLOCKQUOTE_RE.test(line)) return true;
  if (LIST_ITEM_RE.test(line)) return true;
  if (line.includes("|") && index + 1 < lines.length) {
    const headerCells = splitTableCells(line);
    if (headerCells.length >= 2 && isTableDelimiterLine(lines[index + 1]!, headerCells.length)) {
      return true;
    }
  }
  return false;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlockNode[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MarkdownBlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 1. Fenced code block (``` or ~~~)
    const fenceMatch = FENCE_OPEN_RE.exec(line);
    if (fenceMatch) {
      const fenceChars = fenceMatch[1]!;
      const fenceChar = fenceChars[0]!;
      const fenceLen = fenceChars.length;
      const language = (fenceMatch[2] ?? "").trim().split(/\s+/)[0] ?? "";
      const codeLines: string[] = [];
      i += 1;
      const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
      while (i < lines.length && !closeRe.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) {
        i += 1; // skip closing fence
      }
      blocks.push({
        type: "code_block",
        language,
        code: codeLines.join("\n"),
      });
      continue;
    }

    // 2. ATX Heading (# ... ######)
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = Math.min(6, Math.max(1, headingMatch[1]!.length)) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({
        type: "heading",
        level,
        children: parseInlineMarkdown(headingMatch[2]!.trim()),
      });
      i += 1;
      continue;
    }

    // 3. Horizontal Rule (---, ***, ___)
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // 4. Blockquote (> ...)
    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const m = BLOCKQUOTE_RE.exec(lines[i]!);
        if (!m) break;
        quoteLines.push(m[1] ?? "");
        i += 1;
      }
      blocks.push({
        type: "blockquote",
        blocks: parseMarkdownBlocks(quoteLines.join("\n")),
      });
      continue;
    }

    // 5. GFM Table
    if (line.includes("|") && i + 1 < lines.length) {
      const headerCells = splitTableCells(line);
      const aligns = isTableDelimiterLine(lines[i + 1]!, headerCells.length);
      if (headerCells.length >= 1 && aligns) {
        i += 2;
        const rows: MarkdownInlineNode[][][] = [];
        while (i < lines.length) {
          const rowLine = lines[i]!;
          if (!rowLine.trim() || !rowLine.includes("|") || FENCE_OPEN_RE.test(rowLine)) break;
          const rawCells = splitTableCells(rowLine);
          const normalizedRow = headerCells.map((_, colIdx) =>
            parseInlineMarkdown(rawCells[colIdx] ?? ""),
          );
          rows.push(normalizedRow);
          i += 1;
        }
        blocks.push({
          type: "table",
          headers: headerCells.map((cell) => parseInlineMarkdown(cell)),
          aligns,
          rows,
        });
        continue;
      }
    }

    // 6. Ordered or Unordered List
    const listMatch = LIST_ITEM_RE.exec(line);
    if (listMatch) {
      const firstMarker = listMatch[2]!;
      const ordered = /^\d/.test(firstMarker);
      const start = ordered ? Number.parseInt(firstMarker, 10) || 1 : 1;
      const items: MarkdownListItem[] = [];

      while (i < lines.length) {
        const currentMatch = LIST_ITEM_RE.exec(lines[i]!);
        if (!currentMatch) break;
        const marker = currentMatch[2]!;
        const isCurrentOrdered = /^\d/.test(marker);
        if (isCurrentOrdered !== ordered) break;

        const leadingSpaces = currentMatch[1]!.length;
        const contentIndent = leadingSpaces + marker.length + 1;
        let firstLineContent = currentMatch[3] ?? "";
        let checked: boolean | undefined;

        const taskMatch = /^\[([ xX])\][ \t]+(.*)$/.exec(firstLineContent);
        if (taskMatch) {
          checked = taskMatch[1]!.toLowerCase() === "x";
          firstLineContent = taskMatch[2] ?? "";
        }

        const itemLines: string[] = [firstLineContent];
        i += 1;

        let inSubFence: { char: string; len: number } | undefined;

        while (i < lines.length) {
          const nextLine = lines[i]!;

          if (inSubFence) {
            const stripped = stripIndent(nextLine, contentIndent);
            itemLines.push(stripped);
            const closeFenceRe = new RegExp(`^ {0,3}${inSubFence.char}{${inSubFence.len},}[ \\t]*$`);
            if (closeFenceRe.test(stripped)) {
              inSubFence = undefined;
            }
            i += 1;
            continue;
          }

          if (!nextLine.trim()) {
            // Look ahead to see if the list or indented content continues after blank line(s)
            let lookahead = i + 1;
            while (lookahead < lines.length && !lines[lookahead]!.trim()) {
              lookahead += 1;
            }
            if (lookahead >= lines.length) break;
            const afterBlank = lines[lookahead]!;
            const afterIndent = /^ */.exec(afterBlank)?.[0].length ?? 0;
            if (afterIndent >= contentIndent || LIST_ITEM_RE.test(afterBlank)) {
              itemLines.push("");
              i += 1;
              continue;
            }
            break;
          }

          const nextIndent = /^ */.exec(nextLine)?.[0].length ?? 0;

          // Another top-level list item starts
          if (nextIndent <= leadingSpaces && LIST_ITEM_RE.test(nextLine)) {
            break;
          }

          // Top-level non-indented heading, hr, fence, or blockquote ends the list
          if (
            nextIndent === 0 &&
            (HEADING_RE.test(nextLine) || HR_RE.test(nextLine) || FENCE_OPEN_RE.test(nextLine))
          ) {
            break;
          }

          const stripped = stripIndent(nextLine, contentIndent);
          const subFence = FENCE_OPEN_RE.exec(stripped);
          if (subFence) {
            inSubFence = {
              char: subFence[1]![0]!,
              len: subFence[1]!.length,
            };
          }
          itemLines.push(stripped);
          i += 1;
        }

        const parsedItemBlocks = parseMarkdownBlocks(itemLines.join("\n"));
        items.push({
          ...(checked !== undefined ? { checked } : {}),
          blocks:
            parsedItemBlocks.length > 0
              ? parsedItemBlocks
              : [{ type: "paragraph", children: [] }],
        });
      }

      blocks.push({
        type: "list",
        ordered,
        start,
        items,
      });
      continue;
    }

    // 7. Paragraph
    const paragraphLines: string[] = [line];
    i += 1;
    while (i < lines.length && !isBlockStart(lines, i)) {
      paragraphLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({
      type: "paragraph",
      children: parseInlineMarkdown(paragraphLines.join("\n")),
    });
  }

  return blocks;
}

function stripIndent(line: string, maxSpaces: number): string {
  let count = 0;
  while (count < maxSpaces && count < line.length && line[count] === " ") {
    count += 1;
  }
  return line.slice(count);
}

function renderInlineNodes(
  nodes: MarkdownInlineNode[],
  keyPrefix = "inl",
  onFileClick?: (filePath: string) => void,
): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return node.text;
      case "br":
        return <br key={key} />;
      case "code": {
        const filePath = onFileClick ? extractDownloadableFilePath(node.code) : undefined;
        if (filePath && onFileClick) {
          return (
            <button
              type="button"
              className="markdown-inline-code markdown-file-code"
              key={key}
              title={`${mediaKind(filePath) ? "查看" : "打开"} ${filePath}`}
              onClick={() => onFileClick(filePath)}
            >
              <span>{node.code}</span>
              {mediaKind(filePath) ? <Eye size={11} className="markdown-file-icon" aria-hidden="true" /> : <Download size={11} className="markdown-file-icon" aria-hidden="true" />}
            </button>
          );
        }
        return (
          <code className="markdown-inline-code" key={key}>
            {node.code}
          </code>
        );
      }
      case "strong":
        return <strong key={key}>{renderInlineNodes(node.children, key, onFileClick)}</strong>;
      case "em":
        return <em key={key}>{renderInlineNodes(node.children, key, onFileClick)}</em>;
      case "del":
        return <del key={key}>{renderInlineNodes(node.children, key, onFileClick)}</del>;
      case "link":
        return (
          <a
            className="markdown-link"
            href={node.href}
            key={key}
            rel="noopener noreferrer"
            target="_blank"
          >
            {renderInlineNodes(node.children, key, onFileClick)}
          </a>
        );
      case "file_link":
        if (onFileClick) {
          return (
            <button
              type="button"
              className="markdown-file-link"
              key={key}
              title={`${mediaKind(node.path) ? "查看" : "打开"} ${node.path}`}
              onClick={() => onFileClick(node.path)}
            >
              <span>{renderInlineNodes(node.children, key)}</span>
              {mediaKind(node.path) ? <Eye size={12} className="markdown-file-icon" aria-hidden="true" /> : <Download size={12} className="markdown-file-icon" aria-hidden="true" />}
            </button>
          );
        }
        return <span key={key}>{renderInlineNodes(node.children, key)}</span>;
    }
  });
}

function CodeBlockView({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback for WebViews without clipboard permission
      const textarea = document.createElement("textarea");
      textarea.value = code;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } finally {
        document.body.removeChild(textarea);
      }
    }
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{language || "code"}</span>
        <button
          aria-label={copied ? "已复制代码" : "复制代码"}
          className="markdown-code-copy"
          onClick={() => void handleCopy()}
          type="button"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre className="markdown-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderBlockNodes(
  blocks: MarkdownBlockNode[],
  keyPrefix = "blk",
  onFileClick?: (filePath: string) => void,
): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (block.type) {
      case "heading": {
        const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
        return (
          <Tag className={`markdown-heading markdown-h${block.level}`} key={key}>
            {renderInlineNodes(block.children, key, onFileClick)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p className="markdown-paragraph" key={key}>
            {renderInlineNodes(block.children, key, onFileClick)}
          </p>
        );
      case "code_block":
        return <CodeBlockView code={block.code} key={key} language={block.language} />;
      case "blockquote":
        return (
          <blockquote className="markdown-blockquote" key={key}>
            {renderBlockNodes(block.blocks, key, onFileClick)}
          </blockquote>
        );
      case "hr":
        return <hr className="markdown-hr" key={key} />;
      case "list": {
        const ListTag = block.ordered ? "ol" : "ul";
        return (
          <ListTag
            className={`markdown-list ${block.ordered ? "ordered" : "unordered"}`}
            key={key}
            {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}
          >
            {block.items.map((item, itemIdx) => {
              const itemKey = `${key}-item-${itemIdx}`;
              return (
                <li
                  className={`markdown-list-item${item.checked !== undefined ? " task-item" : ""}`}
                  key={itemKey}
                >
                  {item.checked !== undefined ? (
                    <>
                      <input
                        checked={item.checked}
                        className="markdown-task-checkbox"
                        disabled
                        readOnly
                        type="checkbox"
                      />
                      <div className="markdown-list-item-body">
                        {renderBlockNodes(item.blocks, itemKey, onFileClick)}
                      </div>
                    </>
                  ) : (
                    renderBlockNodes(item.blocks, itemKey, onFileClick)
                  )}
                </li>
              );
            })}
          </ListTag>
        );
      }
      case "table":
        return (
          <div className="markdown-table-wrap" key={key}>
            <table className="markdown-table">
              <thead>
                <tr>
                  {block.headers.map((headerCells, colIdx) => (
                    <th
                      key={`${key}-th-${colIdx}`}
                      style={block.aligns[colIdx] ? { textAlign: block.aligns[colIdx] } : undefined}
                    >
                      {renderInlineNodes(headerCells, `${key}-th-${colIdx}`, onFileClick)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIdx) => (
                  <tr key={`${key}-tr-${rowIdx}`}>
                    {row.map((cellNodes, colIdx) => (
                      <td
                        key={`${key}-td-${rowIdx}-${colIdx}`}
                        style={
                          block.aligns[colIdx] ? { textAlign: block.aligns[colIdx] } : undefined
                        }
                      >
                        {renderInlineNodes(cellNodes, `${key}-td-${rowIdx}-${colIdx}`, onFileClick)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function MarkdownText({
  text,
  className = "conversation-text markdown-body",
  onFileClick,
  collapsible = true,
}: {
  text: string;
  className?: string;
  onFileClick?: (filePath: string) => void;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const long = collapsible && (text.length > 2_000 || text.split("\n").length > 30);
  const blocks = parseMarkdownBlocks(text);
  if (!long) return <div className={className}>{renderBlockNodes(blocks, "blk", onFileClick)}</div>;
  return (
    <div className="expandable-message">
      <div className={expanded ? undefined : "expandable-message-fold"} inert={!expanded}>
        <div className={className} id={contentId}>{renderBlockNodes(blocks, "blk", onFileClick)}</div>
      </div>
      <button
        type="button"
        className="expandable-message-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "收起" : "展开全文"}
      </button>
    </div>
  );
}
