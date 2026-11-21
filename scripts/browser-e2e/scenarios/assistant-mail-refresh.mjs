import assert from "node:assert/strict";
import { eventually, openMobileDrawer } from "../helpers.mjs";

export async function verifyAssistantMailRefresh(page, host, steps) {
  const native = host.nativeApproval;
  const { service, deliver } = native.assistantMail;
  const ordinary = service.page({ cursor: "3", limit: 1 }).events[0];
  const filed = service.page({ cursor: "2", limit: 1 }).events[0];
  service.setFolder(filed.mailRefId, "marketing", "user");

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
  native.setSessionBusy(host.snapshot.assistantMail.binding.nativeSessionId, true);
  const queued = await deliver(1);
  const queuedBatch = batches.filter({ has: page.locator(`[data-mail-id="${queued.mailRefId}"]`) });
  const cancel = queuedBatch.getByRole("button", { name: "撤回助理唤醒" });
  await cancel.waitFor();
  assert.equal(await batches.count(), 3);

  const inboxTab = page.getByRole("button", { name: "收件", exact: true });
  const conversationTab = page.getByRole("button", { name: "对话", exact: true });
  const filedEntry = page.getByRole("button", { name: "已收纳 1 封", exact: true });
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

  await conversationTab.click();
  await batchCard(historical[0]).locator(".assistant-mail-hint").filter({ hasText: "处理中" }).waitFor();
  await cancel.click();
  await queuedBatch.getByText("已撤回", { exact: true }).waitFor();
  assert.equal(host.requests.filter(request => request.method === "turn.queue.cancel").length, 1);

  await inboxTab.click();
  await filedEntry.click();
  await marketing.locator("summary").first().click();
  await filedCard.waitFor();
  await returnToInbox.click();
  host.mailOffline = true;
  host.socket.close();
  const offline = page.getByText("电脑离线，显示已缓存邮件。", { exact: true });
  await offline.waitFor();
  service.setProcessingStatus(filed.mailRefId, "processing");
  service.setProcessingStatus(historical[1].mailRefId, "processing");
  host.mailOffline = false;
  host.socket.connect();
  await offline.waitFor({ state: "hidden" });
  await inboxCard(ordinary).waitFor();
  await filedEntry.click();
  await filedCard.locator(".assistant-mail-hint").filter({ hasText: "处理中" }).waitFor();
  await returnToInbox.click();
  await conversationTab.click();
  await batchCard(historical[1]).locator(".assistant-mail-hint").filter({ hasText: "处理中" }).waitFor();

  assert.deepEqual({ ordinaryUpdate, batchUpdate }, {
    ordinaryUpdate: { inbox: 2, filed: 0, search: 0, batch: 0 },
    batchUpdate: { inbox: 2, filed: 0, search: 0, batch: 0 },
  }, "Inbox updates read the two loaded inbox pages without refreshing hidden folders or batches");
}
