import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sessionId, originalTitle } from "../config.mjs";
import { eventually, openMobileDrawer, openMobileSession, selectCustomOption, customSelectValue } from "../helpers.mjs";

export async function verifyNativeMessages(page, host, steps, directory) {
  const fiveId = "browser-e2e-five-images";
  const singleId = "browser-e2e-single-image";
  const correctedId = "browser-e2e-corrected-result";
  const photos = await page.evaluate(() => ["#a84d2e", "#2c6873", "#596d42", "#6c527e", "#a17328"].map((color, index) => {
    const canvas = document.createElement("canvas");
    canvas.width = 420;
    canvas.height = 280;
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.font = "bold 96px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(index + 1), 210, 140);
    return canvas.toDataURL("image/png").split(",")[1];
  }));
  const attachments = photos.map((data, imageIndex) => {
    const bytes = Buffer.from(data, "base64");
    host.nativeImages.set(`${fiveId}:${imageIndex}`, bytes);
    return { id: `native-image:${fiveId}:${imageIndex}`, name: `image-${imageIndex + 1}.png`, mimeType: "image/png", size: bytes.length, nativeImage: { messageUuid: fiveId, imageIndex } };
  });
  host.nativeImages.set(`${singleId}:0`, Buffer.from(photos[0], "base64"));
  host.history.push(
    { id: singleId, sessionId, role: "user", text: "单图隔离消息", createdAt: Date.now() - 1000, origin: "claude-desktop", delivery: "completed", attachments: [{ ...attachments[0], id: `native-image:${singleId}:0`, nativeImage: { messageUuid: singleId, imageIndex: 0 } }] },
    { id: fiveId, sessionId, role: "user", text: "五图隔离消息", createdAt: Date.now(), origin: "claude-desktop", delivery: "queued", attachments },
    { id: correctedId, sessionId, role: "user", text: "终态纠正消息", createdAt: Date.now() + 1, origin: "claude-desktop", delivery: "queued" },
  );
  await openMobileSession(page);
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const five = page.locator("article.conversation-item.user").filter({ hasText: "五图隔离消息" });
  async function loadFiveThumbnails() {
    await eventually(() => five.locator(".conversation-image-preview").count(), 5, "Native history preserves all five image slots");
    for (const slot of await five.locator(".conversation-image-preview").all()) {
      await slot.scrollIntoViewIfNeeded();
      await eventually(() => slot.locator("img").count(), 1, "A visible native thumbnail loads through its image reference");
      await eventually(() => slot.locator("img").evaluate(node => node.complete && node.naturalWidth > 0), true, "Each native thumbnail decodes successfully");
    }
  }
  await loadFiveThumbnails();
  assert.match(await five.innerText(), /排队/u);
  await page.screenshot({ path: resolve(directory, "native-five-images.png"), fullPage: true });
  await five.locator("img").first().click();
  const viewer = page.getByRole("dialog").last();
  await viewer.waitFor();
  await eventually(() => viewer.locator("img").evaluate(node => node.complete && node.naturalWidth > 0), true, "Original native image opens in the media viewer");
  await page.screenshot({ path: resolve(directory, "native-image-viewer.png"), fullPage: true });
  await viewer.getByRole("button", { name: /关闭/u }).first().click();
  assert.ok(host.requests.some(request => request.method === "artifact.transfer.open" && request.params.nativeImage?.messageUuid === fiveId));
  assert.equal(JSON.stringify(host.history).includes(photos[0]), false, "History carries references without original image data");
  steps.push("single/five-image history uses reference-based lazy thumbnails and the existing full-image viewer");

  await host.emit("turn.started", { messageId: fiveId, delivery: "running" }, { itemId: fiveId, turnId: fiveId });
  await eventually(async () => /处理中|开始处理/u.test(await five.innerText()), true, "The exact queued message visibly starts processing");
  await host.emit("user.message.accepted", { text: "五图隔离消息", attachments, delivery: "session-received", messageId: fiveId }, { itemId: fiveId });
  await eventually(async () => /处理中|开始处理/u.test(await five.innerText()), true, "A late accepted event does not regress running delivery");
  await loadFiveThumbnails();
  await host.emit("turn.completed", {});
  assert.match(await five.innerText(), /处理中|开始处理/u, "Unrelated native completion does not complete this message");
  await host.emit("turn.completed", { messageId: fiveId, delivery: "completed" }, { itemId: fiveId, turnId: fiveId });
  await eventually(async () => /已完成/u.test(await five.innerText()), true, "Only the matching native UUID completes the message");
  host.history.find(item => item.id === fiveId).delivery = "completed";
  steps.push("native queued → processing → completed follows message UUIDs and ignores unrelated results");
  const corrected = page.locator("article.conversation-item.user").filter({ hasText: "终态纠正消息" });
  await host.emit("turn.completed", { messageId: correctedId, delivery: "completed" }, { itemId: correctedId, turnId: correctedId });
  await host.emit("turn.failed", { messageId: correctedId, delivery: "failed", error: "隔离结果确认失败" }, { itemId: correctedId, turnId: correctedId });
  await eventually(async () => /失败/u.test(await corrected.innerText()), true, "A real matching failure corrects an earlier generic completion without a local turn");
  host.history.find(item => item.id === correctedId).delivery = "failed";
  steps.push("an authoritative matching result can correct the earlier terminal status");

  const assistantId = "browser-e2e-stream-final";
  await host.emit("assistant.delta", { text: "旧的流式片段" }, { itemId: assistantId });
  await host.emit("assistant.completed", { text: "流式完成内容" }, { itemId: assistantId });
  await host.emit("assistant.delta", { text: "旧的流式片段" }, { itemId: assistantId });
  await page.getByText("流式完成内容", { exact: true }).waitFor();
  assert.equal(await page.getByText("旧的流式片段", { exact: true }).count(), 0);
  assert.equal(await page.locator(".stream-caret").count(), 0);
  host.history.push({ id: assistantId, sessionId, role: "assistant", text: "流式完成内容", createdAt: Date.now(), origin: "claude-desktop" });
  steps.push("completion without a turnId retains final content and shows no per-message blinking caret");

  for (const terminal of ["completed", "observed", "without-turn"]) {
    const id = `browser-e2e-long-${terminal}`;
    const turn = terminal === "completed" ? { turnId: `${id}-turn` } : {};
    const text = `${id}\n\n${"这条长回复正在阅读，输出结束后应保持展开。\n\n".repeat(100)}`;
    const message = page.locator("article.conversation-item.assistant").filter({ hasText: id });
    await host.emit("assistant.delta", { text }, { itemId: id });
    await message.waitFor();
    assert.equal(await message.locator(".expandable-message-fold").count(), 0, "Streaming replies are fully expanded");
    await host.emit(terminal === "observed" ? "session.observed" : "assistant.completed", { text, role: "assistant" }, { itemId: id, ...turn });
    await eventually(() => message.locator(".expandable-message-toggle").getAttribute("aria-expanded"), "true", "A long reply read live stays expanded after native completion");
    assert.equal(await message.locator("[inert]").count(), 0, "The completed reply remains accessible");
    await message.getByRole("button", { name: "收起", exact: true }).click();
    await message.getByRole("button", { name: "展开全文", exact: true }).waitFor();
    await host.emit("assistant.completed", { text: "后续回复不应重新展开已手动收起的消息" }, { itemId: `${id}-next` });
    assert.equal(await message.locator(".expandable-message-toggle").getAttribute("aria-expanded"), "false", "Later messages preserve a manual collapse");
    await message.getByRole("button", { name: "展开全文", exact: true }).click();
    host.history.push({ id, sessionId, role: "assistant", text, createdAt: Date.now(), origin: "claude-desktop", ...turn });
  }
  await page.screenshot({ path: resolve(directory, "live-reply-stays-expanded.png"), fullPage: true });
  steps.push("long streamed replies stay expanded after completed/observed finalization and still support manual collapse and expansion");

  assert.match(host.session.model, /^mythos-magpie-/u, "The header test must receive a native internal model alias");
  const settingsButton = page.getByRole("button", { name: "会话设置", exact: true });
  await eventually(async () => (await settingsButton.innerText()).includes("隔离模型 · 标准"), true, "Initial native alias snapshot uses its saved header label before opening configuration");
  const modelLabel = await settingsButton.getByText("隔离模型 · 标准", { exact: true }).boundingBox();
  const permissionLabel = await settingsButton.getByText("逐个确认", { exact: true }).boundingBox();
  const chevron = await settingsButton.locator("svg").boundingBox();
  assert.ok(modelLabel && permissionLabel && chevron, "The header must show the model, permission mode and chevron");
  assert.ok(permissionLabel.y >= modelLabel.y + modelLabel.height, "The 逐个确认 permission mode is below the model at 375px");
  assert.ok(chevron.x >= permissionLabel.x + permissionLabel.width - 1, "The chevron follows the permission mode");
  await settingsButton.click();
  const configuration = page.getByRole("dialog", { name: originalTitle, exact: true });
  const modelSelect = configuration.getByRole("combobox", { name: "模型", exact: true });
  await eventually(() => customSelectValue(modelSelect), "synthetic-model", "Native alias selects the matching original model ID in the picker");
  const effortGroup = configuration.getByRole("group", { name: /^思考强度/u });
  await eventually(() => effortGroup.getByRole("button").allTextContents(), ["默认", "低", "高", "最大"], "Only native effort levels are offered, after Default");
  await page.screenshot({ path: resolve(directory, "native-effort-availability.png"), fullPage: true });
  steps.push("gateway-only effort levels are not offered in session configuration");
  await modelSelect.click();
  const modelListbox = page.getByRole("listbox");
  await modelListbox.waitFor();
  await eventually(() => modelListbox.getByRole("option").evaluateAll(options => options
    .map(option => ({
      value: option.getAttribute("data-option-value") ?? "",
      text: option.querySelector(".select-menu-option-label")?.textContent ?? option.textContent ?? "",
    }))
    .filter(option => option.value.startsWith("synthetic-model"))), [
    { value: "synthetic-model", text: "隔离模型 · 标准" },
    { value: "synthetic-model-large[1m]", text: "隔离模型 · 长上下文" },
  ], "Saved model labels and original IDs are shown in saved order");
  const largeOptionIdx = await modelListbox.getByRole("option").evaluateAll(els => els.findIndex(el => el.getAttribute("data-option-value") === "synthetic-model-large[1m]"));
  assert.ok(largeOptionIdx >= 0, "Long-context model option must exist");
  await modelListbox.getByRole("option").nth(largeOptionIdx).click();
  await configuration.getByRole("button", { name: "保存配置", exact: true }).click();
  await configuration.waitFor({ state: "hidden" });
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setModel").at(-1).args, [sessionId, "mythos-magpie-1826500494[1m]"]);
  await eventually(async () => (await page.getByRole("button", { name: "会话设置", exact: true }).innerText()).includes("隔离模型 · 长上下文"), true, "Session header uses the saved display label");
  assert.match(host.session.model, /^mythos-magpie-.*\[1m\]$/u);
  await page.screenshot({ path: resolve(directory, "native-model-labels.png"), fullPage: true });
  steps.push("native internal aliases resolve to saved header labels before configuration, picker selection uses the canonical ID, and long-context selection keeps its full ID");

  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  await loadFiveThumbnails();
  await eventually(async () => (await page.getByRole("button", { name: "会话设置", exact: true }).innerText()).includes("隔离模型 · 长上下文"), true, "Reloaded native alias snapshot retains the saved header label");
  assert.match(await five.innerText(), /已完成/u);
  assert.equal(await page.locator(".stream-caret").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  steps.push("reloading restores completed delivery and five-image metadata without original bytes in cached history");
  for (const terminal of ["completed", "observed", "without-turn"]) {
    const message = page.locator("article.conversation-item.assistant").filter({ hasText: `browser-e2e-long-${terminal}` });
    await message.getByRole("button", { name: "展开全文", exact: true }).waitFor();
    assert.equal(await message.locator(".expandable-message-toggle").getAttribute("aria-expanded"), "false", "Reopened history starts collapsed even when it was read live before reload");
  }
  steps.push("reopened historical replies start collapsed without retaining the previous live-reading state");

  const geminiModel = ["antigravity", "gemini-4-argon"].join("/");
  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  await selectCustomOption(page, modelSelect, geminiModel);
  await configuration.getByRole("button", { name: "保存配置", exact: true }).click();
  await configuration.waitFor({ state: "hidden" });
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setModel").at(-1).args, [sessionId, ["mythos", "magpie", "1052229916"].join("-")]);
  await eventually(async () => (await page.getByRole("button", { name: "会话设置", exact: true }).innerText()).includes("Gemini 4 Argon · Antigravity · 1M"), true, "Native preferred 1M normalization succeeds and the header shows the actual context");
  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  await eventually(() => customSelectValue(modelSelect), `${geminiModel}[1m]`, "Reopening configuration selects the observed Gemini 1M variant");
  assert.ok((await modelSelect.innerText()).includes("1M"));
  assert.equal((await configuration.innerText()).includes("Desktop did not apply"), false);
  await page.screenshot({ path: resolve(directory, "native-gemini-preferred-context.png"), fullPage: true });
  steps.push("Gemini saves through the real Native facade when Desktop prefers 1M, and reopening configuration shows its observed model and context without a false failure");

  const styleSelect = configuration.getByRole("combobox", { name: "输出风格", exact: true });
  await eventually(() => customSelectValue(styleSelect), "default", "Existing session initially displays Desktop's current style");
  await selectCustomOption(page, styleSelect, "Fixture project style");
  const beforeStyleSave = host.nativeApproval.calls.length;
  await configuration.getByRole("button", { name: "保存配置", exact: true }).click();
  await configuration.waitFor({ state: "hidden" });
  assert.equal(host.nativeApproval.calls.slice(beforeStyleSave).some(call => ["setModel", "setEffort", "setPermissionMode"].includes(call.method)), false);
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "applyFlagSettings").at(-1).args,
    [sessionId, { outputStyle: "Fixture project style" }]);
  await settingsButton.getByText("Fixture project style", { exact: true }).waitFor();
  await settingsButton.click();
  await eventually(() => customSelectValue(styleSelect), "Fixture project style", "Reopened settings read back the session's custom style");
  await page.screenshot({ path: resolve(directory, "native-output-style.png"), fullPage: true });
  steps.push("Existing session applies a project style through Desktop and shows it in the header and settings");
}

