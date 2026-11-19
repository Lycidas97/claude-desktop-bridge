import assert from "node:assert/strict";
import { resolve } from "node:path";
import { desktopFixtureRequest, eventually, openMobileDrawer } from "../helpers.mjs";
import { openDesktopAssistant } from "./assistant-mail.mjs";

const action = { kind: "calendar.create", sourceId: "local", value: {
  title: "项目评审", startAt: "2027-01-04T14:00:00.000Z", endAt: "2027-01-04T15:00:00.000Z", allDay: false, timeZone: "UTC",
} };
const detachedTitle = "整理评审纪要";
export const memoryProposalFixture = { kind: "memory.rule_upsert", category: "reporting", ruleId: "summary", operation: "add",
  text: "先列结论。", reason: "用户要求规则在重启后保留。" };
const window = { from: "2027-01-04T00:00:00.000Z", to: "2027-01-05T00:00:00.000Z" };

export async function seedAssistantProposals(host) {
  const native = host.nativeApproval;
  const inline = await native.draftProposal(action);
  const detached = await native.draftProposal({ kind: "todo.create", sourceId: "local", value: { title: detachedTitle, status: "pending" } });
  assert.equal(inline.source.authorizesActions, false);
  const toolUseId = "proposal-fixture-call";
  const events = [];
  for (const [type, content] of [
    ["assistant", [{ type: "tool_use", id: toolUseId, name: "mcp__assistant-mail__proposal_create", input: { action } }]],
    ["user", [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: JSON.stringify(inline) }] }]],
  ]) events.push(...await native.message({ type, uuid: `${toolUseId}-${type}`, timestamp: Date.now(), message: { content } }));
  await host.syncNativeQueue({ events, history: await native.history(), session: native.session() });
  return { inline: inline.result, detached: detached.result };
}

const mailSubject = "确认周一评审安排";
const mailTo = ["sender@example.test", "second@example.test"];
const mailCc = ["team@example.test", "archive@example.test"];

export async function seedMailProposal(host) {
  const native = host.nativeApproval;
  const original = await native.assistantMail.deliver(1, Buffer.from([
    "From: sender@example.test", "Reply-To: ops@outside.example.org", "Message-ID: <origin@example.test>", "",
    "请确认周一安排。",
  ].join("\r\n")));
  await native.controllerRequest(desktopFixtureRequest({ method: "plugin.assistant-mail.account.set-smtp", params: {
    accountKey: original.accountKey, smtp: { host: "smtp.example.test", port: 465, security: "tls", user: "fixture",
      from: "writer@example.test", credential: "for-test-only" },
  } }), "desktop");
  return (await native.draftProposal({ kind: "mail.reply", accountKey: original.accountKey, mailRefId: original.mailRefId,
    subject: mailSubject, to: mailTo, cc: mailCc, bodyText: "周一 14:00 开始评审。\n请带上最新议程。" })).result;
}

