import { expect, it } from "vitest";
import { scanClaudeContextFromMessages } from "../transcript/claude-history.js";
import { buildTranscriptContextState, projectContextMessages } from "./native-context-usage.js";

it.each(["compactMetadata", "compact_metadata"])("preserves both context consumers across %s and streamed usage", name => {
  for (const segment of ["preservedSegment", "preserved_segment"]) {
    const payload = { ignored: "raw content" };
    const messages = [
      { type: "assistant", uuid: "no-usage", message: { content: payload } },
      { type: "assistant", uuid: "synthetic", isSynthetic: true, message: { model: "<synthetic>", content: payload } },
      { type: "assistant", uuid: "missing-body" },
      { type: "assistant", uuid: "before", message: { id: "m", model: "custom", usage: { input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 4, payload }, content: payload } },
      { type: "assistant", uuid: "chunk", message: { id: "m", usage: { output_tokens: 12 } } },
      { type: "system", uuid: "compact", subtype: "compact_boundary", [name]: { post_tokens: 40, [segment]: { headUuid: "before", tailUuid: "chunk", head_uuid: "no-usage", tail_uuid: "preserved", payload }, payload } },
      { type: "assistant", uuid: "no-usage", message: { id: "replay", usage: { input_tokens: 900 } } },
      { type: "assistant", uuid: "before", message: { id: "replay", usage: { input_tokens: 900 } } },
      { type: "assistant", uuid: "synthetic", isSynthetic: true, message: { usage: { input_tokens: 800 } } },
      { type: "assistant", uuid: "side", isSidechain: true, message: { usage: { input_tokens: 800 } } },
      { type: "assistant", uuid: "child", parent_tool_use_id: "agent", message: { usage: { input_tokens: 800 } } },
      { type: "assistant", uuid: "after", message: { id: "after", model: "custom", usage: { input_tokens: 50, output_tokens: 2 } } },
      { type: "assistant", uuid: "after-2", message: { id: "after", usage: { output_tokens: 9 } } },
    ];
    const projected = projectContextMessages(messages.slice(0, 6)).concat(projectContextMessages(messages.slice(6)));
    expect(scanClaudeContextFromMessages(projected)).toEqual(scanClaudeContextFromMessages(messages));
    expect(buildTranscriptContextState(projected)).toEqual(buildTranscriptContextState(messages));
    expect(scanClaudeContextFromMessages(projected).estimate?.totalTokens).toBe(59);
    expect(buildTranscriptContextState(projected).seenAssistantUuids).toContain("synthetic");
    expect(buildTranscriptContextState(projected).preCompactUuids).toContain("no-usage");
    expect(JSON.stringify(projected)).not.toContain("payload");
    expect(JSON.stringify(projected)).not.toContain("raw content");
    expect(projected[3]).not.toBe(messages[3]);
    expect((projected[3] as typeof messages[3]).message).not.toBe(messages[3]!.message);
  }
});
it("preserves empty camel metadata priority over snake metadata", () => {
  const messages = [{ type: "system", subtype: "compact_boundary", compactMetadata: {}, compact_metadata: { postTokens: 999 } }];
  expect(scanClaudeContextFromMessages(projectContextMessages(messages))).toEqual({ anchored: true });
});
