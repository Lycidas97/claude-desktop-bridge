import assert from "node:assert/strict";
import { resolve } from "node:path";
import { sessionId } from "../config.mjs";
import { desktopFixtureRequest, eventually, openMobileDrawer } from "../helpers.mjs";
import { openDesktopAssistant } from "./assistant-mail.mjs";

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
  assert.deepEqual(host.snapshot.assistantMail.attention, []);
  await analyze(ads, "ignore", "marketing");
  assert.deepEqual(host.snapshot.assistantMail.attention, []);
  const worth = await deliver(1);
  assert.deepEqual(host.snapshot.assistantMail.attention, []);
  await analyze(worth, "read", "account");
  assert.equal(service.event(worth.mailRefId).analysis.category, "account");
  assert.equal(service.event(worth.mailRefId).analysis.attention, "read");
  await eventually(label, lit, "Classified mail lights the entry; routine marketing does not");
  assert.equal(await entry.locator(".desktop-nav-badge").count(), 0, "The new entry is a dot, not an unread count");
  await entry.click();
  await attention.locator("summary").click();
  await attention.getByText("值得看", { exact: true }).waitFor();
  assert.equal(await attention.locator("li").count(), 1, "Opening Assistant does not acknowledge a mail");
  await page.screenshot({ path: resolve(directory, "mobile-assistant-attention.png") });
  viewports.push({ page: "mobile-assistant-attention", ...page.viewportSize() });
  await attention.getByRole("button", { name: /值得看/u }).click();
  await page.locator(".assistant-attention-original").waitFor();
  await attention.waitFor({ state: "hidden" });
  await dismiss();
  await back();
  await eventually(label, "助理", "Reading the single message clears attention");

  service.setAutomaticDelivery(false);
  const action = await deliver(1);
  await eventually(label, lit, "With proactive delivery off, new mail lights immediately");
  await analyze(action, "action");
  const todoTitle = "核对并提交预算";
  agenda.saveTodo({ value: { title: todoTitle, remindAt: new Date(Date.now() - 1000).toISOString(), status: "pending" } });
  agenda.saveEvent({ value: { title: "团队同步", startAt: new Date(Date.now() + 60_000).toISOString(),
    endAt: new Date(Date.now() + 120_000).toISOString(), remindAt: new Date(Date.now() - 1000).toISOString(), allDay: false, timeZone: "UTC" } });
  const draft = (await native.draftProposal({ kind: "todo.create", sourceId: "local", value: { title: "提案核对", status: "pending" } })).result;
  const events = [];
  for (const message of [
    { type: "user", uuid: "attention-user-input", message: { content: "请给我一条最新回复" } },
    { type: "assistant", uuid: "attention-user-reply", message: { id: "attention-reply-item", content: [{ type: "text", text: "预算已更新，可查看最新版本。" }] } },
    { type: "result", uuid: "attention-user-result", is_error: false, user_message_uuid: "attention-user-input" },
  ]) events.push(...await native.message({ timestamp: Date.now(), ...message }));
  await host.syncNativeQueue({ events, history: await native.history(), session: native.session() });
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
  } finally { await desktop.close(); }

  await entry.click();
  await page.locator(".assistant-conversation [data-stream-key=attention-reply-item]").getByText("预算已更新，可查看最新版本。", { exact: true }).waitFor();
  assert.equal(host.snapshot.assistantMail.attention.some(item => item.kind === "reply"), true, "Opening the Assistant with the reply offscreen does not acknowledge it");
  await attention.locator("summary").click();
  await attention.getByRole("button", { name: /助理回复/u }).click();
  await eventually(() => host.snapshot.assistantMail.attention.some(item => item.kind === "reply"), false, "A visible reply is acknowledged individually");
  await attention.getByRole("button", { name: /需要处理/u }).click();
  await page.locator(".assistant-attention-original").waitFor();
  await dismiss();
  await attention.getByText("需要处理", { exact: true }).waitFor();
  await attention.getByRole("button", { name: /需要处理/u }).click();
  await page.getByRole("button", { name: "标为已解决", exact: true }).click();
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
  steps.push("Proactive mail screening, passive delivery, visible Native reply, read-only event, actionable mail, due task and independent pending proposal update the same attention dot on phone and desktop");
}