async function verifyMailMarkRead(phone, host, baseUrl, capture) {
  const desktop = await phone.context().newPage();
  desktop.setDefaultTimeout(15_000);
  await openDesktopAssistant(desktop, host, baseUrl, []);
  await openMobileDrawer(phone);
  const mobileBadge = phone.locator(".drawer-assistant-capsule");
  const mobileLabel = () => mobileBadge.getAttribute("aria-label");
  const desktopCount = () => desktop.locator(".sidebar-assistant-row .desktop-nav-badge").textContent();
  const publishDesktop = () => desktop.evaluate(assistantMail => window.assistantDesktopSnapshot({ assistantMail }), host.snapshot.assistantMail);
  const card = (page, { mailRefId }) => page.locator(`.assistant-mail-list [data-mail-id="${mailRefId}"]`);
  await mobileBadge.click();
  for (const page of [phone, desktop]) {
    await page.getByRole("button", { name: "收件", exact: true }).click();
    await page.getByText("暂无已记录邮件", { exact: true }).waitFor();
  }
  await openMobileDrawer(phone);
  const { deliver } = host.nativeApproval.assistantMail;
  const viewed = await deliver(1);
  const marked = await deliver(2);
  await publishDesktop();
  await eventually(mobileLabel, "助理，3 条未读", "Phone badges new arrivals above its baseline");
  await eventually(desktopCount, "3", "Desktop badges the same arrivals");

  await mobileBadge.click();
  await phone.getByRole("button", { name: "收件", exact: true }).click();
  await card(phone, viewed).getByText("原文", { exact: true }).click();
  await card(phone, viewed).locator("details[open] pre").waitFor();
  await openMobileDrawer(phone);
  await eventually(mobileLabel, "助理，2 条未读", "Opening an original marks it only on this phone");
  assert.equal(await desktopCount(), "3");

  const { result } = await host.nativeApproval.callAssistantTool("mail.mark_read", { mailRefIds: [marked.mailRefId] });
  assert.deepEqual(result, { changedCount: 1 });
  await publishDesktop();
  await eventually(mobileLabel, "助理，1 条未读", "Phone combines the host mark with its local view");
  await eventually(desktopCount, "2", "Desktop removes only the host-marked mail");
  await desktop.getByRole("button", { name: "刷新邮件列表", exact: true }).click();
  await desktop.getByRole("button", { name: "刷新邮件列表（已刷新）", exact: true }).waitFor();
  assert.equal(await desktopCount(), "2");
  await card(desktop, marked).getByText("待处理", { exact: true }).waitFor();
  await capture(desktop, "desktop-mail-host-read");

  await phone.reload({ waitUntil: "domcontentloaded" });
  await openMobileDrawer(phone);
  await eventually(mobileLabel, "助理，1 条未读", "Reconnecting preserves the combined unread count");
  await capture(phone, "mobile-mail-host-read");
  await mobileBadge.click();
  await phone.getByRole("button", { name: "收件", exact: true }).click();
  await card(phone, marked).getByText("待处理", { exact: true }).waitFor();
  await desktop.close();
}