export async function verifyHistoryPagination(page, host, steps, directory) {
  const now = Date.now();
  for (let index = 0; index < 120; index += 1) host.history.push({
    id: `browser-e2e-history-${String(index).padStart(3, "0")}`, sessionId,
    role: index % 2 ? "assistant" : "user",
    text: `历史条目 ${String(index + 1).padStart(3, "0")}。${"这段内容仅用于隔离分页与滚动位置验收。".repeat(3)}`,
    createdAt: now - (120 - index) * 1000, origin: "claude-desktop",
  });
  await openMobileSession(page);
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const stream = page.locator(".conversation-stream");
  await eventually(() => stream.locator("article.conversation-item").count(), 50, "Opening a session renders the larger first page");
  assert.equal(host.requests.filter(request => request.method === "session.open").at(-1).params.limit, 50);
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await eventually(() => stream.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop < 4), true, "Initial session entry keeps the latest messages visible");
  await stream.evaluate(root => {
    root.scrollTop = root.scrollHeight;
    root.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(host.requests.filter(request => request.method === "session.history").length, 0, "Opening and ordinary bottom scrolling do not drain older pages");
  steps.push("first page requests and renders 50 records while retaining initial bottom positioning");

  const captureTop = () => stream.evaluate(root => {
    root.scrollTop = 0;
    const rect = root.getBoundingClientRect();
    const node = [...root.querySelectorAll("[data-stream-key]")].find(candidate => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.bottom > rect.top + 1 && bounds.top < rect.bottom;
    });
    if (!node) throw new Error("A visible history anchor is required");
    const anchor = { key: node.getAttribute("data-stream-key"), offset: node.getBoundingClientRect().top - rect.top, height: root.scrollHeight };
    for (let index = 0; index < 5; index += 1) root.dispatchEvent(new Event("scroll"));
    return anchor;
  });
  let anchorSequence = 0;
  const assertAnchor = async anchor => {
    let actual;
    try {
      await eventually(async () => {
        actual = await stream.evaluate((root, expected) => {
          const node = [...root.querySelectorAll("[data-stream-key]")].find(candidate => candidate.getAttribute("data-stream-key") === expected.key);
          return { offset: node ? node.getBoundingClientRect().top - root.getBoundingClientRect().top : null,
            scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
        }, anchor);
        return actual.offset !== null && Math.abs(actual.offset - anchor.offset) <= 4;
      }, true, "Prepending history preserves the previous visible message offset");
    } finally {
      await writeFile(resolve(directory, `history-anchor-${++anchorSequence}.json`), JSON.stringify({ expected: anchor, actual }, null, 2));
    }
  };
  let release;
  host.historyGate = new Promise(resolve => { release = resolve; });
  const anchor = await captureTop();
  try {
    await eventually(() => host.requests.filter(request => request.method === "session.history").length, 1, "Reaching the top automatically requests the next page once");
    await stream.evaluate(root => { for (let index = 0; index < 5; index += 1) root.dispatchEvent(new Event("scroll")); });
    assert.equal(host.requests.filter(request => request.method === "session.history").length, 1, "Repeated top scrolls cannot duplicate an in-flight cursor");
    await stream.evaluate(root => { root.scrollTop = root.scrollHeight; root.dispatchEvent(new Event("scroll")); });
    host.snapshot.sessions.find(session => session.sessionId === sessionId).lastCompletedTurnId = "result-during-pagination";
    await host.send({ kind: "snapshot", snapshot: host.snapshot });
    await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? "{}")[id] === "result-during-pagination", { key: `bridge-seen-session-completions:${host.pairing.roomId}`, id: sessionId });
    // Update the scroll handler's anchor before releasing the pending page.
    await stream.evaluate(root => { root.scrollTop = 0; root.dispatchEvent(new Event("scroll")); });
    steps.push("the visible conversation acknowledges a completion while the older page is pending");
  } finally {
    host.historyGate = undefined;
    release();
  }
  await eventually(() => stream.evaluate((root, height) => root.scrollHeight > height + 100, anchor.height), true, "The preceding page is prepended into the real scroll container");
  await assertAnchor(anchor);
  assert.ok(await stream.evaluate(root => root.scrollTop > 32), "Prepend compensation leaves the top trigger area");
  const firstPage = host.requests.filter(request => request.method === "session.history")[0];
  assert.equal(firstPage.params.limit, 50);
  assert.equal(firstPage.params.cursor, "browser-e2e-history-070");
  await page.screenshot({ path: resolve(directory, "history-prepend-anchor.png"), fullPage: true });
  steps.push("top scrolling loads 50 older records once and preserves the same visible message position");

  host.failHistoryOnce = true;
  await captureTop();
  await page.getByText(/隔离历史请求失败/u).first().waitFor();
  await stream.evaluate(root => { for (let index = 0; index < 5; index += 1) root.dispatchEvent(new Event("scroll")); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(host.requests.filter(request => request.method === "session.history").length, 2, "A failed automatic request does not retry on every scroll event");
  const beforeRetry = await stream.evaluate(root => {
    const rect = root.getBoundingClientRect();
    const node = [...root.querySelectorAll("[data-stream-key]")].find(candidate => candidate.getBoundingClientRect().bottom > rect.top + 1);
    return { key: node.getAttribute("data-stream-key"), offset: node.getBoundingClientRect().top - rect.top };
  });
  let releaseRetry;
  host.historyGate = new Promise(resolve => { releaseRetry = resolve; });
  await page.getByRole("button", { name: "重试加载更早消息", exact: true }).click();
  await eventually(() => host.requests.filter(request => request.method === "session.history").length, 3, "The retry button explicitly retries the retained cursor");
  // The retried page lands while a new chat opened from ⋯ covers the conversation.
  const itemsBeforeRetry = await stream.locator("article.conversation-item").count();
  await page.locator(".m-header:visible").getByRole("button", { name: "会话操作", exact: true }).click();
  await page.locator(".m-sheet").getByRole("button", { name: "新建会话", exact: true }).click();
  await page.locator(".new-chat-canvas").getByRole("heading", { name: "新建会话", exact: true }).waitFor();
  host.historyGate = undefined;
  releaseRetry();
  await eventually(async () => await stream.locator("article.conversation-item").count() > itemsBeforeRetry, true, "The retried page is prepended while the conversation is hidden");
  await page.locator(".m-header:visible").getByRole("button", { name: "返回会话", exact: true }).click();
  await stream.locator(".load-older-button").waitFor({ state: "hidden" });
  await assertAnchor(beforeRetry);
  const older = host.requests.filter(request => request.method === "session.history");
  assert.equal(older[1].params.cursor, "browser-e2e-history-020");
  assert.equal(older[2].params.cursor, older[1].params.cursor);
  await captureTop();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(host.requests.filter(request => request.method === "session.history").length, 3, "The terminal page stops further automatic requests");
  const keys = await stream.locator("[data-stream-key]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-stream-key")));
  assert.equal(new Set(keys).size, keys.length, "History pages do not duplicate visible message identities");
  assert.equal(host.requests.filter(request => request.method === "turn.start" || request.method === "turn.steer").length, 0);
  await page.screenshot({ path: resolve(directory, "history-pagination-complete.png"), fullPage: true });
  steps.push("failed paging preserves data/cursor for manual retry; a retried page that lands behind new chat preserves the anchor, and the last page stops loading");

  await stream.evaluate(root => { root.scrollTop = root.scrollHeight; root.dispatchEvent(new Event("scroll")); });
  const streaming = stream.locator("article.conversation-item.assistant").filter({ hasText: "流式滚动起始片段" });
  await host.emit("assistant.delta", { text: `流式滚动起始片段。\n\n${"持续输出用于滚动位置验收。\n\n".repeat(8)}` }, { turnId: "scroll-follow-turn", itemId: "scroll-follow-message" });
  await streaming.waitFor();
  await eventually(() => stream.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop < 4), true, "Streaming follows when the reader stays at the bottom");
  for (const distance of [80, 40, 640]) {
    const before = await stream.evaluate((root, distance) => {
      root.scrollTop = root.scrollHeight - root.clientHeight - distance;
      root.dispatchEvent(new Event("scroll"));
      return root.scrollTop;
    }, distance);
    const marker = `上翻 ${distance}px 后的流式片段`;
    await host.emit("assistant.delta", { text: `\n\n${marker}。${"新输出不应打断历史阅读。".repeat(6)}` }, { turnId: "scroll-follow-turn", itemId: "scroll-follow-message" });
    await streaming.filter({ hasText: marker }).waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await stream.evaluate(root => root.scrollTop);
    await writeFile(resolve(directory, `stream-scroll-${distance}.json`), JSON.stringify({ distance, before, after }, null, 2));
    await page.screenshot({ path: resolve(directory, `stream-scroll-${distance}.png`), fullPage: true });
    assert.ok(Math.abs(after - before) <= 4, `Streaming must preserve the reader's position after scrolling up ${distance}px: ${before} -> ${after}`);
    await stream.evaluate(root => { root.scrollTop = root.scrollHeight; root.dispatchEvent(new Event("scroll")); });
    await host.emit("assistant.delta", { text: `\n\n回到底部后恢复跟随 ${distance}。${"继续输出。".repeat(12)}` }, { turnId: "scroll-follow-turn", itemId: "scroll-follow-message" });
    await streaming.filter({ hasText: `回到底部后恢复跟随 ${distance}` }).waitFor();
    await eventually(() => stream.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop < 4), true, "Returning to the bottom resumes streaming follow");
  }
  steps.push("streaming follows at the bottom, preserves the reader's position after 40/80/640px upward scrolling, and follows again only after returning to the bottom");

  const opensBefore = host.requests.filter(request => request.method === "session.open").length;
  const itemsBefore = await stream.locator("article.conversation-item").count();
  const reading = await stream.evaluate(root => {
    root.scrollTop = Math.floor(root.scrollHeight / 3);
    root.dispatchEvent(new Event("scroll"));
    const rect = root.getBoundingClientRect();
    const node = [...root.querySelectorAll("[data-stream-key]")].find(candidate => candidate.getBoundingClientRect().bottom > rect.top + 1);
    return { key: node.getAttribute("data-stream-key"), offset: node.getBoundingClientRect().top - rect.top };
  });
  await page.locator(".m-header:visible").getByRole("button", { name: "会话操作", exact: true }).click();
  await page.locator(".m-sheet").getByRole("button", { name: "新建会话", exact: true }).click();
  await page.locator(".new-chat-canvas").getByRole("heading", { name: "新建会话", exact: true }).waitFor();
  // Streaming continues while the conversation is hidden underneath the new chat.
  await host.emit("assistant.delta", { text: `\n\n新建页停留期间的流式片段。${"隐藏时的输出不应改动阅读位置。".repeat(6)}` }, { turnId: "scroll-follow-turn", itemId: "scroll-follow-message" });
  await streaming.filter({ hasText: "新建页停留期间的流式片段" }).waitFor({ state: "attached" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator(".m-header:visible").getByRole("button", { name: "返回会话", exact: true }).click();
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  await assertAnchor(reading);
  assert.equal(await stream.locator("article.conversation-item").count(), itemsBefore, "Returning from new chat keeps the loaded older pages");
  assert.equal(host.requests.filter(request => request.method === "session.open").length, opensBefore, "Returning from new chat does not reopen the session");
  steps.push("cancelling a new chat opened from the conversation ⋯ returns to the same loaded pages and reading position without session.open, even after a streaming update arrived while hidden");

  await stream.evaluate(root => { root.scrollTop = root.scrollHeight; root.dispatchEvent(new Event("scroll")); });
  await page.locator(".m-header:visible").getByRole("button", { name: "会话操作", exact: true }).click();
  await page.locator(".m-sheet").getByRole("button", { name: "新建会话", exact: true }).click();
  await page.locator(".new-chat-canvas").getByRole("heading", { name: "新建会话", exact: true }).waitFor();
  await host.emit("assistant.delta", { text: `\n\n新建页停留期间的跟随片段。${"跟随底部的读者回来后应看到最新输出。".repeat(6)}` }, { turnId: "scroll-follow-turn", itemId: "scroll-follow-message" });
  await streaming.filter({ hasText: "新建页停留期间的跟随片段" }).waitFor({ state: "attached" });
  await page.locator(".m-header:visible").getByRole("button", { name: "返回会话", exact: true }).click();
  await eventually(() => stream.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop < 4), true, "A reader following the bottom sees output that arrived while the new chat was open");
  steps.push("a reader following the bottom returns from new chat to the output streamed while hidden");
}

