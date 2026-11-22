import assert from "node:assert/strict";
import { resolve } from "node:path";
import { sessionId } from "../config.mjs";
import { desktopFixtureRequest, eventually, openMobileDrawer, openMobileSession } from "../helpers.mjs";
import { expandInboxMail, fileMailInCategory, openDesktopAssistant } from "../assistant-helpers.mjs";

export async function verifyAssistantAttention(page, host, steps, directory, viewports, baseUrl) {
  const native = host.nativeApproval;
  const { service, deliver, agenda } = native.assistantMail;
  const entry = page.locator(".drawer-assistant-capsule");
  const label = () => entry.getAttribute("aria-label");
  const attention = page.locator(".assistant-attention");
  const lit = "助理，有事项待关注";
  const back = () => page.locator(".assistant-page").getByRole("button", { name: "返回", exact: true }).click();
  const dismiss = () => page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  const analyze = (event, level, category = "other") => native.callAssistantTool("mail.update_analysis", {
    mailRefId: event.mailRefId, attention: level, category, summary: "隔离筛选", suggestions: [], questions: [],
  });
  await openMobileDrawer(page);
  assert.equal(await label(), "助理");
  service.setAutomaticDelivery(true);
  const ads = await deliver(1);
  await eventually(label, lit, "Unclassified arrivals badge immediately even with proactive delivery on");
  await analyze(ads, "ignore", "marketing");
  await eventually(label, "助理", "Filing marketing clears the last unread arrival");
  const worth = await deliver(1);
  await eventually(label, lit, "A second unclassified arrival lights the entry");
  await analyze(worth, "read", "account");
  assert.equal(service.event(worth.mailRefId).analysis.category, "account");
  assert.equal(service.event(worth.mailRefId).analysis.attention, "read");
  await eventually(label, lit, "Classified mail lights the entry; routine marketing does not");
  assert.equal(await entry.locator(".desktop-nav-badge").count(), 0, "The new entry is a dot, not an unread count");
  await entry.click();
  await page.getByRole("button", { name: "收件", exact: true }).click();
  const unreadCard = page.locator(`.assistant-mail-list [data-mail-id="${worth.mailRefId}"]`);
  await expandInboxMail(unreadCard);
  await unreadCard.getByText("状态", { exact: true }).click();
  await unreadCard.getByText("待处理", { exact: true }).waitFor();
  assert.equal(host.requests.some(request => request.method === "plugin.assistant-mail.read" && request.params.mailRefId === worth.mailRefId), false);
  assert.equal(host.requests.some(request => request.method === "plugin.assistant-mail.attention.ack" && request.params.id === worth.mailRefId), false);
  assert.ok(host.snapshot.assistantMail.attention.some(item => item.id === worth.mailRefId), "Opening status leaves the host attention item intact");
  await attention.locator("summary").click();
  await attention.getByText("值得看", { exact: true }).waitFor();
  assert.equal(await attention.locator("li").count(), 1, "Opening Assistant does not acknowledge a mail");
  await page.screenshot({ path: resolve(directory, "mobile-assistant-attention.png") });
  viewports.push({ page: "mobile-assistant-attention", ...page.viewportSize() });
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); });
  await attention.getByRole("button", { name: /值得看/u }).click();
  await page.locator(".assistant-attention-original").waitFor();
  assert.equal(host.requests.some(request => request.method === "plugin.assistant-mail.attention.ack" && request.params.id === worth.mailRefId), false,
    "A loaded original behind a background tab does not mark the mail seen");
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await attention.waitFor({ state: "hidden" });
  await dismiss();
  await back();
  await eventually(label, "助理", "Reading the single message clears attention");

  service.setAutomaticDelivery(false);
  const action = await deliver(1);
  await eventually(label, lit, "With proactive delivery off, new mail lights immediately");
  await analyze(action, "action", "account");
  const todoTitle = "核对并提交预算";
  agenda.saveTodo({ value: { title: todoTitle, remindAt: new Date(Date.now() - 1000).toISOString(), status: "pending" } });
  agenda.saveEvent({ value: { title: "团队同步", startAt: new Date(Date.now() + 60_000).toISOString(),
    endAt: new Date(Date.now() + 120_000).toISOString(), remindAt: new Date(Date.now() - 1000).toISOString(), allDay: false, timeZone: "UTC" } });
  const draft = (await native.draftProposal({ kind: "todo.create", sourceId: "local", value: { title: "提案核对", status: "pending" } })).result;
  for (const message of [
    { type: "user", uuid: "attention-user-input", message: { content: "请给我一条最新回复" } },
    { type: "assistant", uuid: "attention-user-reply", message: { id: "attention-reply-item", content: [{ type: "text", text: "预算已更新，可查看最新版本。" }] } },
    { type: "result", uuid: "attention-user-result", is_error: false, user_message_uuid: "attention-user-input" },
  ]) await native.message({ timestamp: Date.now(), ...message });
  native.appendHistory(Array.from({ length: 110 }, (_, index) => ({ type: "user", uuid: `after-reply-${index}`,
    timestamp: Date.now() + index + 1, message: { content: `同步记录 ${index}` } })));
  await host.syncNativeQueue({ events: [], history: await native.history(200), session: native.session() });
  await eventually(() => host.snapshot.assistantMail.attention.some(item => item.kind === "reply"), true, "Native final user reply is tracked before the conversation is viewed");
  service.setAutomaticDelivery(true);

  const desktop = await page.context().newPage();
  try {
    await openDesktopAssistant(desktop, host, baseUrl, []);
    await desktop.locator(".sidebar-assistant-row .sidebar-unread-dot").waitFor();
    await desktop.locator(".assistant-attention > summary").click();
    await desktop.getByText("需要处理", { exact: true }).waitFor();
    await desktop.screenshot({ path: resolve(directory, "desktop-assistant-attention.png") });
    viewports.push({ page: "desktop-assistant-attention", ...desktop.viewportSize() });

    await entry.click();
    const card = client => client.locator(`.assistant-mail-list [data-mail-id="${action.mailRefId}"]`);
    const mark = client => card(client).getByRole("button", { name: "收入分类", exact: true });
    const inboxCard = client => client.getByLabel("邮件输入", { exact: true }).locator(`[data-mail-id="${action.mailRefId}"]`);
    for (const client of [page, desktop]) {
      await client.getByRole("button", { name: "收件", exact: true }).click();
      await expandInboxMail(inboxCard(client));
      await mark(client).waitFor();
    }
    const desktopPicker = desktop.getByRole("dialog", { name: "收入分类", exact: true });
    await mark(desktop).click();
    await desktopPicker.waitFor();
    await desktop.evaluate(host => window.assistantDesktopSnapshot({ host }), { ...host.snapshot.host,
      capabilities: host.snapshot.host.capabilities.filter(value => value !== "plugin.assistant-mail.filing.v1") });
    await mark(desktop).waitFor({ state: "detached" });
    await desktopPicker.waitFor({ state: "detached" });
    await inboxCard(desktop).waitFor();
    assert.equal(await desktop.locator(".assistant-mail-group").count(), 0, "A legacy analysis label is not a filed location");
    await desktop.evaluate(host => window.assistantDesktopSnapshot({ host }), host.snapshot.host);
    await mark(desktop).waitFor();

    const publishDesktop = () => desktop.evaluate(assistantMail => window.assistantDesktopSnapshot({ assistantMail }), host.snapshot.assistantMail);
    await fileMailInCategory(page, card(page), "营销与垃圾邮件");
    await inboxCard(page).waitFor({ state: "detached" });
    await publishDesktop();
    await inboxCard(desktop).waitFor({ state: "detached" });
    assert.equal(host.snapshot.assistantMail.attention.some(item => item.id === action.mailRefId), false);
    assert.equal(host.snapshot.assistantMail.attention.some(item => item.kind === "todo"), true);
    await page.getByRole("button", { name: "已收纳 2 封", exact: true }).click();
    await page.getByRole("region", { name: "已收纳", exact: true }).locator(".assistant-mail-group > summary")
      .filter({ hasText: "营销与垃圾邮件" }).press("Enter");
    const restore = card(page).getByRole("button", { name: "收回收件", exact: true });
    await restore.waitFor();
    assert.ok(await restore.evaluate(element => element.getBoundingClientRect().height >= 44));
    await page.screenshot({ path: resolve(directory, "mobile-mail-filing.png") });
    viewports.push({ page: "mobile-mail-filing", ...page.viewportSize() });
    await restore.click();
    await restore.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "返回收件", exact: true }).click();
    await inboxCard(page).waitFor();
    await publishDesktop();
    await expandInboxMail(inboxCard(desktop));
    await mark(desktop).waitFor();
    assert.equal(host.snapshot.assistantMail.attention.some(item => item.id === action.mailRefId), true);
    steps.push("Manual filing removes mail attention, leaves tasks alone, and restores the mail and attention on desktop and mobile");
  } finally { await desktop.close(); }

  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileDrawer(page);
  await entry.click();
  await page.locator(".assistant-conversation [data-stream-key=after-reply-109]").waitFor();
  const reply = page.locator(".assistant-conversation [data-stream-key=attention-reply-item]");
  assert.equal(await reply.count(), 0, "The reply is beyond the first Native history page");
  await host.emit("evidence.ready", { evidence: { id: "attention-evidence", sessionId, turnId: "after-reply-109", source: "claude-desktop", confidence: "exact",
    state: "ready", startedAt: Date.now() + 1000, toolCount: 0, changeCount: 1, artifactCount: 0, tools: [], artifacts: [], warnings: [] } });
  await page.locator(".assistant-conversation .evidence-inline-summary").click();
  await page.getByRole("button", { name: "返回对话", exact: true }).waitFor();
  await attention.locator("summary").click();
  await attention.getByRole("button", { name: /助理回复/u }).click();
  await reply.getByText("预算已更新，可查看最新版本。", { exact: true }).waitFor();
  assert.ok(host.requests.filter(request => request.method === "session.history").length >= 2, "Reply lookup loads older Native pages");
  const visibility = await reply.evaluate(element => new Promise(resolve => {
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect();
      resolve({ hidden: document.hidden, covered: Boolean(document.body.querySelector(':scope > .m-sheet-backdrop')), height: entry.boundingClientRect.height, intersection: entry.intersectionRect.height });
    });
    observer.observe(element);
  }));
  assert.ok(!visibility.hidden && !visibility.covered && visibility.intersection >= Math.min(36, visibility.height * 0.95), JSON.stringify(visibility));
  await eventually(() => host.snapshot.assistantMail.attention.some(item => item.kind === "reply"), false, "A visible reply is acknowledged individually");
  await attention.getByRole("button", { name: /需要处理/u }).click();
  await page.locator(".assistant-attention-original").waitFor();
  async function deliverReply(id, text) {
    const events = [];
    for (const message of [
      { type: "user", uuid: `${id}-input`, message: { content: "请检查提交状态" } },
      { type: "assistant", uuid: `${id}-response`, message: { id: `${id}-reply`, content: [{ type: "text", text }] } },
      { type: "result", uuid: `${id}-result`, is_error: false, user_message_uuid: `${id}-input` },
    ]) events.push(...await native.message({ timestamp: Date.now(), ...message }));
    const session = native.session();
    host.session.lastCompletedTurnId = session.lastCompletedTurnId;
    await host.syncNativeQueue({ events, history: await native.history(200), session });
  }
  const historyNotice = page.locator(".assistant-conversation .latest-history-notice");
  const { promise, resolve: releaseHistory } = Promise.withResolvers();
  host.historyGate = promise;
  try {
    await deliverReply("covered", "提交已完成。");
    await historyNotice.waitFor();
  } finally {
    releaseHistory();
    host.historyGate = undefined;
  }
  // The completed turn refreshes history and can restore the previous reading position.
  await historyNotice.waitFor({ state: "hidden" });
  const coveredReply = page.locator(".assistant-conversation [data-stream-key=covered-reply]");
  await coveredReply.evaluate(element => element.scrollIntoView({ block: "center" }));
  assert.equal(await coveredReply.evaluate(element => new Promise(resolve => {
    const observer = new IntersectionObserver(([entry]) => { observer.disconnect(); resolve(entry.intersectionRect.height >= Math.min(36, entry.boundingClientRect.height * 0.95)); });
    observer.observe(element);
  })), true, "The reply intersects the conversation behind the modal sheet");
  const pendingReply = id => host.snapshot.assistantMail.attention.some(item => item.kind === "reply" && item.id === `${sessionId}:${id}-reply`);
  assert.equal(pendingReply("covered"), true, "The open original-mail sheet prevents the covered reply from being acknowledged");
  await dismiss();
  await eventually(() => pendingReply("covered"), false, "Closing the sheet acknowledges the newly visible reply");
  await page.getByRole("button", { name: "收件", exact: true }).click();
  const longText = Array.from({ length: 14 }, (_, index) => `${index + 1}、${"这是一段用于核对显示高度的文字。".repeat(6)}`).join("\n\n");
  await deliverReply("long", longText);
  await eventually(() => pendingReply("long"), true, "A long reply arriving in the inbox remains pending");
  const longReply = page.locator(".assistant-conversation [data-stream-key=long-reply]");
  await longReply.waitFor({ state: "attached" });
  assert.equal(await longReply.isVisible(), false, "The assistant transcript stays mounted but hidden");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await longReply.evaluate(element => element.scrollIntoView({ block: "center" }));
  assert.ok(await longReply.evaluate(element => element.getBoundingClientRect().height > innerHeight), "The whole long reply cannot fit in the viewport");
  await eventually(() => pendingReply("long"), false, "Reading a viewport of the long reply acknowledges it after returning to the conversation");
  await attention.getByText("需要处理", { exact: true }).waitFor();
  host.mailReadFailure = true;
  await attention.getByRole("button", { name: /需要处理/u }).click();
  await page.getByRole("dialog").getByRole("alert").getByText("隔离邮件原文读取失败").waitFor();
  await page.getByRole("button", { name: "标为已解决", exact: true }).click();
  host.mailReadFailure = false;
  await attention.getByText("需要处理", { exact: true }).waitFor({ state: "hidden" });
  await attention.getByRole("button", { name: /日程提醒/u }).click();
  await page.getByRole("button", { name: "已看", exact: true }).click();
  await attention.getByText("日程提醒", { exact: true }).waitFor({ state: "hidden" });
  await attention.getByRole("button", { name: /到期待办/u }).click();
  const complete = page.getByRole("checkbox", { name: `完成 ${todoTitle}` });
  await complete.waitFor();
  assert.equal(await complete.isChecked(), false, "Viewing the task never completes it");
  await complete.click();
  await eventually(() => complete.isChecked(), true, "The host commits completion before the checkbox updates");
  await attention.waitFor({ state: "hidden" });
  await back();
  await eventually(label, lit, "A pending proposal alone keeps the entry lit");
  const { proposalId, revision, payloadHash } = draft;
  await native.controllerRequest(desktopFixtureRequest({ method: "assistant.proposal.dismiss", params: { proposalId, revision, payloadHash } }), "desktop");
  await eventually(label, "助理", "Only resolving the final pending item extinguishes the entry");
  assert.equal(host.requests.some(request => request.method === "plugin.assistant-mail.attention.ack" && request.params.kind === "mail"), true);

  await openMobileSession(page);
  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  const configuration = page.locator(".modal-backdrop .session-configuration-dialog");
  await configuration.waitFor();
  await deliverReply("modal", "会话设置打开时收到的回复。");
  const modalReply = page.locator("[data-stream-key=modal-reply]");
  await modalReply.evaluate(element => element.scrollIntoView({ block: "center" }));
  assert.equal(await modalReply.evaluate(element => new Promise(resolve => {
    const observer = new IntersectionObserver(([entry]) => { observer.disconnect(); resolve(entry.isIntersecting); });
    observer.observe(element);
  })), true, "The reply intersects the transcript behind session configuration");
  assert.equal(pendingReply("modal"), true, "A non-Sheet modal also prevents acknowledgments");
  await dismiss();
  await eventually(() => pendingReply("modal"), false, "Closing session settings acknowledges the reply");
  await openMobileDrawer(page);

  for (const turn of ["keep", "discard"]) {
    const inputId = `rewind-${turn}-input`;
    for (const message of [
      { type: "user", uuid: inputId, message: { content: `Check ${turn}` } },
      { type: "assistant", uuid: `rewind-${turn}-uuid`, message: { id: `rewind-${turn}-reply`, content: [{ type: "text", text: `Checked ${turn}` }] } },
      { type: "result", uuid: `rewind-${turn}-result`, is_error: false, user_message_uuid: inputId },
    ]) await native.message({ timestamp: Date.now(), ...message });
  }
  const replyIds = () => host.snapshot.assistantMail.attention.filter(item => item.kind === "reply").map(item => item.id).sort();
  const bothReplies = [`${sessionId}:rewind-discard-reply`, `${sessionId}:rewind-keep-reply`];
  await eventually(replyIds, bothReplies, "Both unread replies are pending before rewind");
  const rewind = scope => native.controllerRequest(desktopFixtureRequest({ method: "session.rewind",
    params: { sessionId, messageId: "rewind-discard-input", scope } }), "desktop");
  await rewind("files");
  assert.deepEqual(replyIds(), bothReplies, "Files-only rewind keeps both replies");
  await rewind("conversation");
  await eventually(replyIds, [`${sessionId}:rewind-keep-reply`], "Conversation rewind clears only the discarded reply");
  steps.push("Mail, paginated Native replies, calendar events, due tasks and pending proposals update the attention dot. Replies behind sheets and discarded by rewind use their own visibility and removal rules.");
}