export async function verifyAssistantProposals(page, host, steps, directory, viewports, baseUrl) {
  const capture = async (surface, name) => {
    await surface.screenshot({ path: resolve(directory, `${name}.png`) });
    viewports.push({ page: name, ...surface.viewportSize() });
  };
  await verifyMailMarkRead(page, host, baseUrl, capture);
  steps.push("Managed mail.mark_read reduces both badges, combines with phone-only views after reconnect, and leaves both business-status labels pending");
  const agenda = host.nativeApproval.assistantMail.agenda;
  const back = () => page.evaluate(async () => (await import("/src/lib/mobile-back-navigation.ts")).dispatchMobileBack());
  await openMobileDrawer(page);
  await page.locator(".drawer-assistant-capsule").click();
  await page.locator(".assistant-conversation textarea").fill("请在周一安排项目评审");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await eventually(() => host.nativeApproval.calls.some(call => call.method === "sendMessage" && JSON.stringify(call.args[1]).includes("安排项目评审")), true, "Chat reaches the bound Native session");
  const { inline, detached } = await seedAssistantProposals(host);
  const inlineCard = page.locator(`.conversation-stream [data-proposal-id="${inline.proposalId}"]`);
  await inlineCard.getByRole("heading", { name: action.value.title }).waitFor();
  assert.equal(await page.locator(`.conversation-stream [data-proposal-id="${detached.proposalId}"]`).count(), 0);
  assert.equal(agenda.listEvents(window).records.length, 0);
  assert.equal(agenda.listTodos({}).records.length, 0);
  await capture(page, "mobile-proposal-inline");

  await page.locator(".assistant-proposal-dock .permission-dock").getByText("2 项待你确认").click();
  const rows = page.locator(".proposal-list");
  await rows.getByRole("button", { name: new RegExp(detachedTitle, "u") }).waitFor();
  await capture(page, "mobile-proposal-pending");
  await rows.getByRole("button", { name: /项目评审/u }).click();
  const detail = page.getByRole("region", { name: "提案详情" });
  await detail.getByRole("button", { name: "调整", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "调整日程提案" });
  await editor.getByLabel("调期意见").waitFor();
  const bounds = await editor.boundingBox();
  assert.ok(bounds && bounds.width >= 373 && bounds.height >= 810, `Expected a full-screen mobile editor, got ${JSON.stringify(bounds)}`);
  await capture(page, "mobile-proposal-replan");
  assert.equal(await back(), true);
  await editor.waitFor({ state: "hidden" });
  await detail.waitFor();
  assert.equal(await back(), true);
  await rows.waitFor();
  assert.equal(await back(), true);
  await inlineCard.waitFor();
  await page.locator(".assistant-proposal-dock .permission-dock").click();
  await rows.getByRole("button", { name: /项目评审/u }).click();
  await detail.getByRole("button", { name: "调整", exact: true }).click();
  await editor.getByLabel("调期意见").fill("避开周一的例会");
  await editor.getByRole("button", { name: "让助理重排", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  const replan = host.nativeApproval.calls.findLast(call => call.method === "sendMessage");
  assert.equal(replan.args[0], host.session.sessionId);
  assert.match(JSON.stringify(replan.args[1]), /避开周一的例会/u);
  assert.ok(JSON.stringify(replan.args[1]).includes(inline.payloadHash));
  assert.equal(agenda.listEvents(window).records.length, 0);
  await detail.getByRole("button", { name: "调整", exact: true }).click();
  await editor.getByRole("button", { name: "手动编辑", exact: true }).click();
  await editor.getByLabel("标题", { exact: true }).fill("项目评审（已调整）");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await detail.getByText("版本 2", { exact: true }).waitFor();
  assert.equal(agenda.listEvents(window).records.length, 0);
  const stale = await host.nativeApproval.controllerRequest(desktopFixtureRequest({ method: "assistant.proposal.commit", params: inline }), "desktop").catch(error => error);
  assert.equal(stale.code, "CONFLICT");
  assert.equal(agenda.listEvents(window).records.length, 0);
  await detail.getByRole("button", { name: "确认写入", exact: true }).click();
  await detail.getByRole("status").filter({ hasText: "已写入" }).waitFor();
  assert.deepEqual(agenda.listEvents(window).records.map(record => record.title), ["项目评审（已调整）"]);
  const commit = host.requests.find(request => request.method === "assistant.proposal.commit");
  assert.equal(commit.params.revision, 2);
  assert.notEqual(commit.params.payloadHash, inline.payloadHash);
  await assert.rejects(host.nativeApproval.controllerRequest({ ...commit, requestId: "fixture-duplicate" }, "desktop"), { code: "CONFLICT" });
  steps.push("Native tool receipts associate one draft inline; only paired confirmation of the edited revision writes the calendar once");

  for (let index = 0; index < 32; index++) {
    await host.nativeApproval.message({ type: "assistant", uuid: `proposal-scroll-${index}`, timestamp: Date.now() + index,
      message: { content: [{ type: "text", text: `项目评审记录 ${index}` }] } });
  }
  const rule = await host.nativeApproval.draftProposal(memoryProposalFixture);
  assert.ok(!(await host.nativeApproval.readFixtureProfile()).includes(memoryProposalFixture.text));
  const legacyRequest = (method, params) => host.nativeApproval.controllerRequest(desktopFixtureRequest({ method, params }), "mobile");
  assert.deepEqual((await legacyRequest("assistant.proposal.list", {})).proposals.map(proposal => proposal.proposalId), [detached.proposalId]);
  assert.deepEqual((await legacyRequest("assistant.proposal.list", { includeMail: true })).proposals.map(proposal => proposal.proposalId), [detached.proposalId]);
  assert.deepEqual((await legacyRequest("assistant.proposal.resolve", { sessionId: host.session.sessionId, refs: [rule.result] })).proposals, []);
  assert.equal(host.snapshot.assistantProposals.pendingCount, 1);
  assert.equal(host.snapshot.assistantProposals.pendingMemoryCount, 1);
  await assert.rejects(legacyRequest("assistant.proposal.commit", rule.result), { code: "INVALID_PARAMS" });
  await assert.rejects(legacyRequest("assistant.proposal.dismiss", rule.result), { code: "NOT_FOUND" });
  await assert.rejects(legacyRequest("assistant.proposal.replan", { ...rule.result, feedback: "adjust" }), { code: "UNSUPPORTED" });
  assert.ok(!(await host.nativeApproval.readFixtureProfile()).includes(memoryProposalFixture.text));
  const mail = await seedMailProposal(host);
  const desktop = await page.context().newPage();
  desktop.setDefaultTimeout(15_000);
  const desktopRequests = [];
  let releaseResolve;
  host.proposalResolveGate = new Promise(resolveGate => { releaseResolve = resolveGate; });
  await openDesktopAssistant(desktop, host, baseUrl, desktopRequests);
  const anchor = desktop.locator('.conversation-stream > [data-stream-key="proposal-scroll-12"]');
  await anchor.waitFor({ state: "attached" });
  const offset = await anchor.evaluate(element => {
    const stream = element.parentElement;
    stream.scrollTop += element.getBoundingClientRect().top - stream.getBoundingClientRect().top - 12;
    stream.dispatchEvent(new Event("scroll"));
    return element.getBoundingClientRect().top - stream.getBoundingClientRect().top;
  });
  assert.ok(Math.abs(offset - 12) <= 1);
  releaseResolve();
  host.proposalResolveGate = undefined;
  await desktop.locator(`.conversation-stream [data-stream-key="proposal:${inline.proposalId}"]`).getByText("已写入", { exact: true }).waitFor({ state: "attached" });
  const after = await anchor.evaluate(element => element.getBoundingClientRect().top - element.parentElement.getBoundingClientRect().top);
  assert.ok(Math.abs(after - offset) <= 4, `Late proposal shifted the visible anchor from ${offset} to ${after}`);
  steps.push("A delayed proposal card above the current reading position preserves the visible anchor");
  await desktop.locator(".conversation-stream").getByText("避开周一的例会", { exact: true }).waitFor();
  assert.ok(!(await desktop.locator(".conversation-stream").innerText()).includes(inline.payloadHash));
  assert.ok(!(await desktop.locator(".conversation-stream").innerText()).includes(inline.proposalId));
  await capture(desktop, "desktop-proposal-inline");
  await desktop.getByRole("button", { name: "待确认提案", exact: true }).click();
  await desktop.locator(".proposal-list").getByRole("button", { name: new RegExp(detachedTitle, "u") }).click();
  await page.locator(".assistant-page-mobile").getByRole("button", { name: "返回", exact: true }).click();
  await rows.getByRole("button", { name: new RegExp(detachedTitle, "u") }).click();
  await detail.getByRole("button", { name: "调整", exact: true }).click();
  const todoEditor = page.getByRole("dialog", { name: "调整待办提案" });
  await todoEditor.getByRole("button", { name: "手动编辑", exact: true }).click();
  await desktop.getByRole("region", { name: "提案详情" }).getByRole("button", { name: "调整", exact: true }).click();
  const desktopEditor = desktop.locator(".proposal-inline-editor");
  await desktopEditor.getByRole("button", { name: "手动编辑", exact: true }).click();
  const revisedTitle = `${detachedTitle}（含行动项）`;
  await desktopEditor.getByLabel("标题", { exact: true }).fill(revisedTitle);
  await desktopEditor.getByRole("button", { name: "保存修改", exact: true }).click();
  await todoEditor.getByText("提案已更新。关闭后重新核对。", { exact: true }).waitFor();
  assert.equal(await todoEditor.getByRole("button", { name: "保存修改", exact: true }).isEnabled(), false);
  await todoEditor.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await detail.getByRole("button", { name: "确认写入", exact: true }).isEnabled(), false);
  assert.equal(agenda.listTodos({}).records.length, 0);
  await desktop.getByRole("button", { name: "确认写入", exact: true }).click();
  await desktop.getByRole("region", { name: "提案详情" }).getByText("已写入", { exact: true }).waitFor();
  assert.deepEqual(agenda.listTodos({}).records.map(record => record.title), [revisedTitle]);
  const desktopCommit = desktopRequests.find(request => request.method === "assistant.proposal.commit");
  assert.equal(desktopCommit.params.proposalId, detached.proposalId);
  assert.equal(desktopCommit.params.revision, 2);
  assert.notEqual(desktopCommit.params.payloadHash, detached.payloadHash);
  await capture(desktop, "desktop-proposal-applied");
  steps.push("Desktop shares the inline receipt and confirms a pending-only task using trusted local IPC");

  await desktop.getByRole("button", { name: "返回列表", exact: true }).click();
  const ruleList = desktop.locator(".proposal-list");
  await ruleList.getByRole("button", { name: /reporting \/ summary/u }).click();
  const ruleDetail = desktop.getByRole("region", { name: "提案详情" });
  await ruleDetail.getByRole("button", { name: "确认保存规则" }).click();
  await ruleDetail.getByText("已写入", { exact: true }).waitFor();
  assert.ok((await host.nativeApproval.readFixtureProfile()).includes(memoryProposalFixture.text));
  const ruleCommit = desktopRequests.find(request => request.method === "assistant.proposal.commit" && request.params.proposalId === rule.result.proposalId);
  assert.equal(ruleCommit.params.payloadHash, rule.result.payloadHash);
  assert.equal(ruleCommit.params.confirmMemory, true);

  await host.nativeApproval.draftProposal({ ...memoryProposalFixture, operation: "update", text: "先列结论，再用三条以内的要点说明。" });
  await page.locator(".assistant-page-mobile").getByRole("button", { name: "返回", exact: true }).click();
  await rows.getByRole("button", { name: /reporting \/ summary/u }).click();
  await detail.getByText("先列结论。", { exact: true }).waitFor();
  await detail.getByText("先列结论，再用三条以内的要点说明。", { exact: true }).waitFor();
  await capture(page, "mobile-profile-rule-diff");
  await detail.getByRole("button", { name: "确认保存规则" }).click();
  await detail.getByText("已写入", { exact: true }).waitFor();
  assert.ok(host.requests.some(request => request.method === "assistant.proposal.commit" && request.params.confirmMemory === true));
  assert.ok((await host.nativeApproval.readFixtureProfile()).includes("先列结论，再用三条以内的要点说明。"));
  steps.push("Desktop and paired phone confirm a frozen rule diff; the isolated PROFILE.md changes only after approval");
  const { smtp } = host.nativeApproval.assistantMail;
  const { attempts } = smtp;
  const mailRequest = (method, params) => host.nativeApproval.controllerRequest(desktopFixtureRequest({ method, params }), "desktop");
  assert.deepEqual((await mailRequest("assistant.proposal.list", {})).proposals, []);
  await assert.rejects(mailRequest("assistant.proposal.commit", mail), { code: "INVALID_PARAMS" });
  await page.locator(".assistant-page-mobile").getByRole("button", { name: "返回", exact: true }).click();
  await rows.getByRole("button", { name: new RegExp(mailSubject, "u") }).click();
  const commitsBeforeReview = host.requests.filter(request => request.method === "assistant.proposal.commit").length;
  await detail.getByRole("button", { name: "核对并发送…" }).click();
  const sheet = page.getByRole("dialog", { name: "核对并发送" });
  const verifyMailSheet = async (drawer, subject, to, body) => {
    assert.equal(await drawer.evaluate(element => element.classList.contains("m-sheet")), true);
    await drawer.getByRole("heading", { name: subject }).waitFor();
    await drawer.getByText(body, { exact: false }).waitFor();
    const fields = await drawer.locator(".mail-proposal-sheet > dl dd").allTextContents();
    assert.equal(fields[1], "writer@example.test");
    assert.deepEqual(fields[3].split("\n"), to);
    assert.deepEqual(fields[4].split("\n"), mailCc);
    await drawer.getByText("原信的 Reply-To 来自不同域名").waitFor();
    assert.equal(await drawer.locator("[data-foreign='true']").getByText("ops@outside.example.org").count(), 1);
  };
  await verifyMailSheet(sheet, mailSubject, mailTo, "周一 14:00 开始评审。");
  await capture(page, "mobile-mail-confirmation");
  assert.equal(host.requests.filter(request => request.method === "assistant.proposal.commit").length, commitsBeforeReview);
  assert.equal(attempts.length, 0);

  await desktop.getByRole("button", { name: "返回列表" }).click();
  await desktop.locator(".proposal-list").getByRole("button", { name: new RegExp(mailSubject, "u") }).click();
  const mailDetail = desktop.getByRole("region", { name: "提案详情" });
  await mailDetail.getByRole("button", { name: "编辑", exact: true }).click();
  const mailEdit = desktop.getByRole("dialog", { name: "编辑邮件提案" });
  const finalSubject = `${mailSubject}（更新）`;
  const finalTo = [...mailTo, "new@example.net"];
  const finalBody = "周一 15:00 开始评审。";
  await mailEdit.getByLabel("收件人 (To)").fill(finalTo.join("\n"));
  await mailEdit.getByLabel("主题", { exact: true }).fill(finalSubject);
  await mailEdit.getByLabel("正文", { exact: true }).fill(finalBody);
  await mailEdit.getByRole("button", { name: "保存新版本" }).click();
  await sheet.getByText("提案已更新或处理。关闭后重新核对。").waitFor();
  assert.equal(await sheet.getByRole("button", { name: "确认立即发出" }).isEnabled(), false);
  await assert.rejects(mailRequest("assistant.proposal.commit", { ...mail, confirmMail: true }), { code: "CONFLICT" });
  assert.equal(attempts.length, 0);
  await sheet.getByRole("button", { name: "取消", exact: true }).click();
  await mailDetail.getByRole("button", { name: "核对并发送…" }).click();
  const desktopSheet = desktop.getByRole("dialog", { name: "核对并发送" });
  await verifyMailSheet(desktopSheet, finalSubject, finalTo, finalBody);
  await capture(desktop, "desktop-mail-confirmation");
  assert.equal(attempts.length, 0);
  await desktopSheet.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator(".assistant-page-mobile").getByRole("button", { name: "返回", exact: true }).click();
  await rows.getByRole("button", { name: /^确认周一评审安排（更新）/u }).click();
  await detail.getByRole("button", { name: "核对并发送…" }).click();
  const smtpResult = Promise.withResolvers();
  smtp.resultGate = smtpResult.promise;
  try {
    await page.clock.install();
    await sheet.getByRole("button", { name: "确认立即发出" }).click();
    await detail.locator('[data-state="executing"]').waitFor({ state: "attached" });
    await page.clock.fastForward(20_001);
    assert.equal(await sheet.getByText("电脑响应超时", { exact: true }).count(), 0, "SMTP wait must not time out the approval RPC");
    await sheet.waitFor({ state: "hidden" });
    await detail.getByText("正在发送…", { exact: true }).waitFor();
  } finally { smtpResult.resolve(); }
  await detail.getByText("发送服务器已接受").waitFor();
  await detail.getByRole("button", { name: "查看邮件版本" }).click();
  const approvalRecord = page.getByRole("dialog", { name: "邮件提案记录" });
  await verifyMailSheet(approvalRecord, finalSubject, finalTo, finalBody);
  assert.equal(await approvalRecord.getByRole("button", { name: "确认立即发出" }).count(), 0);
  await approvalRecord.getByRole("button", { name: "关闭" }).click();
  const mailCommit = host.requests.find(request => request.method === "assistant.proposal.commit" && request.params.proposalId === mail.proposalId);
  assert.equal(mailCommit.params.revision, 2);
  assert.equal(mailCommit.params.confirmMail, true);
  assert.notEqual(mailCommit.params.payloadHash, mail.payloadHash);
  await assert.rejects(mailRequest("assistant.proposal.commit", mailCommit.params), { code: "CONFLICT" });
  assert.deepEqual(attempts.map(({ from, to, cc, subject, bodyText }) => ({ from, to, cc, subject, bodyText })),
    [{ from: "writer@example.test", to: finalTo, cc: mailCc, subject: finalSubject, bodyText: finalBody }]);
  steps.push("Mail confirmation displays the pinned envelope, rejects a stale confirmation, and keeps its in-flight state until one send finishes");
  await desktop.getByRole("button", { name: "助理设置", exact: true }).click();
  await desktop.locator(".assistant-account-actions").getByRole("button", { name: /^SMTP 已配置：/u }).click();
  const smtpForm = desktop.getByRole("group", { name: /的发信设置/u });
  const port = smtpForm.getByLabel("端口", { exact: true });
  const security = smtpForm.getByLabel("加密方式");
  assert.equal(await port.inputValue(), "465");
  await security.selectOption("starttls");
  assert.equal(await port.inputValue(), "587");
  await port.fill("2525");
  await security.selectOption("tls");
  assert.equal(await port.inputValue(), "2525");
  steps.push("SMTP switches to the conventional STARTTLS port without overwriting a custom port");
  await desktop.close();
}
