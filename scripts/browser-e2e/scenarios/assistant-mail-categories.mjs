import assert from "node:assert/strict";
import { resolve } from "node:path";
import { expandInboxMail, fileMailInCategory, openDesktopAssistant } from "./assistant-mail.mjs";
import { eventually } from "../helpers.mjs";

export async function verifyAssistantMailCategories(page, host, steps, directory, viewports, baseUrl) {
  const { service } = host.nativeApproval.assistantMail;
  const [{ mailRefId }, secondMail] = service.page({ limit: 2 }).events;
  service.setBinding({ assistantId: "category-fixture", nativeSessionId: host.session.sessionId, sectionId: null, previousSessionIds: [] });
  await eventually(() => host.snapshot.assistantMail.binding?.nativeSessionId, host.session.sessionId, "Both clients use the same bound fixture conversation");
  const card = scope => scope.locator(`[data-mail-id="${mailRefId}"]`);
  const manage = surface => surface.getByRole("button", { name: "管理分类" });
  const edit = (surface, label) => surface.getByRole("button", { name: `编辑分类「${label}」` });
  const group = (surface, label) => surface.locator(".assistant-mail-group").filter({ has: surface.getByText(label, { exact: true }) });

  await page.getByRole("button", { name: /^助理(?:，.*)?$/u }).click();
  await page.getByRole("button", { name: "收件", exact: true }).click();
  const filed = page.getByRole("button", { name: /^已收纳/u });
  await filed.click();
  assert.equal(await manage(page).count(), 1, "Filed mail offers category management even with no filed messages");
  await manage(page).click();
  await page.getByRole("button", { name: "新建分类", exact: true }).click();
  await page.getByRole("textbox", { name: "分类名称" }).fill("订单");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await edit(page, "订单").waitFor();
  await edit(page, "营销与垃圾邮件").click();
  assert.equal(await page.getByRole("button", { name: "删除分类" }).count(), 0);
  await page.getByRole("button", { name: "返回分类" }).click();
  await page.getByRole("dialog", { name: "管理分类" }).getByRole("button", { name: "关闭" }).click();
  await eventually(() => manage(page).evaluate(node => node === document.activeElement), true, "Closing management restores focus to its opener");
  await page.getByRole("button", { name: "返回收件" }).click();
  assert.equal(await manage(page).count(), 0, "The inbox does not embed category management");
  await fileMailInCategory(page, card(page.locator('[aria-label="邮件输入"]')), "订单");
  await page.getByRole("button", { name: "已收纳 1 封" }).click();
  await group(page, "订单").locator("summary").click();
  await card(group(page, "订单")).waitFor();

  const desktop = await page.context().newPage();
  try {
    const desktopRequests = [];
    await openDesktopAssistant(desktop, host, baseUrl, desktopRequests);
    await desktop.getByRole("button", { name: "收件", exact: true }).click();
    await desktop.getByRole("button", { name: "已收纳 1 封" }).click();
    await manage(desktop).click();
    await edit(desktop, "订单").click();
    await desktop.getByRole("textbox", { name: "分类名称" }).fill("采购记录");
    await desktop.getByRole("button", { name: "保存", exact: true }).click();
    await edit(desktop, "采购记录").waitFor();
    await desktop.screenshot({ path: resolve(directory, "desktop-mail-categories.png") });
    viewports.push({ page: "desktop-mail-categories", ...desktop.viewportSize() });
  } finally {
    await desktop.close();
  }
  await card(group(page, "采购记录")).waitFor();
  await page.getByRole("button", { name: "返回收件" }).click();
  await page.getByRole("searchbox", { name: "搜索邮件" }).fill(service.event(mailRefId).subject);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const found = await expandInboxMail(card(page.getByLabel("搜索结果")));
  await found.getByText("采购记录", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清除搜索" }).click();
  await fileMailInCategory(page, page.locator(`[aria-label="邮件输入"] [data-mail-id="${secondMail.mailRefId}"]`), "采购记录");

  await page.getByRole("button", { name: "已收纳 2 封" }).click();
  await manage(page).click();
  await edit(page, "采购记录").click();
  const longLabel = "W".repeat(60);
  await page.getByRole("textbox", { name: "分类名称" }).fill(longLabel);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await edit(page, longLabel).waitFor();
  const closeManager = page.getByRole("dialog", { name: "管理分类" }).getByRole("button", { name: "关闭" });
  await closeManager.click();
  const collapse = page.getByRole("button", { name: `收起「${longLabel}」` });
  const collapseOverflow = await collapse.evaluate(button => Math.max(0, button.scrollWidth - button.clientWidth,
    Math.ceil(button.getBoundingClientRect().right - window.innerWidth)));
  await manage(page).click();
  await edit(page, longLabel).click();
  await page.getByRole("button", { name: "删除分类" }).click();
  const confirm = page.getByRole("alertdialog", { name: `删除「${longLabel}」？` });
  await confirm.getByText("分类里的邮件会移回收件箱，原信不会删除。", { exact: true }).waitFor();
  const titleOverflow = await confirm.getByRole("heading").evaluate(title => title.scrollWidth - title.clientWidth);
  assert.deepEqual({ titleOverflow, collapseOverflow }, { titleOverflow: 0, collapseOverflow: 0 },
    "A maximum-length category name fits in the mobile confirmation and collapse button");
  await page.screenshot({ path: resolve(directory, "mobile-mail-category-delete.png") });
  viewports.push({ page: "mobile-mail-category-delete", ...page.viewportSize() });
  await confirm.getByRole("button", { name: "删除分类" }).click();
  await closeManager.click();
  await group(page, longLabel).waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 0);
  await page.getByRole("button", { name: "返回收件" }).click();
  await page.getByRole("button", { name: "已收纳 0 封" }).waitFor();
  const restored = await expandInboxMail(card(page.getByLabel("邮件输入")));
  await restored.getByText("原文", { exact: true }).click();
  await restored.locator("details[open] pre").waitFor();

  const start = host.requests.length;
  host.snapshot.host.capabilities = host.snapshot.host.capabilities.filter(value => value !== "plugin.assistant-mail.categories.v1");
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await eventually(() => host.requests.slice(start).some(request => request.method === "plugin.assistant-mail.list" && !("includeCustomCategories" in request.params)),
    true, "An older host receives no custom-category parameter");
  await filed.click();
  assert.equal(await manage(page).count(), 0);
  steps.push("mobile adds and files into a category, desktop renames it in place, mobile search sees the rename, and deleting it returns the original to the inbox; older hosts show no management action");
}
