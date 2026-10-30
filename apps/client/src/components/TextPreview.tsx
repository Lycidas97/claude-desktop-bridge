import type { Emitter } from "highlight.js";
import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import latex from "highlight.js/lib/languages/latex";
import { useMemo, type ReactNode } from "react";
import { textPreviewLanguage } from "../lib/media-preview.js";
import { MarkdownText } from "./MarkdownText.js";
import "./text-preview.css";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("latex", latex);

type HighlightToken = string | { scope?: string; children: HighlightToken[] };

function renderTokens(tokens: HighlightToken[]): ReactNode[] {
  return tokens.map((token, index) => {
    if (typeof token === "string") return token;
    // Read highlight.js' token tree so file contents remain React text nodes.
    const className = token.scope?.startsWith("language:")
      ? token.scope.replace("language:", "language-")
      : token.scope?.split(".").map((part, level) => level ? `${part}${"_".repeat(level)}` : `hljs-${part}`).join(" ");
    return <span key={index} className={className}>{renderTokens(token.children)}</span>;
  });
}

export function TextPreview({ text, name, source }: { text: string; name: string; source: boolean }) {
  const language = textPreviewLanguage(name);
  const code = useMemo(() => {
    if (!language || (language === "markdown" && !source) || !hljs.getLanguage(language)) return text;
    // The installed highlight.js 11 emitter exposes the parsed root without HTML.
    const { rootNode } = hljs.highlight(text, { language, ignoreIllegals: true })._emitter as Emitter & { rootNode: { children: HighlightToken[] } };
    return renderTokens(rootNode.children);
  }, [text, language, source]);

  if (language === "markdown" && !source) {
    return <MarkdownText text={text} className="text-preview-markdown conversation-text markdown-body" collapsible={false} />;
  }
  return <pre className="text-preview-source" aria-label={`${name} 全文`}><code className={language ? `hljs language-${language}` : undefined}>{code}</code></pre>;
}