export async function verifyNativeCompaction(page, host, steps, directory) {
  const row = page.locator(`.mobile-home-catalog [data-session-id="${sessionId}"]`);
  await openMobileSession(page);
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "system", subtype: "status", status: "compacting" } }));
  await eventually(() => page.locator(".session-activity-label").innerText(), "正在压缩上下文", "Native compaction replaces generic activity even with queued input");
  assert.equal(await page.locator(".session-activity-elapsed").count(), 0, "User turn age is not shown as compaction duration");
  await page.screenshot({ path: resolve(directory, "native-compaction.png"), fullPage: true });
  await openMobileDrawer(page);
  await eventually(() => row.locator(".session-row-status:not([aria-label])").innerText(), "正在压缩上下文", "Catalog badge shares the observed compaction status");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileDrawer(page);
  await row.waitFor();
  await eventually(() => row.locator(".session-row-status:not([aria-label])").innerText(), "正在压缩上下文", "Reconnect snapshot retains current compaction status");
  assert.equal(await row.getByLabel("1 条排队消息", { exact: true }).innerText(), "1", "Compaction retains the independent pending count after reconnect");
  await row.locator(".session-row-hit").click();
  await eventually(() => page.locator(".session-activity-label").innerText(), "正在压缩上下文", "Reopening a compacting session restores its activity line");
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "system", subtype: "status", status: null, compact_result: "success" } }));
  await eventually(() => page.locator(".session-activity.compacting").count(), 0, "Native status clear restores regular activity");
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "system", subtype: "status", status: "compacting" } }));
  await eventually(() => page.locator(".session-activity.compacting").count(), 1, "A later automatic compaction can start independently of input text");
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "system", subtype: "compact_boundary", uuid: "browser-compact-boundary" } }));
  await eventually(() => page.locator(".session-activity.compacting").count(), 0, "Compaction boundary restores regular activity");
  assert.equal(host.requests.filter(request => request.method === "turn.start" || request.method === "turn.steer").length, 0, "Observing compaction never submits a command");
  steps.push("Native status drives compaction activity and catalog badge, survives reconnect, and clears on Native status/boundary without a timer or command-text guess");
}

