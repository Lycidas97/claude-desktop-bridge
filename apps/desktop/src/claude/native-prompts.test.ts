import { describe, expect, it } from "vitest";
import { nativePendingPrompts } from "./native-prompts.js";

const inspector = { supports: () => true, promptChoices: async () => ["native-confirm", "native-cancel"] };

describe("Native consent review regression", () => {
  it("preserves lanyard authorization from the actual Native payload fields", async () => {
    const [prompt] = await nativePendingPrompts({ sessionId: "owned-session", pendingLanyardConsent: {
      promptId: "lanyard", targetKind: "channel", title: "Access confirmation",
      lead: "Read and post in this channel", bullets: ["Read channel history", "Post messages"],
      channelId: "owned-channel-id", channelName: "owned-channel", workspace: "Owned workspace",
      permalink: "https://example.invalid/channel", postsIntro: "Post messages as",
      postsAs: "Owned actor", postsLabelled: "AI", pollIntervalSeconds: 60,
      externallyShared: true,
    } }, inspector);
    for (const disclosure of ["Read and post in this channel", "Read channel history", "Post messages",
      "owned-channel", "Owned workspace", "https://example.invalid/channel", "Post messages as", "Owned actor", "AI", "60"]) {
      expect(prompt?.message).toContain(disclosure);
    }
    expect(prompt).toMatchObject({ canRespond: true, choices: [{ value: "native-confirm" }, { value: "native-cancel" }] });
  });

  it("preserves lanyard replacement disclosure and the original channel reference", async () => {
    const [prompt] = await nativePendingPrompts({ sessionId: "owned-session", pendingLanyardConsent: {
      promptId: "owned-replacement-prompt", targetKind: "channel", title: "Change connected channel",
      lead: "Connect the selected channel", bullets: ["Read new channel history"],
      channelId: "owned-new-channel-id", channelName: "owned-new-channel", workspace: "Owned workspace",
      permalink: "https://example.invalid/owned-new-channel", postsIntro: "Post as", postsAs: "Owned account",
      postsLabelled: "AI", pollIntervalSeconds: 60,
      replaces: { disclosure: "This replaces the existing connection to the old channel.", channelName: "owned-old-channel", threadStarted: "owned-old-thread", permalink: "https://example.invalid/owned-old-channel" },
    } }, inspector);
    expect(prompt?.canRespond).toBe(true);
    for (const disclosure of ["This replaces the existing connection to the old channel.", "owned-old-channel",
      "owned-old-thread", "https://example.invalid/owned-old-channel", "owned-new-channel", "https://example.invalid/owned-new-channel"]) {
      expect(prompt?.message).toContain(disclosure);
    }
  });

  it("preserves violin file operation disclosure from the actual Native payload fields", async () => {
    const [prompt] = await nativePendingPrompts({ sessionId: "owned-session", pendingViolinBowPrompt: {
      promptId: "violin", title: "Confirm operation", kind: "copy",
      body: "Copy selected files", detail: "Move files to the target machine", offer: "Copy now",
      folder: "/owned/source", launchFolder: "/owned/target", machineName: "Owned machine",
      fileCount: 2, totalBytes: 123, attempts: 1, lastError: "Previous copy failed",
    } }, inspector);
    for (const disclosure of ["Copy selected files", "Move files to the target machine", "Copy now",
      "/owned/source", "/owned/target", "Owned machine", "2", "123", "Previous copy failed"]) {
      expect(prompt?.message).toContain(disclosure);
    }
    expect(prompt?.canRespond).toBe(true);
  });

  it.each(["pendingLanyardConsent", "pendingViolinBowPrompt"] as const)("keeps %s read only when its authorization disclosure is absent", async field => {
    const [prompt] = await nativePendingPrompts({ sessionId: "owned-session", [field]: { promptId: "empty", title: "Confirm" } }, inspector);
    expect(prompt?.canRespond).toBe(false);
  });
});
