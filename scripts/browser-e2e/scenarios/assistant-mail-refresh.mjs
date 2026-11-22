import assert from "node:assert/strict";
import { expandInboxMail } from "../assistant-helpers.mjs";
import { desktopFixtureRequest, eventually, openMobileDrawer } from "../helpers.mjs";

function holdMailRead(host, method, match) {
  const send = host.send;
  const gate = Promise.withResolvers();
  let held = false;
  host.send = async payload => {
    if (payload.kind === "response" && host.requests.some(request =>
      request.requestId === payload.requestId && request.method === method && match(request.params))) {
      held = true;
      const error = await gate.promise;
      if (error) return send({ kind: "response", requestId: payload.requestId, ok: false, error });
    }
    return send(payload);
  };
  return {
    wait: (message = `Hold the ${method} response`) => eventually(() => held, true, message),
    release(error) { host.send = send; gate.resolve(error); },
  };
}

export async function verifyAssistantMailRefresh(page, host, steps) {
  const native = host.nativeApproval;
  const { service, deliver } = native.assistantMail;
  const ordinary = service.page({ cursor: "3", limit: 1 }).events[0];
  const filed = service.page({ cursor: "2", limit: 1 }).events[0];
  const staysFiled = service.page({ cursor: "4", limit: 1 }).events[0];
  service.setFolder(filed.mailRefId, "marketing", "user");
  service.setFolder(staysFiled.mailRefId, "marketing", "user");

  await openMobileDrawer(page);
  await page.locator(".drawer-assistant-capsule").click();
  const inbox = page.getByLabel("邮件输入", { exact: true });
  const inboxCard = mail => inbox.locator(`[data-mail-id="${mail.mailRefId}"]`);
  await page.getByRole("button", { name: "更早邮件", exact: true }).click();
  await inboxCard(ordinary).waitFor();
  await page.getByRole("button", { name: "助理设置", exact: true }).click();
  await page.getByRole("button", { name: "初始化托管助理", exact: true }).click();
  await page.getByRole("button", { name: "确认初始化", exact: true }).click();
  await page.getByRole("button", { name: "助理设置", exact: true }).click();
  await page.locator("label.toggle-row").filter({ has: page.getByRole("switch", { name: "主动助理" }) }).click();
  await eventually(() => host.snapshot.assistantMail.automaticDelivery, true, "Enable delivery for the synthetic managed session");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  const batches = page.locator(".assistant-trigger-batch");
  const batchCard = mail => batches.locator(`[data-mail-id="${mail.mailRefId}"]`);
  const historical = [];
  for (let index = 0; index < 2; index++) {
    const mail = await deliver(1);
    historical.push(mail);
    await batches.filter({ has: page.locator(`[data-mail-id="${mail.mailRefId}"]`) }).getByText("原生已观测", { exact: true }).waitFor();
  }
  const sessionId = host.snapshot.assistantMail.binding.nativeSessionId;
  native.setSessionBusy(sessionId, true);
  async function queueLinkedBatch() {
    const mail = await deliver(1);
    const batch = batches.filter({ has: page.locator(`[data-mail-id="${mail.mailRefId}"]`) });
    const cancel = batch.getByRole("button", { name: "撤回助理唤醒" });
    await cancel.and(page.locator(":enabled")).waitFor();
    const receipt = native.receipts().findLast(receipt => receipt.source === "assistant-trigger" && receipt.sessionId === sessionId && receipt.state === "queued");
    assert.ok(receipt);
    // The synthetic busy session does not publish a transcript row for a queued command by default.
    await host.emit("user.message.accepted", {
      commandId: receipt.commandId, requestId: receipt.requestId, delivery: "queued", source: "assistant-trigger",
      text: `助理事件批次 ${receipt.requestId}\nmail.received ${mail.mailRefId}`,
    }, { sessionId, itemId: receipt.messageId, turnId: receipt.messageId });
    await batch.getByText("关联原生消息", { exact: true }).waitFor();
    return { mail, batch, cancel, receipt };
  }
  const { mail: queued, batch: queuedBatch, cancel, receipt } = await queueLinkedBatch();
  await eventually(() => host.requests.some(({ method, params }) =>
    method === "plugin.assistant-mail.batch" && params.batchId === receipt.requestId), true, "Load the linked queued batch");
  assert.equal(await batches.count(), 3);

  const inboxTab = page.getByRole("button", { name: "收件", exact: true });
  const conversationTab = page.getByRole("button", { name: "对话", exact: true });
  const filedEntry = page.getByRole("button", { name: "已收纳 2 封", exact: true });
  const marketing = page.locator(".assistant-mail-group").filter({ hasText: "营销与垃圾邮件" });
  await inboxTab.click();
  await inboxCard(ordinary).waitFor();
  await filedEntry.click();
  await marketing.locator("summary").first().click();
  const filedCard = marketing.locator(`[data-mail-id="${filed.mailRefId}"]`);
  const returnToInbox = page.getByRole("button", { name: "返回收件" });
  await filedCard.waitFor();
  await returnToInbox.click();
  assert.equal(await batches.count(), 3, "The linked transcript stays mounted in the inbox");
  await batches.first().waitFor({ state: "hidden" });
  await marketing.waitFor({ state: "hidden" });
  assert.equal(await batches.filter({ hasText: "原生已观测" }).count(), 2);

  const beforeReopen = host.requests.length;
  await filedEntry.click();
  await filedCard.waitFor();
  await returnToInbox.click();
  await page.getByRole("button", { name: "刷新邮件列表", exact: true }).click();
  await page.getByRole("button", { name: "刷新邮件列表（已刷新）", exact: true }).waitFor();
  assert.equal(host.requests.slice(beforeReopen).filter(({ method, params }) =>
    method === "plugin.assistant-mail.list" && params.folder === "marketing").length, 0,
  "Reopening a loaded category without a mail change does not re-read it");

  async function countReadsAfterProcessing(mail, label) {
    const card = inboxCard(mail);
    await card.locator("summary").first().click();
    const before = host.requests.length;
    service.setProcessingStatus(mail.mailRefId, "processing");
    await card.locator(".assistant-mail-hint").filter({ hasText: "处理中" }).waitFor();
    const counts = { inbox: 0, filed: 0, search: 0, batch: 0 };
    for (const { method, params } of host.requests.slice(before)) {
      if (method === "plugin.assistant-mail.batch") counts.batch++;
      else if (method === "plugin.assistant-mail.list") counts[params.query ? "search" : params.folder === "inbox" ? "inbox" : "filed"]++;
    }
    steps.push(`${label}: ${JSON.stringify(counts)}`);
    return counts;
  }
  const ordinaryUpdate = await countReadsAfterProcessing(ordinary, "Ordinary second-page mail update while inbox is visible");
  const batchUpdate = await countReadsAfterProcessing(historical[0], "Linked batch member update while its transcript is hidden");

  const marketingRead = params => params.folder === "marketing";
  const folderError = { code: "MAIL_REJECTED", message: "隔离分类读取失败" };
  const folderGate = holdMailRead(host, "plugin.assistant-mail.list", marketingRead);
  const remainingCard = marketing.locator(`[data-mail-id="${staysFiled.mailRefId}"]`);
  const remainingAction = remainingCard.getByRole("button", { name: "收回收件" });
  try {
    const beforeMove = host.requests.length;
    service.setFolder(filed.mailRefId, "verification", "user");
    await eventually(() => host.requests.slice(beforeMove).some(({ method, params }) =>
      method === "plugin.assistant-mail.list" && params.folder === "inbox"), true, "The client received the filing change while the category was hidden");
    assert.ok(!host.requests.slice(beforeMove).some(({ method, params }) =>
      method === "plugin.assistant-mail.list" && marketingRead(params)), "The hidden category does not read after the filing change");
    await filedEntry.click();
    await folderGate.wait();
    assert.ok(await filedCard.getByRole("button", { name: "收回收件" }).isDisabled());
  } finally { folderGate.release(folderError); }
  await marketing.getByRole("alert").filter({ hasText: folderError.message }).waitFor();
  assert.ok(await remainingAction.isDisabled(), "The failed refresh leaves cached filing actions disabled");

  await returnToInbox.click();
  const retryGate = holdMailRead(host, "plugin.assistant-mail.list", marketingRead);
  try {
    await filedEntry.click();
    await retryGate.wait("Reopening the same category retries the failed refresh without another change");
    assert.ok(await remainingAction.isDisabled(), "Cached filing actions stay disabled while the retry is pending");
  } finally { retryGate.release(); }
  await filedCard.waitFor({ state: "detached" });
  await remainingAction.and(page.locator(":enabled")).waitFor();
  steps.push("Reopening the failed category retries the read and restores filing only after fresh cards arrive");
  await returnToInbox.click();

  const queuedInbox = inboxCard(queued);
  await queuedInbox.locator("summary").first().click();
  await queuedInbox.getByText("状态", { exact: true }).click();
  const batchGate = holdMailRead(host, "plugin.assistant-mail.batch", params => params.batchId === receipt.requestId);
  let withdrawnBeforeBatchRead;
  try {
    await native.controllerRequest(desktopFixtureRequest({ method: "turn.queue.cancel", params: { sessionId, commandId: receipt.commandId } }), "desktop");
    await queuedInbox.getByText("任务已取消", { exact: true }).waitFor();
    await conversationTab.click();
    await batchGate.wait();
    withdrawnBeforeBatchRead = await queuedBatch.getByText("已撤回", { exact: true }).isVisible() && await cancel.count() === 0;
  } finally { batchGate.release(); }
  await queuedBatch.getByText("已撤回", { exact: true }).waitFor();
  await (await expandInboxMail(batchCard(historical[0]))).locator(".assistant-mail-hint").filter({ hasText: "处理中" }).waitFor();
  assert.equal(native.receipts().find(({ commandId }) => commandId === receipt.commandId).state, "cancelled");

  await inboxTab.click();
  await filedEntry.click();
  await marketing.locator("summary").first().click();
  await remainingCard.waitFor();
  await returnToInbox.click();
  host.mailOffline = true;
  host.socket.close();
  const offline = page.getByText("电脑离线，显示已缓存邮件。", { exact: true });
  await offline.waitFor();
  service.setProcessingStatus(staysFiled.mailRefId, "processing");
  service.setProcessingStatus(historical[1].mailRefId, "processing");
  host.mailOffline = false;
  host.socket.connect();
  await offline.waitFor({ state: "hidden" });
  await inboxCard(ordinary).waitFor();
  await filedEntry.click();
  await remainingCard.locator(".assistant-mail-hint").filter({ hasText: "处理中" }).waitFor();
  await returnToInbox.click();
  await conversationTab.click();
  await (await expandInboxMail(batchCard(historical[1]))).locator(".assistant-mail-hint").filter({ hasText: "处理中" }).waitFor();

  assert.ok(withdrawnBeforeBatchRead, "Native withdrawal wins before the batch reply");
  assert.deepEqual({ ordinaryUpdate, batchUpdate }, {
    ordinaryUpdate: { inbox: 2, filed: 0, search: 0, batch: 0 },
    batchUpdate: { inbox: 2, filed: 0, search: 0, batch: 0 },
  }, "Inbox updates read the two loaded inbox pages without refreshing hidden folders or batches");

  const deliveryOnReopen = [];
  for (const state of ["started", "completed", "failed"]) {
    const { mail, batch, cancel, receipt } = await queueLinkedBatch();
    const status = batch.locator(":scope > header > span");
    const processing = (await expandInboxMail(batchCard(mail))).locator(".assistant-mail-hint").filter({ hasText: "处理中" });
    service.setProcessingStatus(mail.mailRefId, "processing");
    await processing.waitFor();
    assert.equal(await status.textContent(), "排队中");
    assert.equal(await cancel.isEnabled(), true);
    await inboxTab.click();
    await batch.waitFor({ state: "hidden" });
    const gate = holdMailRead(host, "plugin.assistant-mail.batch", params => params.batchId === receipt.requestId);
    let before;
    try {
      await native.advanceAssistantTrigger(sessionId, receipt.messageId, state);
      service.setProcessingStatus(mail.mailRefId, "pending");
      await conversationTab.click();
      await gate.wait();
      await processing.waitFor();
      before = { label: await status.textContent(), canCancel: await cancel.count() > 0 };
    } finally { gate.release(); }
    await processing.waitFor({ state: "hidden" });
    const after = { label: await status.textContent(), canCancel: await cancel.count() > 0 };
    deliveryOnReopen.push({ state, before, after });
  }
  assert.deepEqual(deliveryOnReopen, [["started", "运行中"], ["completed", "已完成"], ["failed", "失败"]].map(([state, label]) => ({
    state, before: { label, canCancel: false }, after: { label, canCancel: false },
  })), "Native lifecycle controls batch status and withdrawal before and after the delayed mail read");
  steps.push("已加载的批次在补读前后都显示原生运行、完成或失败状态，只有排队时可撤回");
}