export async function verifyNativeBoundaries(page, host, steps, directory) {
  const markdownName = "NATIVE-CHAIN-author-database-current.zh.md";
  await writeFile(resolve(host.nativeApproval.harnessCwd, "empty.txt"), "");
  await writeFile(resolve(host.nativeApproval.harnessCwd, markdownName), [
    "# 手机文件预览",
    ...Array.from({ length: 4 }, () => "段首可见，中文长段落应当在手机宽度内自然换行，段尾也必须完整显示。".repeat(15)),
    `\`\`\`text\n${"wide-code-".repeat(40)}\n\`\`\``,
    `| ${Array.from({ length: 6 }, (_, index) => `wide-column-${index}`).join(" | ")} |\n|${" --- |".repeat(6)}\n|${" value |".repeat(6)}`,
  ].join("\n\n"));
  const tool = (id, input, name = "mcp__ccd_turn__update_plan") => ({ type: "assistant", uuid: id, timestamp: Date.now(), message: { content: [{ type: "tool_use", id, name, input }] } });
  const planItems = [{ content: "读取报告", status: "in_progress" }, { content: "验证文件", status: "pending" }];
  const archiveName = "会话交付.tar.gz";
  const archiveBytes = Buffer.from("synthetic file download\n");
  await writeFile(resolve(host.nativeApproval.harnessCwd, archiveName), archiveBytes);
  const outsideFile = resolve(host.nativeApproval.harnessCwd, "../../../../工作区外的文件.txt");
  await writeFile(outsideFile, "This file must stay on the host.");
  await writeFile(resolve(host.nativeApproval.harnessCwd, ".env.example"), "EXAMPLE=fixture");
  const initial = [
    tool("boundary-send-file", { files: ["说明 notes.md", archiveName, outsideFile, ".env.example", "未发送.bin"] }, "SendUserFile"),
    { type: "user", uuid: "boundary-send-file-result", timestamp: Date.now(), message: { content: [{
      type: "tool_result", tool_use_id: "boundary-send-file", content: [{ type: "text", text: "Files sent" }],
    }] }, toolUseResult: { attachments: [
      ...["说明 notes.md", archiveName, outsideFile, ".env.example"].map(path => ({ path, size: 32, isImage: false })),
      { path: "未发送.bin", size: 12, isImage: false, upload_error: "Native delivery failed" },
    ] } },
    tool("boundary-plan", { scope: "first_task", items: planItems }),
    { ...tool("child-plan", { scope: "first_task", items: [{ content: "子代理内部计划", status: "in_progress" }] }), isSidechain: true },
    { ...tool("child-wrap", { recap: "Child done" }, "mcp__ccd_turn__wrap_up"), isSidechain: true },
    ...["isCompactSummary", "isMeta", "isSynthetic", "isVisibleInTranscriptOnly"].map(flag => ({ type: "user", uuid: `hidden-${flag}`, [flag]: true, message: { content: "INTERNAL_COMPACT_SUMMARY_MUST_STAY_HIDDEN" } })),
    { type: "assistant", uuid: "boundary-files", timestamp: Date.now(), message: { id: "boundary-files", content: [{ type: "text", text: `[相对报告](report.json) · [子目录报告](shell-report.txt) · [绝对报告](<${host.nativeApproval.harnessCwd}/report.json:12:3>) · [说明预览](<说明 notes.md>) · [长文预览](${markdownName}) · [空文件预览](empty.txt)` }] } },
  ];
  for (const message of initial) await host.nativeApproval.message(message);
  const subagentStartAt = Date.now() - 30_000;
  await host.nativeApproval.message({
    type: "system",
    subtype: "task_started",
    task_id: "boundary-bg-subagent",
    tool_use_id: "boundary-bg-call",
    description: "Run full local distributed CI",
    timestamp: subagentStartAt,
  });
  host.session.runningSubagents = host.nativeApproval.session().runningSubagents;
  assert.deepEqual(host.session.runningSubagents, { count: 1, lastUpdatedAt: subagentStartAt });
  await host.emit("runtime.updated", { replaceSession: true, session: structuredClone(host.session) }, { itemId: "session:subagent-activity" });
  await openMobileDrawer(page);
  const catalogRow = page.locator(`.mobile-home-catalog [data-session-id="${sessionId}"]`);
  await eventually(() => catalogRow.locator(".session-state-dot.running").count(), 1, "Catalog row dot reflects running background subagent when main turn is idle");
  await eventually(() => catalogRow.locator(".session-row-status.running").innerText(), "后台子代理", "Catalog row badge displays running background subagent");
  const nativePage = await host.nativeApproval.history();
  host.history.push(...nativePage.items);
  host.sessionFileReceipts = nativePage.sessionFileReceipts;
  // This fixture has no on-disk task transcript, so provide the tray separately.
  const backgroundTasks = [{
    id: "boundary-bg-call", kind: "subagent", taskId: "boundary-bg-subagent", toolUseId: "boundary-bg-call",
    description: "Run full local distributed CI", state: "running", startedAt: subagentStartAt, updatedAt: subagentStartAt,
    subagent: host.history.find(item => item.subagent?.agentId === "boundary-bg-subagent").subagent,
  }];
  const nativeConfiguration = host.nativeApproval.configuration;
  let taskDetailsReads = 0;
  let useTrayFixture = false;
  host.nativeApproval.configuration = async request => {
    const result = await nativeConfiguration(request);
    if (request.params.includeBackgroundTasks) {
      taskDetailsReads++;
      if (useTrayFixture) result.session.backgroundTasks = structuredClone(backgroundTasks);
      else assert.deepEqual(result.session.backgroundTasks, [], "Missing native transcript produces empty task details");
    }
    return result;
  };
  await catalogRow.locator(".session-row-hit").click();
  await eventually(() => taskDetailsReads >= 2, true, "Native empty task details have been loaded and polled again");
  assert.ok((await page.locator(".session-activity-label").innerText()).includes("子代理运行中 · Run full local distributed CI"), "Native running metadata preserves activity when catalog transcript is unavailable");
  useTrayFixture = true;
  await page.getByRole("button", { name: "后台任务，1 个运行中", exact: true }).waitFor();
  await openMobileDrawer(page);
  await eventually(() => catalogRow.locator(".session-state-dot.running").count(), 1, "Returning from detail keeps catalog row dot running");
  await eventually(() => catalogRow.locator(".session-row-status.running").innerText(), "后台子代理", "Returning from detail keeps catalog row badge synchronized");
  host.session.runningSubagents = { count: 1, lastUpdatedAt: Date.now() - 11 * 60_000 };
  await host.emit("runtime.updated", { replaceSession: true, session: structuredClone(host.session) }, { itemId: "session:subagent-activity" });
  await eventually(() => catalogRow.locator(".session-state-dot.queued").count(), 1, "Stalled background subagent switches catalog dot to warning tone");
  await eventually(() => catalogRow.locator(".session-row-status.queued").innerText(), "子代理无进展", "Stalled background subagent switches catalog badge label");
  // The tray settles without a matching timeline completion event (Issue #140).
  await host.nativeApproval.message({
    type: "system",
    subtype: "task_notification",
    task_id: "boundary-bg-subagent",
    tool_use_id: "boundary-bg-call",
    status: "completed",
    summary: "CI green",
    timestamp: Date.now(),
  });
  assert.equal(host.nativeApproval.session().runningSubagents, undefined);
  backgroundTasks[0] = { ...backgroundTasks[0], state: "completed", updatedAt: Date.now(),
    subagent: { ...backgroundTasks[0].subagent, state: "completed", updatedAt: Date.now() } };
  delete host.session.runningSubagents;
  await host.emit("runtime.updated", { replaceSession: true, session: structuredClone(host.session) }, { itemId: "session:subagent-activity" });
  await eventually(() => catalogRow.locator(".session-state-dot.idle").count(), 1, "Completed background subagent restores idle catalog dot");
  await eventually(() => catalogRow.locator(".session-row-status").count(), 0, "Completed background subagent clears catalog badge");
  steps.push("session catalog state dot and status badge stay synchronized with active, stalled, and completed background subagents before opening and after returning from detail");
  await catalogRow.locator(".session-row-hit").click();
  const stream = page.locator(".conversation-stream");
  const sentFiles = stream.getByRole("region", { name: "会话文件", exact: true });
  await sentFiles.getByRole("button", { name: "说明 notes.md", exact: true }).click({ timeout: 5_000 });
  await page.locator(".media-viewer").getByRole("heading", { name: "Worktree preview", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
  for (const blockedName of ["工作区外的文件.txt", ".env.example"]) {
    assert.equal(await sentFiles.getByRole("button", { name: blockedName, exact: true }).count(), 0);
    assert.ok((await sentFiles.innerText()).includes(`${blockedName}\n请在电脑端打开`));
  }
  assert.equal(await sentFiles.getByText("未发送.bin", { exact: true }).count(), 0);
  assert.equal((await sentFiles.innerText()).includes(outsideFile), false);
  await sentFiles.screenshot({ path: resolve(directory, "native-sent-files.png"), animations: "disabled" });
  const beforeDownload = host.requests.length;
  await sentFiles.getByRole("button", { name: archiveName, exact: true }).click();
  const downloadPrompt = page.getByRole("alertdialog", { name: "确认下载远程文件到手机？", exact: true });
  assert.ok((await downloadPrompt.innerText()).includes(archiveName));
  assert.equal(host.requests.slice(beforeDownload).some(request => request.method === "artifact.transfer.open"), false);
  const downloadEvent = page.waitForEvent("download");
  await downloadPrompt.getByRole("button", { name: "确认下载", exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), archiveName);
  assert.deepEqual(await readFile(await download.path()), archiveBytes);
  steps.push("SendUserFile entries open a worktree text preview and download the original bytes after confirmation");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+l2p0AAAAASUVORK5CYII=", "base64");
  await writeFile(resolve(host.nativeApproval.harnessCwd, "交付图片.png"), image);
  for (const message of [tool("live-send-file", { files: ["交付图片.png"] }, "SendUserFile"), {
    type: "user", uuid: "live-send-file-result", timestamp: Date.now(), message: { content: [{
      type: "tool_result", tool_use_id: "live-send-file", content: "File sent",
    }] }, tool_use_result: { attachments: [{ path: "交付图片.png", size: image.length, isImage: true }] },
  }]) {
    for (const event of await host.nativeApproval.message(message, message.type === "user" ? { type: "tool.completed", itemId: "live-send-file" } : undefined)) {
      await host.emit(event.type, event.data, { itemId: event.itemId });
    }
  }
  await sentFiles.getByRole("button", { name: "交付图片.png", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".media-viewer img")?.naturalWidth === 1);
  await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
  steps.push("A live SendUserFile result opens its PNG in the existing image viewer");
  await stream.locator(".background-task-marker.is-completed").waitFor();
  await eventually(() => page.locator(".session-activity").count(), 0, "Settled task tray clears stale running subagent activity and timer");
  assert.equal(host.history.find(item => item.subagent?.agentId === "boundary-bg-subagent")?.subagent.state, "running", "The timeline intentionally retains its stale running state");
  await page.getByRole("button", { name: "后台任务", exact: true }).click();
  await page.locator(".background-task-row .is-completed").waitFor();
  await page.screenshot({ path: resolve(directory, "subagent-settled-tray.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  host.taskDetailsError = "Task detail refresh unavailable";
  await page.getByRole("alert").filter({ hasText: host.taskDetailsError }).waitFor();
  assert.equal(await page.locator(".session-activity").count(), 0, "A failed refresh cannot revive a task already confirmed completed by the tray");
  host.taskDetailsError = undefined;
  await page.getByRole("alert").filter({ hasText: "Task detail refresh unavailable" }).waitFor({ state: "hidden" });
  steps.push("completed tray clears composer activity despite a missing timeline completion event and preserves completion through a rejected refresh");
  await eventually(() => stream.locator(".task-plan-card").count(), 1, "Only the parent native task plan is projected");
  assert.equal((await stream.innerText()).includes("INTERNAL_COMPACT_SUMMARY_MUST_STAY_HIDDEN"), false);
  assert.equal((await stream.innerText()).includes("子代理内部计划"), false);
  for (const label of ["相对报告", "绝对报告"]) {
    const requestStart = host.requests.length;
    await stream.getByRole("button", { name: label, exact: true }).click();
    const content = page.locator("#text-preview-content");
    await content.waitFor();
    const opens = host.requests.slice(requestStart).filter(request => request.method === "artifact.transfer.open");
    assert.equal(opens[0]?.params.purpose, "stat", "File links check metadata before opening the text transfer");
    assert.ok(opens.length >= 2 && opens.slice(1).every(request => request.params.purpose === "text-preview"), "Content transfers follow the file size check");
    assert.ok((await content.innerText()).includes("worktree"), "The original project-root namesake must not be read");
    assert.equal((await content.innerText()).includes("wrong project root"), false);
    assert.equal(await page.locator(".media-viewer [role=alert]").count(), 0);
    if (label === "相对报告") {
      await page.evaluate(() => {
        window.__previewCopies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
          writeText: async text => { window.__previewCopies.push(text); },
        } });
      });
      await page.getByRole("button", { name: "复制文件内容", exact: true }).click();
      await page.locator(".media-viewer-toolbar").getByRole("button", { name: "已复制", exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__previewCopies), [await readFile(resolve(host.nativeApproval.harnessCwd, "report.json"), "utf8")]);
    }
    if (label === "相对报告") await page.screenshot({ path: resolve(directory, "native-worktree-report.png"), fullPage: true });
    await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
  }
  const requestStart = host.requests.length;
  await stream.getByRole("button", { name: "子目录报告", exact: true }).click();
  await page.locator("#text-preview-content").getByText("Report from the shell subdirectory").waitFor();
  const shellOpens = host.requests.slice(requestStart).filter(request => request.method === "artifact.transfer.open");
  assert.equal(shellOpens[0]?.params.purpose, "stat");
  assert.ok(shellOpens.length >= 2 && shellOpens.slice(1).every(request => request.params.purpose === "text-preview"));
  assert.ok(shellOpens.every(request => request.params.resolveRelativeLink === true));
  await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
  await stream.getByRole("button", { name: "说明预览", exact: true }).click();
  await page.locator(".media-viewer").getByRole("heading", { name: "Worktree preview", exact: true }).waitFor();
  await page.getByRole("button", { name: "复制文件内容", exact: true }).click();
  await page.locator(".media-viewer-toolbar").getByRole("button", { name: "已复制", exact: true }).waitFor();
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  assert.ok((await page.locator("#text-preview-content").innerText()).includes("# Worktree preview"));
  await page.locator(".media-viewer-toolbar").getByRole("button", { name: "已复制", exact: true }).click();
  assert.deepEqual((await page.evaluate(() => window.__previewCopies)).slice(-2), Array(2).fill(await readFile(resolve(host.nativeApproval.harnessCwd, "说明 notes.md"), "utf8")));
  await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
  steps.push("real Native facade + Controller resolve relative/absolute report links and Chinese spaced Markdown paths in the worktree");
  await stream.getByRole("button", { name: "空文件预览", exact: true }).click();
  await page.locator(".media-viewer footer").filter({ hasText: "空文件 · UTF-8" }).waitFor();
  await page.getByRole("button", { name: "复制文件内容", exact: true }).click();
  await page.locator(".media-viewer-toolbar").getByRole("button", { name: "已复制", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__previewCopies.at(-1)), "", "Empty text files can clear the clipboard");
  await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
  await stream.getByRole("button", { name: "长文预览", exact: true }).click();
  const markdownViewer = page.locator(".media-viewer");
  await markdownViewer.getByRole("heading", { name: "手机文件预览", exact: true }).waitFor();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    window.__fallbackCopies = [];
    document.addEventListener("copy", () => {
      const input = document.activeElement;
      window.__fallbackCopies.push(input instanceof HTMLTextAreaElement ? input.value.slice(input.selectionStart, input.selectionEnd) : "");
    });
  });
  await markdownViewer.getByRole("button", { name: "复制文件内容", exact: true }).click();
  await eventually(() => page.evaluate(() => window.__fallbackCopies), [await readFile(resolve(host.nativeApproval.harnessCwd, markdownName), "utf8")], "WebView fallback selects the complete file inside the modal dialog");
  await markdownViewer.getByRole("button", { name: "已复制", exact: true }).waitFor();
  for (const width of [375, 320, 1200]) {
    await page.setViewportSize({ width, height: 812 });
    const layout = await markdownViewer.evaluate(dialog => {
      const bounds = element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
      };
      return {
        dialog: bounds(dialog),
        regions: [".media-viewer-shell > header", ".media-viewer-toolbar", ".media-viewer-viewport", ".media-viewer-shell > footer", "#media-viewer-title", '[aria-label="关闭查看器"]', ".media-viewer-toolbar .message-copy-button"].map(selector => ({ selector, ...bounds(dialog.querySelector(selector)) })),
        paragraphs: [...dialog.querySelectorAll(".markdown-paragraph")].map(bounds),
        scrollLeft: dialog.scrollLeft,
      };
    });
    await writeFile(resolve(directory, `markdown-layout-${width}.json`), JSON.stringify(layout, null, 2));
    assert.ok(layout.dialog.left >= 0 && layout.dialog.right <= width, "File preview dialog stays within the screen");
    assert.ok(layout.dialog.scrollWidth <= layout.dialog.clientWidth + 1, `Long filename must not widen the dialog grid at ${width}px: ${JSON.stringify(layout)}`);
    assert.equal(layout.scrollLeft, 0, "Dialog focus must not scroll the filename and paragraph starts offscreen");
    for (const region of [...layout.regions, ...layout.paragraphs]) {
      assert.ok(region.left >= layout.dialog.left && region.right <= layout.dialog.right, `Header controls and rendered prose stay inside the dialog at ${width}px: ${JSON.stringify(region)}`);
    }
    assert.ok(layout.paragraphs.length >= 4 && layout.paragraphs.every(paragraph => paragraph.scrollWidth <= paragraph.clientWidth + 1), "Chinese prose wraps without clipping or horizontal overflow");
    for (const selector of [".markdown-code-pre", ".markdown-table-wrap"]) {
      const scrolled = await markdownViewer.locator(selector).evaluate(element => {
        element.scrollLeft = element.scrollWidth;
        return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft };
      });
      if (width <= 375 || selector === ".markdown-code-pre") {
        assert.ok(scrolled.scrollWidth > scrolled.clientWidth && scrolled.scrollLeft > 0, `Wide Markdown content can scroll horizontally at ${width}px: ${selector}`);
      }
    }
    await page.getByRole("tab", { name: "源码", exact: true }).click();
    const sourceScroll = await markdownViewer.locator(".media-viewer-viewport").evaluate(viewport => {
      viewport.scrollLeft = viewport.scrollWidth;
      return viewport.scrollLeft;
    });
    assert.ok(sourceScroll > 0, "Raw Markdown source keeps horizontal scrolling");
    await page.getByRole("tab", { name: "预览", exact: true }).click();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: resolve(directory, "native-markdown-mobile.png"), fullPage: true });
  assert.ok(await markdownViewer.locator(".media-viewer-viewport").evaluate(viewport => {
    viewport.scrollTop = viewport.scrollHeight;
    return viewport.scrollTop > 0;
  }), "Long Markdown scrolls vertically within the preview viewport");
  await page.screenshot({ path: resolve(directory, "native-markdown-wide-content.png"), fullPage: true });
  await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
  steps.push("long Markdown filenames preserve the visible header and wrapped Chinese prose at 320/375/1200px; wide code, tables and source scroll horizontally while long documents scroll vertically");
  for (const event of await host.nativeApproval.message(tool("boundary-advance", { advance: true }))) await host.emit(event.type, event.data, { itemId: event.itemId });
  await eventually(() => stream.locator(".task-plan-progress").first().innerText(), "1/2 已完成", "Native empty-text live plan updates the history card");
  assert.equal(await stream.locator(".task-plan-card").count(), 1);
  for (const event of await host.nativeApproval.message(tool("boundary-new", { scope: "new_task", items: planItems }))) await host.emit(event.type, event.data, { itemId: event.itemId });
  await eventually(() => stream.locator(".task-plan-card").count(), 2, "A genuine new task remains distinct even with identical text");
  await page.screenshot({ path: resolve(directory, "native-plan-boundaries.png"), fullPage: true });
  assert.equal(host.requests.filter(request => request.method === "turn.start" || request.method === "turn.steer").length, 0);
  steps.push("compact summaries/sidechain plans stay hidden, live parent status updates one card, and genuine new tasks remain distinct");

  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  const configuration = page.getByRole("dialog", { name: originalTitle, exact: true });
  await selectCustomOption(page, configuration.getByRole("combobox", { name: "模型", exact: true }), "claude/claude-opus-5-5");
  await eventually(() => configuration.locator(".magpie-quota-model summary").innerText(), "单账号最高可用 73%", "Native Claude model picker shows the Magpie response");
  await configuration.locator(".magpie-quota-model summary").click();
  assert.ok((await configuration.innerText()).includes("隔离 Magpie 账号"));
  assert.ok(host.requests.some(request => request.method === "plugin.magpie-quota.list"));
  await page.screenshot({ path: resolve(directory, "native-magpie-quota.png"), fullPage: true });
  await configuration.getByRole("button", { name: "保存配置", exact: true }).click();
  await configuration.waitFor({ state: "hidden" });
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setModel").at(-1).args, [sessionId, "mythos-magpie-2213244526"]);
  steps.push("the native picker queries Magpie account quota, shows the returned 73% with account details, and sends the exact native model alias");

  const checkpointTime = Date.now();
  for (const [index, message] of [
    { type: "user", uuid: "rewind-first", message: { content: "准备一个检查点" } },
    { type: "assistant", uuid: "rewind-kept", message: { content: [{ type: "text", text: "保留的检查点回复" }] } },
    { type: "user", uuid: "rewind-target", message: { content: "重写这条请求" } },
    { type: "assistant", uuid: "rewind-discarded", message: { content: [{ type: "text", text: "回退后应消失的回复" }] } },
  ].entries()) {
    for (const event of await host.nativeApproval.message({ ...message, timestamp: checkpointTime + index })) await host.emit(event.type, event.data, { itemId: event.itemId });
  }
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  const target = stream.locator("article.conversation-item").filter({ hasText: "重写这条请求" });
  await target.locator(".conversation-bubble").click();
  await target.getByRole("button", { name: "回退到这条消息之前", exact: true }).click();
  const rewind = page.getByRole("dialog", { name: "回退会话", exact: true });
  await selectCustomOption(page, rewind.getByRole("combobox", { name: "回退范围", exact: true }), "both");
  assert.ok((await rewind.innerText()).includes("report.json"));
  assert.equal(JSON.parse(await readFile(resolve(host.nativeApproval.harnessCwd, "report.json"), "utf8")).source, "worktree", "Dry-run leaves the actual fixture file intact");
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "rewindV2").length, 0);
  await page.screenshot({ path: resolve(directory, "native-rewind-preview.png"), fullPage: true });
  await rewind.getByRole("button", { name: "确认回退", exact: true }).click();
  await rewind.waitFor({ state: "hidden" });
  await eventually(() => page.locator(".composer-form textarea").inputValue(), "重写这条请求", "Native rewind returns the original text to the draft");
  await eventually(() => stream.getByText("回退后应消失的回复", { exact: true }).count(), 0, "Discarded reply is removed from history and old live events");
  assert.equal(JSON.parse(await readFile(resolve(host.nativeApproval.harnessCwd, "report.json"), "utf8")).source, "rewound");
  const changes = host.nativeApproval.calls.filter(call => call.method === "rewindV2" || (call.method === "rewindFiles" && call.args[2] === false));
  assert.deepEqual(changes.map(call => [call.method, call.args]), [
    ["rewindFiles", [sessionId, "rewind-target", false, true]], ["rewindV2", [sessionId, "rewind-target"]],
  ]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await page.getByText("保留的检查点回复", { exact: true }).waitFor();
  assert.equal(await stream.getByText("回退后应消失的回复", { exact: true }).count(), 0);
  assert.equal(await stream.getByText("重写这条请求", { exact: true }).count(), 0);
  assert.equal(await page.locator(".composer-form textarea").inputValue(), "重写这条请求");
  await page.screenshot({ path: resolve(directory, "native-rewind-reconnected.png"), fullPage: true });
  steps.push("confirmed rewind restores files before the conversation, prefill returns to the draft, and discarded messages stay absent after reconnect/replay");

  for (const name of ["Read", "Bash", "Edit", "Write"]) {
    const id = `completion-only-${name}`;
    await host.nativeApproval.message(tool(id, name === "Bash" ? { command: "pwd" } : { file_path: `/fixture/${name}.ts` }, name));
    for (const event of await host.nativeApproval.message({ type: "user", uuid: `${id}-result`, message: { content: [{ type: "tool_result", tool_use_id: id, content: "Completed" }] } })) {
      await host.emit(event.type, event.data, { itemId: event.itemId });
    }
  }
  const toolRows = stream.locator(".conversation-tool-row");
  await eventually(async () => (await toolRows.locator("strong").allTextContents()).sort(), ["Bash", "Edit", "Read", "Write"], "Completion-only browser events retain native tool names after earlier start events are unavailable");
  await stream.locator(".conversation-tool-group").last().locator("summary").click();
  assert.equal(await toolRows.filter({ hasText: "/fixture/Read.ts" }).locator("strong").innerText(), "Read");
  await page.screenshot({ path: resolve(directory, "native-tool-names-completion-only.png"), fullPage: true });
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await eventually(async () => (await toolRows.locator("strong").allTextContents()).sort(), ["Bash", "Edit", "Read", "Write"], "Native history and replay keep one named row per original call after reload");
  assert.equal(host.requests.filter(request => request.method === "session.tool.detail").length, 0, "Timeline rendering never eagerly fetches full tool outputs");
  await stream.locator(".conversation-tool-group").last().locator("summary").click();
  await toolRows.filter({ hasText: "pwd" }).click();
  const toolDetailDialog = page.getByRole("dialog", { name: "Bash", exact: true });
  await toolDetailDialog.waitFor();
  await eventually(async () => {
    const text = await toolDetailDialog.innerText();
    return text.includes("已完成") && text.includes("pwd") && text.includes("Completed");
  }, true, "Clicking a tool row lazily fetches full input and execution output");
  assert.deepEqual(
    host.requests.filter(request => request.method === "session.tool.detail").map(request => ({
      sessionId: request.params.sessionId,
      toolUseId: request.params.toolUseId,
    })),
    [{ sessionId, toolUseId: "completion-only-Bash" }],
  );
  await page.screenshot({ path: resolve(directory, "native-tool-detail-sheet.png"), fullPage: true });
  await toolDetailDialog.getByRole("button", { name: "关闭工具详情", exact: true }).click();
  await toolDetailDialog.waitFor({ state: "hidden" });
  await toolRows.filter({ hasText: "pwd" }).click();
  await toolDetailDialog.waitFor();
  assert.equal(host.requests.filter(request => request.method === "session.tool.detail").length, 1, "Completed tool detail reuses the in-memory session cache");
  await toolDetailDialog.getByRole("button", { name: "关闭工具详情", exact: true }).click();
  await toolDetailDialog.waitFor({ state: "hidden" });
  steps.push("Read/Bash/Edit/Write keep names and input summaries when only completion events reach the phone, reload merges native history without anonymous or duplicate rows, and clicking a tool row lazily loads and caches full tool input/output via session.tool.detail");

  for (const method of ["getSession", "getTranscriptPage"]) {
    const text = `回退成功后 ${method} 断连`;
    for (const message of [
      { type: "assistant", uuid: `readback-${method}-anchor`, message: { content: [{ type: "text", text: `${method} 保留的检查点` }] } },
      { type: "user", uuid: `readback-${method}-target`, message: { content: text } },
      { type: "assistant", uuid: `readback-${method}-discarded`, message: { content: [{ type: "text", text: `${method} 应移除的回复` }] } },
    ]) for (const event of await host.nativeApproval.message({ ...message, timestamp: Date.now() })) await host.emit(event.type, event.data, { itemId: event.itemId, turnId: event.turnId });
    host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
    const target = page.locator("article.conversation-item.user").filter({ hasText: text });
    await target.locator(".conversation-bubble").click();
    await target.getByRole("button", { name: "回退到这条消息之前", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "回退会话", exact: true });
    await eventually(() => dialog.getByRole("button", { name: "确认回退", exact: true }).isEnabled(), true, "Native preview must finish before injecting the post-success readback disconnect");
    host.nativeApproval.failRewindReadback(method);
    const before = host.nativeApproval.calls.filter(call => call.method === "rewindV2").length;
    await dialog.getByRole("button", { name: "确认回退", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await eventually(() => page.locator(".composer-form textarea").inputValue(), text, "A post-success Native readback disconnect must retain the original prefill");
    assert.equal(await target.count(), 0);
    assert.equal(host.nativeApproval.calls.filter(call => call.method === "rewindV2").length, before + 1);
    assert.equal(host.nativeApproval.failedRewindReadbacks.filter(failed => failed === method).length, 1, "The intended post-success Native readback actually failed");
    await page.screenshot({ path: resolve(directory, `native-rewind-${method}-disconnected.png`), fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openMobileSession(page);
    await page.getByText(`${method} 保留的检查点`, { exact: true }).waitFor();
    assert.equal(await target.count(), 0, "Refreshed history and replay must not revive the successfully rewound target");
  }
  steps.push("successful Native rewind preserves prefill and closes confirmation when subsequent getSession or getTranscriptPage disconnects; each mutation executes once and discarded history stays absent after reload");

  const proposalTool = "mcp__ccd_session__start_session";
  const proposalTitle = "#457 fork 日历告警";
  const proposalBackground = "检查旧版日历告警在手机上为什么没有显示。先用隔离夹具重放旧版日程和告警，再核对当前版本的快照。只检查显示链路，不修改真实日程或调整通知设置。完成后记录复现步骤、触发条件和验证结果。";
  const proposalCall = tool("calendar-proposal", {
    title: proposalTitle, background: proposalBackground, context: "fresh", prompt: "先复现旧版日历告警，再核对手机上的显示。", initiation: "own_initiative",
  }, proposalTool);
  const proposalTools = stream.locator(".conversation-tool-group").filter({ has: page.locator(".conversation-tool-row").filter({ hasText: proposalTool }) });
  for (const message of [tool("calendar-a-read", { file_path: "/fixture/calendar.ts" }, "Read"), proposalCall]) {
    for (const event of await host.nativeApproval.message(message)) await host.emit(event.type, event.data, { itemId: event.itemId });
  }
  await proposalTools.locator("summary").click();
  for (const event of await host.nativeApproval.message(tool("calendar-z-grep", { pattern: "fixture-calendar" }, "Grep"))) {
    await host.emit(event.type, event.data, { itemId: event.itemId });
  }
  await proposalTools.locator("summary").getByText(/3 个工具/).waitFor();
  assert.equal(await proposalTools.getAttribute("open"), "", "Appending a tool preserves the expanded group");
  for (let index = 0; index < 10; index++) {
    for (const event of await host.nativeApproval.message({ type: "assistant", uuid: `proposal-scroll-${index}`, timestamp: Date.now(), message: {
      content: [{ type: "text", text: `已经阅读的日历记录 ${index}：保留标题、日期和旧版告警触发条件以便复核。\n\n同时对照手机里显示的日期与时间，确认告警与对应日程出现在同一天。` }],
    } })) await host.emit(event.type, event.data, { itemId: event.itemId });
  }
  const readingRow = stream.locator('[data-stream-key="proposal-scroll-1"]');
  await stream.locator('[data-stream-key="proposal-scroll-9"]').waitFor();
  const { readingOffset, remainingScroll } = await readingRow.evaluate(async (row) => {
    await Promise.all(row.getAnimations().map(animation => animation.finished));
    const container = row.parentElement;
    container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - 10;
    container.dispatchEvent(new Event("scroll"));
    return { readingOffset: Math.round(row.getBoundingClientRect().top - container.getBoundingClientRect().top),
      remainingScroll: container.scrollHeight - container.scrollTop - container.clientHeight };
  });
  assert.ok(remainingScroll > 4, "The reader is not following the bottom before the proposal result");
  await eventually(() => toolRows.filter({ hasText: proposalTool }).count(), 1, "In-flight proposal calls are still ordinary tools");
  for (const event of await host.nativeApproval.message({
    type: "user", uuid: "calendar-proposal-result", message: { content: [{ type: "tool_result", tool_use_id: "calendar-proposal", content: [{
      type: "text", text: `Proposed "${proposalTitle}" (task_id: task_d6c18845). The user sees a card and nothing runs until they start it — with a click, or by telling you (then call start_session with proposal_id task_d6c18845 and nothing else).`,
    }] }] },
  })) await host.emit(event.type, event.data, { itemId: event.itemId });
  const proposal = stream.getByRole("region", { name: "会话提案", exact: true });
  await proposal.getByText(proposalTitle, { exact: true }).waitFor({ timeout: 5_000 });
  await proposal.getByText(proposalBackground, { exact: true }).waitFor();
  assert.equal(await readingRow.evaluate(row => Math.round(row.getBoundingClientRect().top - row.parentElement.getBoundingClientRect().top)), readingOffset, "The reader stays at the same offset when a tool above becomes a proposal card");
  const beforeProposal = stream.locator('[data-stream-key="tool-group:tool:calendar-a-read"]');
  const afterProposal = stream.locator('[data-stream-key="tool-group:tool:calendar-z-grep"]');
  assert.equal(await beforeProposal.getAttribute("open"), "", "The original left group stays open after the split");
  assert.equal(await afterProposal.getAttribute("open"), null, "The new right group is independent");
  assert.equal(await toolRows.filter({ hasText: proposalTool }).count(), 0, "A proposal card replaces rather than duplicates its tool row");
  assert.equal(await proposal.getByRole("button", { name: /^(启动|撤回)/ }).count(), 0);
  const background = proposal.locator(".session-proposal-background > summary");
  const visibleLines = () => background.locator("span").evaluate(span => Math.round(span.clientHeight / parseFloat(getComputedStyle(span).lineHeight)));
  assert.equal(await visibleLines(), 3, "Long proposal backgrounds start as a three-line preview");
  await proposal.screenshot({ path: resolve(directory, "native-session-proposal.png"), animations: "disabled" });
  await background.click();
  assert.ok(await visibleLines() > 3, "Tapping the background reveals the full text");
  await proposal.screenshot({ path: resolve(directory, "native-session-proposal-expanded.png"), animations: "disabled" });
  await background.press("Enter");
  assert.equal(await visibleLines(), 3, "Keyboard activation collapses the background again");
  const proposalPage = await host.nativeApproval.history();
  host.history.splice(0, host.history.length, ...proposalPage.items);
  const mockHistoryPage = host.historyPage;
  host.historyPage = (cursor, limit) => ({ ...mockHistoryPage(cursor, limit), ...(!cursor ? { sessionProposalResults: proposalPage.sessionProposalResults } : {}) });
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await proposal.getByText(proposalTitle, { exact: true }).waitFor();
  assert.equal(await proposal.count(), 1, "Native history and live replay retain a single proposal card");
  await proposal.getByRole("button", { name: "查看工具详情", exact: true }).click();
  const proposalDetail = page.getByRole("dialog", { name: proposalTool, exact: true });
  await proposalDetail.getByText(/task_d6c18845/).waitFor();
  await proposalDetail.getByRole("button", { name: "关闭工具详情", exact: true }).click();
  await proposalDetail.waitFor({ state: "hidden" });
  host.historyPage = mockHistoryPage;
  steps.push("A successful session proposal splits the original tool group without duplicate keys or moving the reader, survives history reload, and retains the original tool detail on demand");

  await openMobileDrawer(page);
  await page.locator(".mobile-drawer-dock-nav").getByRole("button", { name: "设置", exact: true }).click();
  const settingsUpdaterRegion = page.locator(".mobile-settings-content").getByRole("region", { name: "版本与更新", exact: true });
  await settingsUpdaterRegion.getByRole("button", { name: "查看 GitHub Releases", exact: true }).waitFor();
  const openComputerSettings = () => page.locator(".mobile-settings-content").getByRole("button", { name: "连接与电脑设置" }).click();
  const returnToSettings = () => page.locator(".m-header:visible").getByRole("button", { name: "返回设置", exact: true }).click();
  await openComputerSettings();
  const remoteUpdaterRegion = page.locator(".mobile-host-details").getByRole("region", { name: "版本与更新", exact: true });
  await remoteUpdaterRegion.getByText("v1.1.1", { exact: true }).waitFor();
  assert.deepEqual(
    await remoteUpdaterRegion.locator(".mobile-settings-actions button").allInnerTexts(),
    ["检查更新"],
    "Computer updates expose only 检查更新 without remote upgrade/download buttons",
  );
  await remoteUpdaterRegion.getByRole("button", { name: "检查更新", exact: true }).click();
  await eventually(() => host.requests.some(request => request.method === "system.update" && request.params.action === "check"), true, "Mobile triggers encrypted system.update check RPC");
  await eventually(() => remoteUpdaterRegion.innerText().then(t => t.includes("发现 v1.3.5")), true, "Computer updates reflect the available version over E2EE");
  async function assertUpdaterCard(region, title) {
    const rows = await region.locator(":scope > :not(h2)").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, background: style.backgroundColor,
        topRadius: [style.borderTopLeftRadius, style.borderTopRightRadius], bottomRadius: [style.borderBottomLeftRadius, style.borderBottomRightRadius],
        topBorder: style.borderTopWidth, bottomBorder: style.borderBottomWidth, sideBorderWidths: [style.borderLeftWidth, style.borderRightWidth] };
    }));
    if (title === "Web") {
      assert.equal(rows.length, 3, "Web updates show the version, channel, and Releases action");
    } else {
      assert.ok(rows.length >= 4, "Computer updates show version, details, and actions");
    }
    for (const [index, row] of rows.entries()) {
      assert.equal(row.left, rows[0].left, `${title} rows share the left hairline edge`);
      assert.equal(row.right, rows[0].right, `${title} rows share the right hairline edge`);
      assert.equal(row.background, rows[0].background, `${title} rows stay flat without boxed cards`);
      assert.deepEqual(row.sideBorderWidths, ["0px", "0px"], `${title} rows have no vertical card borders`);
      assert.deepEqual(row.topRadius, ["0px", "0px"], `${title} rows are cardless`);
      assert.deepEqual(row.bottomRadius, ["0px", "0px"], `${title} rows are cardless`);
      assert.equal(row.topBorder, "0px", `${title} rows use bottom hairlines only`);
      assert.equal(row.bottomBorder, "1px", `${title} rows render 1px hairline dividers`);
      if (index > 0) {
        assert.ok(Math.abs(row.top - rows[index - 1].bottom) <= 1, `${title} has no gaps between rows`);
      }
    }
  }
  await assertUpdaterCard(remoteUpdaterRegion, "Computer");
  await page.screenshot({ path: resolve(directory, "settings-updater-cards.png"), fullPage: true });
  host.snapshot.updater = { ...host.snapshot.updater, phase: "idle" };
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await eventually(() => remoteUpdaterRegion.getByRole("button", { name: "检查更新", exact: true }).isEnabled(), true, "Remote updater is idle before the rejection check");
  host.systemUpdateError = "隔离更新请求失败";
  for (const family of ["Sunstone", "Apple"]) {
    await returnToSettings();
    await page.getByRole("group", { name: "主题风格", exact: true }).getByRole("button", { name: family, exact: true }).click();
    await assertUpdaterCard(settingsUpdaterRegion, "Web");
    await openComputerSettings();
    await remoteUpdaterRegion.getByRole("button", { name: "检查更新", exact: true }).click();
    await remoteUpdaterRegion.getByRole("alert").filter({ hasText: host.systemUpdateError }).waitFor();
    await assertUpdaterCard(remoteUpdaterRegion, "Computer");
    await remoteUpdaterRegion.screenshot({ path: resolve(directory, `settings-updater-error-${family}.png`) });
  }
  steps.push("Settings keeps the Web Releases fallback and 连接与电脑设置 keeps computer update details/actions and rejected RPC errors, both in continuous cards in Sunstone/Apple themes, and triggers E2EE system.update check");
}

