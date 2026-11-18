import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sessionId, originalTitle } from "../config.mjs";
import { eventually, openMobileSession, customSelectValue } from "../helpers.mjs";

export async function verifyNativeQueueActions(page, host, steps, directory, relayPeers) {
  await openMobileSession(page);
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const composer = page.getByRole("combobox", { name: "给 Claude 发指令" });
  const draft = "保留草稿：queue actions must never submit this";
  const historyMessage = page.locator("article.conversation-item.user").filter({ hasText: "历史中的原生排队消息" });
  await historyMessage.getByRole("status").getByText("已排队", { exact: true }).waitFor();
  assert.equal(await page.getByRole("status", { name: "消息排队状态" }).count(), 0);
  assert.equal(await page.locator(".session-activity.queued").count(), 0);
  assert.equal(await historyMessage.count(), 1);
  assert.equal(host.events.length, 0, "Seeded queue must be restored from real native history without delivery events");
  assert.equal(host.queueSeed.receipt.queueMode, "deferred");
  assert.deepEqual(host.session.pendingCommandIds, [host.queueSeed.receipt.commandId]);
  await composer.fill(draft);
  await historyMessage.getByRole("button", { name: "回退到这条消息之前", exact: true }).click();
  const unavailableRewind = page.getByRole("dialog", { name: "回退会话", exact: true });
  await unavailableRewind.getByText("Desktop 无法回退到这条消息之前的对话。", { exact: true }).waitFor();
  assert.equal(await unavailableRewind.getByRole("button", { name: "确认回退", exact: true }).isDisabled(), true, "A queued message without an assistant anchor cannot rewind while Native files are busy");
  assert.ok((await unavailableRewind.innerText()).includes("Session is busy"));
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "rewindV2" || (call.method === "rewindFiles" && call.args[2] === false)).length, 0, "An unavailable preview performs no restore mutation");
  await page.screenshot({ path: resolve(directory, "queue-rewind-unavailable.png"), fullPage: true });
  await unavailableRewind.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await composer.inputValue(), draft);
  assert.equal(host.nativeApproval.receipts()[0].state, "queued");
  steps.push("queued rewind without a native assistant anchor reports unavailable; busy files cannot enable confirmation, cancellation preserves the original receipt and draft, and preview performs no restore");
  await page.screenshot({ path: resolve(directory, "queue-history.png"), fullPage: true });
  const release = host.nativeApproval.holdQueueAction();
  try {
    await historyMessage.getByRole("button", { name: "立即发送", exact: true }).dblclick();
    await eventually(() => host.nativeApproval.calls.filter(call => call.method === "promoteQueuedMessage").length, 1, "Rapid double-click reaches native promoteQueuedMessage once");
    const beforeReconnect = host.requests.filter(request => request.method === "snapshot.get").length;
    const peers = [...relayPeers].filter(([, hello]) => hello.roomId === host.pairing.roomId && hello.role === "mobile");
    assert.equal(peers.length, 1);
    peers[0][0].close(1012, "disconnect while 立即发送 is pending");
    await eventually(() => host.requests.filter(request => request.method === "snapshot.get").length > beforeReconnect, true, "Pending queue operation reconnects through the real socket");
    assert.equal(host.requests.filter(request => request.method === "turn.queue.steer").length, 1, "Reconnect must not replay the transient queue mutation");
    assert.deepEqual(host.nativeApproval.calls.find(call => call.method === "promoteQueuedMessage").args, [sessionId, host.queueSeed.receipt.messageId]);
    assert.equal(await historyMessage.getByRole("button", { name: "立即发送", exact: true }).getAttribute("aria-busy"), "true");
    assert.equal(await historyMessage.getByRole("button", { name: "撤回", exact: true }).isDisabled(), true, "Queue actions share pending state");
    assert.equal(await composer.inputValue(), draft);
    await page.screenshot({ path: resolve(directory, "queue-pending.png"), fullPage: true });
  } finally { release(); }
  await eventually(() => historyMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Requested 立即发送 must leave cancel enabled");
  assert.equal(await historyMessage.getByRole("button", { name: "立即发送", exact: true }).isDisabled(), true);
  host.nativeApproval.queueResult("cancelQueuedMessage", false);
  const releaseCancel = host.nativeApproval.holdQueueAction();
  try {
    await historyMessage.getByRole("button", { name: "撤回", exact: true }).dblclick();
    await eventually(() => host.nativeApproval.calls.filter(call => call.method === "cancelQueuedMessage").length, 1, "Rapid double-click withdraws at most once while pending");
    assert.equal(await historyMessage.getByRole("button", { name: "撤回", exact: true }).isDisabled(), true);
  } finally { releaseCancel(); }
  await historyMessage.getByRole("alert").filter({ hasText: "无法撤回" }).waitFor();
  await historyMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  assert.equal(host.nativeApproval.receipts()[0].state, "queued", "Native false cannot cancel the receipt");
  assert.equal(await composer.inputValue(), draft);
  await page.screenshot({ path: resolve(directory, "queue-cancel-refused.png"), fullPage: true });
  host.nativeApproval.queueResult("cancelQueuedMessage", true);
  await historyMessage.getByRole("button", { name: "撤回", exact: true }).click();
  await historyMessage.getByRole("status").filter({ hasText: "已取消" }).waitFor();
  assert.equal(await historyMessage.getByRole("button", { name: "撤回", exact: true }).count(), 0);
  assert.equal(await historyMessage.getByRole("alert").count(), 0);
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "cancelQueuedMessage").map(call => call.args), [[sessionId, host.queueSeed.receipt.messageId], [sessionId, host.queueSeed.receipt.messageId]]);
  assert.equal(await composer.inputValue(), draft);
  assert.equal(host.requests.filter(request => ["turn.start", "turn.steer", "turn.interrupt"].includes(request.method)).length, 0, "History queue actions must never submit or interrupt a turn");
  steps.push("history-only queued receipt restores actions; deferred 立即发送 uses original native UUID, shares pending state, permits later cancel, and native false is visible/retryable without changing draft");

  const text = "浏览器发出的原生排队消息";
  await composer.fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const localMessage = page.locator("article.conversation-item.user").filter({ hasText: text });
  await localMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  const localReceipt = host.nativeApproval.receipts().find(receipt => receipt.commandId !== host.queueSeed.receipt.commandId);
  assert.equal(localReceipt.state, "queued");
  assert.equal(localReceipt.queueMode, "deferred");
  assert.equal(await localMessage.count(), 1, "Local send reconciles with native receipt into one bubble");
  await localMessage.getByRole("button", { name: "复制这条消息", exact: true }).waitFor();
  const oldCopy = historyMessage.getByRole("button", { name: "复制这条消息", exact: true });
  const oldRewind = historyMessage.getByRole("button", { name: "回退到这条消息之前", exact: true });
  assert.equal(await oldCopy.count(), 0);
  assert.equal(await oldRewind.count(), 0);
  await historyMessage.locator(".conversation-bubble").tap();
  await oldCopy.waitFor();
  await oldRewind.waitFor();
  await historyMessage.locator(".conversation-bubble").tap();
  await oldCopy.waitFor({ state: "hidden" });
  await oldRewind.waitFor({ state: "hidden" });
  steps.push("Latest mobile copy is visible by default, and tapping an older bubble reveals or hides its copy and rewind");
  const localRequest = host.requests.find(request => request.method === "turn.start");
  assert.equal(localReceipt.requestId, localRequest.requestId);
  assert.equal(localReceipt.idempotencyKey, localRequest.idempotencyKey);
  await composer.fill(draft);
  host.nativeApproval.queueResult("promoteQueuedMessage", false);
  await localMessage.getByRole("button", { name: "立即发送", exact: true }).click();
  await localMessage.getByRole("alert").filter({ hasText: "无法立即发送" }).waitFor();
  await localMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  assert.equal(await composer.inputValue(), draft);
  await page.screenshot({ path: resolve(directory, "queue-send-refused.png"), fullPage: true });
  host.nativeApproval.queueResult("promoteQueuedMessage", true);
  await localMessage.getByRole("button", { name: "立即发送", exact: true }).click();
  await eventually(() => localMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Retry success preserves cancel action");
  assert.equal(await localMessage.getByRole("alert").count(), 0);
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "promoteQueuedMessage").slice(1).map(call => call.args), [[sessionId, localReceipt.messageId], [sessionId, localReceipt.messageId]]);
  steps.push("one browser turn.start traverses the real controller/facade; native queued result reconciles once, 立即发送 false remains visible and retry uses the same native UUID");

  const rekeyedId = randomUUID();
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "steers_rekeyed", rekeyedSteers: [{ from: localReceipt.messageId, to: rekeyedId }] }));
  assert.deepEqual(host.events.filter(event => event.type === "message.delivery").at(-1).data.previousMessageId, localReceipt.messageId);
  await eventually(() => localMessage.getAttribute("data-stream-key"), rekeyedId, "Top-level native rekey moves the displayed bubble to the new UUID");
  assert.equal(await localMessage.count(), 1, "Rekey must not duplicate the local/history bubble");
  assert.equal(host.nativeApproval.receipts().find(receipt => receipt.commandId === localReceipt.commandId).messageId, rekeyedId, "Rekey persists the real receipt");
  const snapshotCount = host.requests.filter(request => request.method === "snapshot.get").length;
  const mobilePeers = [...relayPeers].filter(([, hello]) => hello.roomId === host.pairing.roomId && hello.role === "mobile");
  assert.equal(mobilePeers.length, 1);
  mobilePeers[0][0].close(1012, "queue scenario reconnect");
  await eventually(() => host.requests.filter(request => request.method === "snapshot.get").length > snapshotCount, true, "Real encrypted socket reconnect fetches queue snapshot");
  await localMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  await eventually(() => localMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Reconnect restores queued cancel action");
  assert.equal(await localMessage.count(), 1);
  assert.equal(await composer.inputValue(), draft);
  await page.screenshot({ path: resolve(directory, "queue-rekey-reconnected.png"), fullPage: true });
  const missedRekeyId = randomUUID();
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "steers_rekeyed", rekeyedSteers: [{ from: rekeyedId, to: missedRekeyId }] }), { pushEvents: false });
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await eventually(() => localMessage.getAttribute("data-stream-key"), missedRekeyId, "Fresh history reconciles the cached UUID without its missing rekey event");
  assert.equal(await localMessage.count(), 1, "Stable receipt identity must collapse the old cached bubble and current native history");
  await composer.fill(draft);
  await page.screenshot({ path: resolve(directory, "queue-missing-rekey-recovered.png"), fullPage: true });
  await localMessage.getByRole("button", { name: "撤回", exact: true }).click();
  await localMessage.getByRole("status").filter({ hasText: "已取消" }).waitFor();
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "cancelQueuedMessage").at(-1).args, [sessionId, missedRekeyId]);
  assert.equal(await composer.inputValue(), draft);
  steps.push("top-level steers_rekeyed persists the new UUID and keeps one bubble; real socket reconnect restores queue/draft, and subsequent cancel uses the new UUID and shows 已取消");

  const steered = await host.syncNativeQueue(await host.nativeApproval.enqueue("历史中的 steered 排队消息", "steered"), { pushEvents: false });
  assert.equal(steered.receipt.queueMode, "steered");
  // A fresh page must recover native history/receipt controls without local turns or delivery events for this seed.
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const steeredMessage = page.locator("article.conversation-item.user").filter({ hasText: "历史中的 steered 排队消息" });
  await steeredMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  await composer.fill(draft);
  await steeredMessage.getByRole("button", { name: "立即发送", exact: true }).click();
  await eventually(() => host.nativeApproval.calls.filter(call => call.method === "sendSteeredNow").length, 1, "Steered queue uses native sendSteeredNow");
  assert.deepEqual(host.nativeApproval.calls.find(call => call.method === "sendSteeredNow").args, [sessionId, steered.receipt.messageId]);
  await eventually(() => steeredMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Steered 立即发送 still permits cancel");
  const resumesBeforeLateCancel = host.requests.filter(request => request.method === "events.resume").length;
  const releaseLateCancel = host.nativeApproval.holdQueueAction();
  try {
    await steeredMessage.getByRole("button", { name: "撤回", exact: true }).click();
    await eventually(() => host.nativeApproval.calls.filter(call => call.method === "cancelQueuedMessage" && call.args[1] === steered.receipt.messageId).length, 1, "Cancel remains pending at the native boundary");
    await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "command_lifecycle", command_uuid: steered.receipt.messageId, state: "started" } }));
    await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "result", user_message_uuid: steered.receipt.messageId, is_error: false } }));
    await steeredMessage.getByRole("status").filter({ hasText: "已完成" }).waitFor();
  } finally { releaseLateCancel(); }
  await eventually(() => host.requests.filter(request => request.method === "events.resume").length > resumesBeforeLateCancel, true, "Late cancel response reaches the browser and resumes events");
  assert.equal(host.nativeApproval.receipts().find(receipt => receipt.commandId === steered.receipt.commandId).state, "completed", "Late native cancel true cannot overwrite an observed completion");
  await steeredMessage.getByRole("status").filter({ hasText: "已完成" }).waitFor();
  assert.equal(host.events.some(event => event.type === "message.delivery" && event.data.commandId === steered.receipt.commandId && event.data.delivery === "cancelled"), false);
  assert.equal(await composer.inputValue(), draft);
  assert.equal(host.requests.filter(request => request.method === "turn.start").length, 1, "All queue actions/reconnects preserve exactly one deliberate composer submission");
  assert.equal(host.requests.filter(request => ["turn.steer", "turn.interrupt"].includes(request.method)).length, 0);
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "sendMessage").length, 3, "Only two fixture seeds and one deliberate browser submit reach native sendMessage");
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "interrupt").length, 0);
  for (const request of host.requests.filter(request => ["turn.queue.steer", "turn.queue.cancel"].includes(request.method))) {
    assert.equal("text" in request.params || "attachments" in request.params, false, "Queue actions carry command identity without resubmitting content");
  }
  assert.deepEqual(host.nativeApproval.receipts().map(receipt => ({ commandId: receipt.commandId, state: receipt.state })), [
    { commandId: host.queueSeed.receipt.commandId, state: "cancelled" },
    { commandId: localReceipt.commandId, state: "cancelled" },
    { commandId: steered.receipt.commandId, state: "completed" },
  ]);
  assert.equal(host.session.pendingCount, 0);
  assert.deepEqual(host.session.pendingCommandIds, []);
  assert.equal(await page.getByRole("button", { name: "立即发送", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "撤回", exact: true }).count(), 0);
  assert.equal(await page.getByRole("status", { name: "消息排队状态" }).count(), 0);
  assert.equal(await historyMessage.evaluate(message => {
    const bubble = message.querySelector(".conversation-bubble");
    const status = message.querySelector(".delivery-state");
    return status.getBoundingClientRect().right - bubble.getBoundingClientRect().right;
  }), 0, "A standalone delivery status aligns with its bubble edge");
  await page.screenshot({ path: resolve(directory, "queue-terminal-states.png"), fullPage: true });
  steps.push("fresh history reconciles a missed rekey into one cached bubble; steered 立即发送 uses its native UUID; completed events preceding a delayed cancel true remain completed; successful cancels persist and queue actions never resubmit or interrupt");

  for (const event of await host.nativeApproval.message({ type: "assistant", uuid: "received-rewind-anchor", timestamp: Date.now(), message: { content: [{ type: "text", text: "保留的原生回退锚点" }] } })) await host.emit(event.type, event.data, { itemId: event.itemId });
  host.nativeApproval.queuedReply(false);
  const receivedText = "只有 delivered 确认、仍在等待读取的指令";
  assert.equal(await page.locator(".composer-mode").count(), 0, "Running conversations have no composer mode selector");
  await composer.fill(receivedText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await eventually(() => host.nativeApproval.receipts().length, 4, "A normal browser send reaches the native receipt without a queued flag");
  await eventually(() => host.nativeApproval.receipts().at(-1)?.state, "submitted", "The delivered-only Native reply must arrive before checking the submitted receipt");
  const received = host.nativeApproval.receipts().at(-1);
  assert.equal(received.queueMode, "deferred");
  assert.equal(received.state, "submitted");
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "user", uuid: received.messageId, message: { content: receivedText } } }));
  const receivedMessage = page.locator("article.conversation-item.user").filter({ hasText: receivedText });
  await receivedMessage.getByRole("status").filter({ hasText: "已接收" }).waitFor();
  assert.equal(host.nativeApproval.receipts().at(-1).state, "session-received");
  assert.equal(host.session.pendingCount, 0, "The adapter does not invent queued status to expose actions");
  await composer.fill(draft);
  await receivedMessage.getByRole("button", { name: "立即发送", exact: true }).click();
  await eventually(() => host.nativeApproval.calls.filter(call => call.method === "promoteQueuedMessage" && call.args[1] === received.messageId).length, 1, "Received-only 立即发送 promotes the normally submitted message exactly once");
  await eventually(() => receivedMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Received-only 立即发送 preserves draft and later cancellation");
  assert.equal(await composer.inputValue(), draft);
  assert.equal(await receivedMessage.getByRole("button", { name: "回退到这条消息之前", exact: true }).isEnabled(), true);
  await page.screenshot({ path: resolve(directory, "queue-received-actions.png"), fullPage: true });
  await receivedMessage.getByRole("button", { name: "回退到这条消息之前", exact: true }).click();
  const rewind = page.getByRole("dialog", { name: "回退会话", exact: true });
  await eventually(() => rewind.getByRole("button", { name: "确认回退", exact: true }).isEnabled(), true, "Native conversation rewind remains available while its file preview reports busy");
  assert.equal(await customSelectValue(rewind.getByRole("combobox", { name: "回退范围", exact: true })), "conversation");
  assert.ok((await rewind.innerText()).includes("停止当前任务"));
  await page.screenshot({ path: resolve(directory, "queue-running-rewind-preview.png"), fullPage: true });
  await rewind.getByRole("button", { name: "确认回退", exact: true }).click();
  await rewind.waitFor({ state: "hidden" });
  await eventually(() => receivedMessage.count(), 0, "Confirmed native rewind removes the selected received message");
  await eventually(() => composer.inputValue(), receivedText, "Native prefill restores the received message as an editable draft");
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "rewindV2").at(-1).args, [sessionId, received.messageId]);
  assert.equal(host.nativeApproval.receipts().at(-1).state, "cancelled", "The native close withdrawal clears the original queued receipt");
  assert.equal(host.session.pendingCount, 0);
  assert.equal(host.session.turnState, "idle");
  assert.equal(host.requests.filter(request => request.method === "turn.start").length, 2, "Only the two deliberate browser submissions are sent");
  assert.equal(host.requests.filter(request => request.method === "turn.steer").length, 0);
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "sendMessage").length, 4);
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "interrupt").length, 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await page.getByText("保留的原生回退锚点", { exact: true }).waitFor();
  assert.equal(await receivedMessage.count(), 0, "Replayed pre-rewind events cannot revive the discarded received message");
  await page.screenshot({ path: resolve(directory, "queue-running-rewind-complete.png"), fullPage: true });
  steps.push("normal sends without a composer mode selector keep delivered-only replies received but expose 立即发送 and native rewind; active rewind uses the user UUID/assistant anchor, stops through Native, clears withdrawal receipts, restores text and survives reload without resubmitting");

  const completedText = "已得到回复的原生消息";
  await composer.fill(completedText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await eventually(() => host.nativeApproval.receipts().at(-1)?.state, "submitted", "Native accepted the new send RPC");
  const completedReceipt = host.nativeApproval.receipts().at(-1);
  for (const message of [
    { type: "user", uuid: completedReceipt.messageId, message: { content: completedText } },
    { type: "assistant", uuid: "uncorrelated-reply", message: { content: [{ type: "text", text: "原生回复已结束。" }] } },
    { type: "result", uuid: "uncorrelated-result", subtype: "success", is_error: false },
  ]) {
    const events = await host.nativeApproval.message({ ...message, timestamp: Date.now() });
    await host.syncNativeQueue({ events, history: await host.nativeApproval.history(), session: host.nativeApproval.session() });
  }
  assert.equal(host.nativeApproval.receipts().at(-1).state, "session-received", "An uncorrelated result must not promote the stored receipt");
  const completedMessage = page.locator("article.conversation-item.user").filter({ hasText: completedText });
  await page.getByText("原生回复已结束。", { exact: true }).waitFor();
  await eventually(() => completedMessage.locator(".delivery-state").count(), 0, "Answered native input stops showing its stale received badge");
  assert.equal(await completedMessage.locator(".conversation-message-actions").evaluate(node => getComputedStyle(node).display), "flex", "Queue controls stay on the same row without a delivery badge");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await completedMessage.waitFor();
  await page.getByText("原生回复已结束。", { exact: true }).waitFor();
  assert.equal(await completedMessage.locator(".delivery-state").count(), 0, "History keeps the stale received badge hidden after reload");
  steps.push("an uncorrelated result leaves the stored receipt intact and the answered mobile bubble hides its stale received badge live and after reload");
}