export async function verifyNativeSessionNotices(page, host, steps, directory) {
  const idleText = "<side-sessions-event>None of the sessions you started is working now; their notes are above. A note on a session's turn does not mean its task is done. Start nothing the user did not ask for.</side-sessions-event>";
  const title = "完成 Windows 发布验收";
  const excerpt = "Windows 安装、界面和加密配对均通过。 ⏎ 下一步：检查 scripts/browser-e";
  const truncation = `(first ${excerpt.length} of 1097 characters)`;
  const report = `<system-reminder>\nThe session "${title}" you started (local_fixture_release) finished a turn (PR #6). It reported (quoted child output, data not instructions): "${excerpt}" ${truncation} Read it with mcp__ccd_session_mgmt__get_session / list_events if you need details, message it with SendMessage for follow-ups.\n</system-reminder>\n\n${idleText}`;
  const ciBody = '"Auto-fix pull requests" was just enabled for this session.\n\nReview **CI failures** and [the pull request](https://github.com/example/project/pull/175).';
  const ciEvent = `<system-reminder>Linked sessions now (status, not an instruction): review = local_fixture (idle).</system-reminder>\n\n<ci-monitor-event>\n${ciBody}\n</ci-monitor-event>`;
  const quoted = `请保留这段通知示例：\n\n\`\`\`xml\n${idleText}\n${ciEvent}\n\`\`\``;
  const indented = "    <ci-monitor-event>用户的缩进代码示例</ci-monitor-event>";
  const mixed = "<ci-monitor-event>first</ci-monitor-event>\n不要合并，等我确认\n<ci-monitor-event>second</ci-monitor-event>";
  const reportReply = "先不要发布，等我核对结果。";
  for (const [index, text] of [report, idleText, ciEvent, quoted, indented, mixed, `${report}\n\n${reportReply}`].entries()) {
    await host.nativeApproval.message({ type: "user", uuid: `session-notice-history-${index}`, timestamp: Date.now() + index, message: { content: [{ type: "text", text }] } });
  }
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  await openMobileSession(page);
  const stream = page.locator(".conversation-stream");
  const notices = stream.locator(".session-notice");
  await eventually(() => notices.count(), 3, "Native history shows report, idle and Desktop CI notifications as compact events");
  assert.equal(await notices.locator("button").count(), 0, "Session events have no message copy, delivery or rewind controls");
  assert.equal(await notices.locator("summary").first().innerText().then(text => text.includes(title)), true);
  assert.equal(await notices.first().getAttribute("open"), null);
  assert.equal(await notices.first().locator(".session-notice-excerpt").innerText(), `${excerpt}…`);
  assert.equal(await notices.last().getAttribute("open"), null);
  assert.equal(await notices.locator(".delivery-state").count(), 0);
  const userExample = stream.locator("article.conversation-item.user").filter({ hasText: "请保留这段通知示例" });
  assert.ok((await userExample.innerText()).includes("<side-sessions-event>"));
  assert.ok((await userExample.innerText()).includes("<ci-monitor-event>"));
  const ciNotice = notices.filter({ hasText: "Claude Desktop · CI 监控" });
  assert.equal(await ciNotice.count(), 1);
  assert.equal(await ciNotice.getAttribute("open"), null);
  assert.equal(await ciNotice.locator("section").isVisible(), false);
  assert.equal((await ciNotice.innerText()).includes("<ci-monitor-event>"), false);
  await ciNotice.locator("summary").click();
  assert.ok((await ciNotice.innerText()).includes("Review CI failures"));
  assert.equal(await ciNotice.getByRole("link", { name: "the pull request" }).getAttribute("href"), "https://github.com/example/project/pull/175");
  await ciNotice.locator("summary").click();
  assert.equal(await ciNotice.locator("section").isVisible(), false);
  const rewindAction = { name: "回退到这条消息之前", exact: true, includeHidden: true };
  assert.equal(await userExample.getByRole("button", rewindAction).count(), 1);
  const userCode = stream.locator("article.conversation-item.user").filter({ hasText: "用户的缩进代码示例" });
  assert.equal(await userCode.count(), 1, "Native projection preserves indented examples as user messages");
  assert.ok((await userCode.locator(".markdown-body").textContent()).startsWith("    <ci-monitor-event>"), "The original four-space indentation survives the Native-to-client path");
  assert.equal(await userCode.getByRole("button", rewindAction).count(), 1);
  const userReply = stream.locator("article.conversation-item.user").filter({ hasText: "不要合并，等我确认" });
  assert.equal(await userReply.count(), 1, "User prose between CI envelopes is never swallowed into an app notice");
  assert.equal(await userReply.getByRole("button", rewindAction).count(), 1);
  const userReportReply = stream.locator("article.conversation-item.user").filter({ hasText: reportReply });
  assert.equal(await userReportReply.count(), 1, "User prose after a truncated child report stays in the conversation");
  assert.equal(await userReportReply.getByText(reportReply, { exact: true }).isVisible(), true);
  assert.equal(await userReportReply.getByRole("button", rewindAction).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(directory, "session-notices-collapsed.png"), fullPage: true });
  await notices.first().locator("summary").first().click();
  assert.equal(await notices.first().locator("section .markdown-body").innerText(), excerpt);
  assert.equal(await notices.first().getByText(`已截断 · 前 ${excerpt.length} / 1097 字`, { exact: true }).isVisible(), true);
  await notices.first().getByText("原始通知", { exact: true }).click();
  assert.ok((await notices.first().locator("pre").innerText()).includes(truncation));
  await notices.first().getByText("原始通知", { exact: true }).click();
  await page.screenshot({ path: resolve(directory, "session-notices-expanded.png"), fullPage: true });
  for (const event of await host.nativeApproval.message({ type: "user", uuid: "session-notice-live", timestamp: Date.now(), message: { content: [{ type: "text", text: report.replace(title, "完成 Android 发布验收") }] } })) {
    await host.emit(event.type, event.data, { itemId: event.itemId, turnId: event.turnId });
  }
  await eventually(() => notices.count(), 4, "Live Native reports use the same compact presentation as history");
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await eventually(() => notices.count(), 4, "Reload merges Native history and live notices without duplicate cards");
  assert.equal(await ciNotice.count(), 1);
  assert.equal(await ciNotice.getAttribute("open"), null);
  assert.equal(host.requests.filter(request => ["turn.start", "turn.steer", "session.rewind", "permission.resolve"].includes(request.method)).length, 0);
  steps.push("Native report and idle notices stay compact in history, live updates and replay; original text remains readable, quoted examples keep user controls, and no Native mutation is sent");

  await openMobileDrawer(page);
  const { untrustedDir, manualTrustDir } = host.nativeApproval;
  const newChatCanvas = page.locator(".new-chat-canvas");
  const folderDialog = page.locator(".session-create-dialog");
  const chooseFolderByPath = async (targetDir) => {
    await newChatCanvas.getByRole("button", { name: "选择文件夹", exact: true }).click();
    await folderDialog.waitFor();
    const browseBtn = folderDialog.getByRole("button", { name: "浏览电脑文件夹", exact: true });
    if (await browseBtn.isVisible()) {
      await browseBtn.click();
    }
    await folderDialog.getByRole("button", { name: "输入路径", exact: true }).click();
    await folderDialog.getByLabel("当前路径", { exact: true }).fill(targetDir);
    await folderDialog.getByLabel("当前路径", { exact: true }).press("Enter");
    await folderDialog.getByRole("button", { name: "使用此文件夹", exact: true }).click();
    await folderDialog.waitFor({ state: "hidden" });
  };

  await page.locator('.mobile-home-catalog button[aria-label^="新建会话："]').first().click();
  await newChatCanvas.waitFor();
  await chooseFolderByPath(untrustedDir);
  await newChatCanvas.getByRole("button", { name: "创建空会话", exact: true }).click();

  const trustAlert = newChatCanvas.getByRole("alert");
  await eventually(() => trustAlert.innerText(), `该文件夹首次使用，是否信任并允许 Claude 访问「${untrustedDir}」？`, "Untrusted folder prompts for explicit confirmation without exposing EIPC text");
  assert.equal((await newChatCanvas.innerText()).includes("$eipc_message$"), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(directory, "workspace-trust-confirm.png"), fullPage: true });

  await newChatCanvas.getByRole("button", { name: "信任并创建", exact: true }).click();
  await newChatCanvas.waitFor({ state: "hidden" });
  await page.locator(".conversation-workspace").getByRole("heading", { name: "新建会话", exact: true }).waitFor();
  const firstCreatedId = host.snapshot.sessions.find((candidate) => candidate.cwd === untrustedDir)?.sessionId;
  assert.ok(firstCreatedId, "Trusted session created");
  assert.deepEqual(
    host.nativeApproval.calls.filter(call => call.method === "saveTrust").map(call => call.args),
    [[untrustedDir]],
  );

  await openMobileDrawer(page);
  host.nativeApproval.setTrustPolicy({ keepUntrustedAfterSave: true });
  await page.locator('.mobile-home-catalog button[aria-label^="新建会话："]').first().click();
  await newChatCanvas.waitFor();
  await chooseFolderByPath(manualTrustDir);
  await newChatCanvas.getByRole("button", { name: "创建空会话", exact: true }).click();
  await newChatCanvas.getByRole("button", { name: "信任并创建", exact: true }).click();
  await eventually(() => trustAlert.innerText(), `请在电脑端 Claude 窗口打开并信任「${manualTrustDir}」后重试。`, "Manual fallback guides desktop GUI approval when saveTrust cannot satisfy trust");
  await page.screenshot({ path: resolve(directory, "workspace-trust-manual.png"), fullPage: true });

  host.nativeApproval.trustWorkspace(manualTrustDir);
  await newChatCanvas.getByRole("button", { name: "重试创建", exact: true }).click();
  await newChatCanvas.waitFor({ state: "hidden" });
  await page.locator(".conversation-workspace").getByRole("heading", { name: "新建会话", exact: true }).waitFor();
  const secondCreatedId = host.snapshot.sessions.find((candidate) => candidate.cwd === manualTrustDir)?.sessionId;
  assert.ok(secondCreatedId, "Manual-trusted session created");
  assert.equal(host.requests.filter(request => request.method === "session.create").at(-1)?.params.trustWorkspace, undefined);

  // Verify per-session persistent drafts survive session switching, Back to catalog, and full page reload without cross-talk.
  const composerInput = page.locator(".composer-form textarea");
  await composerInput.fill("Draft for Session B");
  await openMobileDrawer(page);
  await page.locator(`.mobile-home-catalog [data-session-id="${firstCreatedId}"] .session-row-hit`).click();
  await composerInput.waitFor();
  assert.equal(await composerInput.inputValue(), "");
  await composerInput.fill("Draft for Session A");
  await openMobileDrawer(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".mobile-home-catalog").waitFor();
  await page.locator(`.mobile-home-catalog [data-session-id="${firstCreatedId}"] .session-row-hit`).click();
  await composerInput.waitFor();
  assert.equal(await composerInput.inputValue(), "Draft for Session A", "Session A draft restored after reload");
  await composerInput.fill("");
  await openMobileDrawer(page);
  await page.locator(`.mobile-home-catalog [data-session-id="${secondCreatedId}"] .session-row-hit`).click();
  await composerInput.waitFor();
  assert.equal(await composerInput.inputValue(), "Draft for Session B", "Session B draft restored without cross-talk after reload");
  await composerInput.fill("");

  assert.equal(host.requests.filter(request => ["turn.start", "turn.steer", "session.rewind", "permission.resolve"].includes(request.method)).length, 0);
  steps.push("untrusted folders sanitize WorkspaceTrustError into confirmation + saveTrust auto-retry, degrade to manual desktop guidance + one-click retry, and per-session drafts persist across reload");
}
