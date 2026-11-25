import assert from "node:assert/strict";
import { basename, resolve } from "node:path";
import { desktopFixtureRequest, eventually, syncNativeSections } from "../helpers.mjs";
import { openDesktopAssistant, openMobileAssistant } from "../assistant-helpers.mjs";

const targetId = "local_fixture_review_session";
const targetTitle = "项目评审会话";
const oldText = "请查看第一版。";
const message = "  请核对 @fixture-notes。\n\n原样保留 <标记> 与缩进。  ";

export async function seedAssistantSessionProposals(host) {
  const native = host.nativeApproval;
  await native.seedSessions([{ sessionId: targetId, title: targetTitle, turnRunning: true, permissionMode: "default", lastActivityAt: Date.now() }]);
  const catalog = await native.sectionCatalog();
  const target = catalog.sessions.find(session => session.sessionId === targetId);
  host.snapshot.sessions.push(target);
  for (const project of catalog.projects.filter(project => project.projectId === target.projectId)) {
    if (!host.snapshot.projects.some(current => current.projectId === project.projectId)) host.snapshot.projects.push(project);
  }
  const send = { kind: "session.send", targetSessionId: targetId, text: oldText };
  const draft = await native.draftProposal(send);
  const open = await native.draftProposal({ kind: "session.open", targetSessionId: targetId });
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  assert.equal(draft.source.authorizesActions, false);
  return { send, draft: draft.result, open: open.result };
}

const createdTitle = "新建隔离评审会话";
const sectionName = "评审分组";
const modelName = "隔离模型 · 长上下文";
const firstText = "  请检查这份方案。\n\n原样保留 <标记>。  ";

export async function seedAssistantSessionCreation(host) {
  const native = host.nativeApproval;
  const { project } = await native.controllerRequest(desktopFixtureRequest({ method: "section.create", params: { name: sectionName } }), "desktop");
  const directory = (await native.sectionCatalog()).sessions.find(session => session.sessionId === targetId).cwd;
  const options = async query => (await native.callAssistantTool("proposal.session_create_options", query)).result.options;
  assert.deepEqual(await options({ field: "cwd", name: basename(directory) }), [{ value: directory, label: basename(directory) }]);
  assert.ok((await options({ field: "project" })).some(option => option.value === project.projectId && option.label === sectionName));
  const { value: model } = (await options({ field: "model" })).find(option => option.label === modelName);
  const action = { kind: "session.create", cwd: directory, projectId: project.projectId, model, text: firstText };
  const { result: ref } = await native.draftProposal(action);
  return { ref, action };
}

export async function verifyAssistantSessionProposals(phone, host, steps, directory, viewports, baseUrl) {
  const native = host.nativeApproval;
  const { send, draft, open } = await seedAssistantSessionProposals(host);
  const targetSends = () => native.calls.filter(call => call.method === "sendMessage" && call.args[0] === targetId);
  const request = (method, params, idempotencyKey) => native.controllerRequest(desktopFixtureRequest({ method, params, idempotencyKey }), "desktop");
  const capture = async (page, name) => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: resolve(directory, `${name}.png`) });
    viewports.push({ page: name, ...page.viewportSize() });
  };
  await phone.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  await phone.getByRole("button", { name: `会话操作：${targetTitle}` }).click();
  const menu = phone.getByRole("dialog", { name: targetTitle });
  await menu.getByRole("button", { name: "复制会话 ID" }).click();
  await menu.getByRole("button", { name: "已复制" }).waitFor();
  assert.equal(await phone.evaluate(() => navigator.clipboard.readText()), targetId);
  await menu.getByRole("button", { name: "关闭", exact: true }).click();
  await openMobileAssistant(phone);
  await phone.locator(".assistant-proposal-dock .permission-dock").getByText("2 项待你确认").click();
  const phoneRows = phone.locator(".proposal-list");
  await phoneRows.getByRole("button", { name: /发送会话消息/u }).click();
  await phone.getByRole("button", { name: "核对会话消息…" }).click();
  const review = phone.getByRole("dialog", { name: "核对会话消息" });
  await review.getByText(oldText, { exact: true }).waitFor();
  assert.equal(targetSends().length, 0);
  assert.deepEqual((await request("assistant.proposal.list", { includeMail: true, includeMemory: true })).proposals, []);
  await assert.rejects(request("assistant.proposal.commit", draft), { code: "INVALID_PARAMS" });

  const revised = (await native.callAssistantTool("proposal.update_pending", { ...draft, action: { ...send, text: message } })).result;
  await review.getByText("提案已更新或处理。关闭后重新核对。", { exact: true }).waitFor();
  assert.equal(await review.getByRole("button", { name: "确认发送消息" }).isEnabled(), false);
  await assert.rejects(request("assistant.proposal.commit", { ...draft, confirmSession: true }), { code: "CONFLICT" });
  assert.equal(targetSends().length, 0);
  await review.getByRole("button", { name: "取消", exact: true }).click();
  await phone.locator(".assistant-page-mobile").getByRole("button", { name: "返回", exact: true }).click();
  await phoneRows.getByRole("button", { name: /打开会话/u }).click();
  await phone.getByRole("button", { name: "核对目标会话…" }).click();
  const openReview = phone.getByRole("dialog", { name: "核对目标会话" });
  await openReview.getByText(targetId, { exact: true }).waitFor();
  await capture(phone, "mobile-session-open-review");
  await openReview.getByRole("button", { name: "确认打开会话" }).click();
  await eventually(() => host.requests.some(request => request.method === "session.open" && request.params.sessionId === targetId), true, "Client opens the approved existing session normally");
  assert.equal(targetSends().length, 0);
  assert.equal(native.calls.filter(call => call.method === "start").length, 0);
  const openCommit = host.requests.find(request => request.method === "assistant.proposal.commit" && request.params.proposalId === open.proposalId);
  assert.equal(openCommit.params.confirmSession, true);

  const desktop = await phone.context().newPage();
  desktop.setDefaultTimeout(15_000);
  const desktopRequests = [];
  await openDesktopAssistant(desktop, host, baseUrl, desktopRequests);
  await desktop.getByRole("button", { name: "待确认提案", exact: true }).click();
  await desktop.locator(".proposal-list").getByRole("button", { name: /发送会话消息/u }).click();
  await desktop.getByRole("button", { name: "核对会话消息…" }).click();
  const desktopReview = desktop.getByRole("dialog", { name: "核对会话消息" });
  await desktopReview.getByText(targetTitle, { exact: true }).waitFor();
  await desktopReview.getByText(targetId, { exact: true }).waitFor();
  assert.equal(await desktopReview.locator('pre[aria-label="完整消息正文"]').textContent(), message);
  await capture(desktop, "desktop-session-send-review");
  assert.equal(targetSends().length, 0);
  await desktopReview.getByRole("button", { name: "确认发送消息" }).click();
  await desktopReview.waitFor({ state: "hidden" });
  await eventually(() => native.receipts().find(receipt => receipt.sessionId === targetId)?.state, "queued", "Native queues the exact approved message");
  assert.equal(targetSends().length, 1);
  assert.equal(targetSends()[0].args[1], message);
  assert.equal(targetSends()[0].args[2], undefined);
  assert.equal(native.calls.filter(call => call.method === "setPermissionMode" && call.args[0] === targetId).length, 0);
  const commit = desktopRequests.find(request => request.method === "assistant.proposal.commit");
  assert.deepEqual(commit.params, { ...revised, confirmSession: true });
  await assert.rejects(request("assistant.proposal.commit", commit.params), { code: "CONFLICT" });
  const receipt = native.receipts().find(receipt => receipt.sessionId === targetId);
  assert.equal(receipt.source, "assistant-proposal");
  await assert.rejects(request("turn.start", { sessionId: targetId, text: "Replay" }, receipt.idempotencyKey), { code: "INVALID_PARAMS" });
  const resolveProposal = () => request("assistant.proposal.resolve", { sessionId: host.session.sessionId, refs: [revised], includeSession: true });
  // Native persisted the input while Bridge missed its live events.
  const beforeHistory = host.events.length;
  native.appendHistory([{ type: "user", uuid: receipt.messageId, message: { content: message } }]);
  const { history } = await request("session.open", { sessionId: targetId });
  const accepted = history.items.find(item => item.id === receipt.messageId);
  assert.equal(accepted?.text, message.trimEnd());
  assert.equal(accepted.delivery, "session-received");
  assert.equal((await resolveProposal()).proposals[0].sessionDelivery, "session-received");
  assert.ok(host.events.slice(beforeHistory).some(event => event.type === "assistant.proposal.changed"));
  assert.equal(targetSends().length, 1);
  await native.advanceAssistantTrigger(targetId, receipt.messageId, "completed");
  assert.equal((await resolveProposal()).proposals[0].sessionDelivery, "completed");
  await desktop.getByRole("button", { name: "返回列表", exact: true }).click();
  await desktop.getByRole("button", { name: "处理记录", exact: true }).click();
  await desktop.locator(".proposal-list").getByRole("button", { name: /发送会话消息.*目标会话已完成此轮/u }).click();
  const viewMessage = desktop.getByRole("button", { name: "查看消息原文" });
  assert.equal(await viewMessage.isVisible(), true, "The processed proposal keeps its approved text available");
  await viewMessage.click();
  const record = desktop.getByRole("dialog", { name: "会话消息原文" });
  assert.equal(await record.locator('pre[aria-label="完整消息正文"]').textContent(), message);
  assert.equal(await record.getByRole("button", { name: "确认发送消息" }).count(), 0);
  await record.getByRole("button", { name: "复制消息原文" }).click();
  await record.getByRole("button", { name: "已复制" }).waitFor();
  assert.equal(await desktop.evaluate(() => navigator.clipboard.readText()), message);
  await capture(desktop, "desktop-session-send-record");
  await record.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(desktopRequests.filter(request => request.method === "assistant.proposal.commit").length, 1);
  assert.equal(targetSends().length, 1);
  const ignored = (await native.draftProposal({ ...send, text: "This message must not be sent." })).result;
  await openMobileAssistant(phone);
  await phone.locator(".assistant-proposal-dock .permission-dock").getByText("1 项待你确认").click();
  await phoneRows.getByRole("button", { name: /发送会话消息/u }).click();
  await phone.getByRole("button", { name: "忽略", exact: true }).click();
  await phone.getByRole("status").filter({ hasText: "已忽略" }).waitFor();
  await assert.rejects(request("assistant.proposal.commit", { ...ignored, confirmSession: true }), { code: "CONFLICT" });
  assert.equal(targetSends().length, 1);
  steps.push("Copy Session ID works; ignored, old confirmation and replay are rejected; paired phone opens by session.open without sending, and desktop sends only the full revised message to the busy Native target");

  const { ref: untitled, action } = await seedAssistantSessionCreation(host);
  const { cwd, model, projectId } = action;
  await phone.locator(".assistant-page-mobile").getByRole("button", { name: "返回", exact: true }).click();
  await phoneRows.getByRole("button", { name: `${cwd} 新建会话`, exact: true }).waitFor();
  const { result: ref } = await native.callAssistantTool("proposal.update_pending", { ...untitled, action: { ...action, title: createdTitle } });
  const { project: twin } = await request("section.create", { name: "另一评审分组" });
  await request("section.rename", { sectionId: twin.projectId, name: sectionName });
  await native.draftProposal({ ...action, projectId: twin.projectId, title: "同名分组的提案" });
  await syncNativeSections(host);
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await desktop.evaluate(({ projects, sessions, host: computer }) => window.assistantDesktopSnapshot({ projects, sessions, host: computer }), host.snapshot);
  await phone.reload({ waitUntil: "domcontentloaded" });
  for (const [surface, page, catalog] of [["mobile", phone, ".mobile-home-catalog"], ["desktop", desktop, ".desktop-session-sidebar"]]) {
    const manage = { name: `管理分组：${sectionName}`, exact: true };
    const groups = page.locator(`${catalog} .project-group-header`).filter({ has: page.getByRole("button", manage) });
    await groups.nth(1).waitFor();
    const ids = [];
    for (const group of await groups.all()) {
      if (surface === "desktop") await group.hover();
      await group.getByRole("button", manage).click();
      const menu = page.getByRole("dialog", { name: sectionName, exact: true });
      await menu.waitFor();
      const id = menu.locator("bdi:visible");
      assert.equal(await id.count(), 1, `${surface} group menu exposes the ID shown on its proposal`);
      ids.push(await id.innerText());
      await capture(page, `${surface}-same-section-menu-${ids.length}`);
      await menu.getByRole("button", { name: "关闭", exact: true }).click();
    }
    assert.deepEqual(ids.sort(), [projectId, twin.projectId].sort());
  }
  await desktop.close();
  await openMobileAssistant(phone);
  await phone.locator(".assistant-proposal-dock .permission-dock").getByText("2 项待你确认").click();
  const createReview = phone.getByRole("dialog", { name: "核对新会话" });
  const section = createReview.locator("dt").filter({ hasText: /^分组$/u }).locator("+ dd");
  await phoneRows.getByRole("button", { name: "同名分组的提案 新建会话", exact: true }).click();
  await phone.getByRole("button", { name: "核对新会话…" }).click();
  const twinSection = await section.innerText();
  await capture(phone, "mobile-session-create-twin-review");
  await createReview.getByRole("button", { name: "取消", exact: true }).click();
  await phone.getByRole("button", { name: "忽略", exact: true }).click();
  await phone.getByRole("status").filter({ hasText: "已忽略" }).waitFor();
  await phone.locator(".assistant-page-mobile").getByRole("button", { name: "返回", exact: true }).click();
  await phoneRows.getByRole("button", { name: /新建隔离评审会话.*新建会话/u }).click();
  await phone.getByRole("button", { name: "核对新会话…" }).click();
  for (const value of [host.snapshot.host.name, createdTitle, cwd, modelName]) {
    await createReview.getByText(value, { exact: true }).waitFor();
  }
  const selectedSection = await section.innerText();
  assert.ok(selectedSection.includes(sectionName) && twinSection.includes(sectionName));
  assert.notEqual(selectedSection, twinSection, "The confirmation distinguishes the two same-name Sections");
  assert.ok(selectedSection.includes(projectId) && twinSection.includes(twin.projectId));
  assert.equal(await createReview.locator('pre[aria-label="完整首条消息"]').textContent(), firstText);
  assert.equal(native.calls.filter(call => call.method === "start").length, 0);
  assert.deepEqual((await request("assistant.proposal.list", { includeSession: true })).proposals, []);
  await assert.rejects(request("assistant.proposal.commit", { ...ref, confirmSession: true }), { code: "INVALID_PARAMS" });
  await capture(phone, "mobile-session-create-review");
  await createReview.getByRole("button", { name: "确认新建并发送" }).click();
  const readCreated = async () => (await request("assistant.proposal.list", { history: true, includeSessionCreate: true })).proposals.find(proposal => proposal.proposalId === ref.proposalId);
  await eventually(async () => (await readCreated())?.state, "applied", "Native created the approved session and submitted the first message");
  const { sessionCreation: { sessionId: createdId } } = await readCreated();
  await syncNativeSections(host);
  const created = host.snapshot.sessions.find(session => session.sessionId === createdId);
  assert.equal(created.projectId, projectId);
  const { configuration } = await request("session.configuration", { sessionId: createdId });
  assert.equal(configuration.model, model);
  const start = native.calls.findIndex(call => call.method === "start" && call.args[0].sessionId === createdId);
  const setModel = native.calls.findIndex(call => call.method === "setModel" && call.args[0] === createdId);
  const firstSend = native.calls.findIndex(call => call.method === "sendMessage" && call.args[0] === createdId);
  assert.ok(start >= 0 && setModel > start && firstSend > setModel);
  assert.equal(native.calls[start].args[0].withoutFirstMessage, true);
  assert.ok(native.calls.slice(setModel + 1, firstSend).some(call => call.method === "getSession" && call.args[0] === createdId));
  assert.equal(native.calls[firstSend].args[1], firstText);
  assert.ok(!native.calls.some(call => call.method === "saveTrust" || (call.method === "setPermissionMode" && call.args[0] === createdId)));
  await assert.rejects(request("assistant.proposal.commit", { ...ref, confirmSessionCreate: true }), { code: "CONFLICT" });
  assert.equal(native.calls.filter(call => call.method === "start").length, 1);
  assert.equal(native.calls.filter(call => call.method === "sendMessage" && call.args[0] === createdId).length, 1);
  const { client: _client, ...phoneCommit } = host.requests.find(request => request.method === "assistant.proposal.commit" && request.params.proposalId === ref.proposalId).params;
  assert.deepEqual(phoneCommit, { ...ref, confirmSessionCreate: true });
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await phone.getByRole("button", { name: "打开新会话", exact: true }).click();
  await eventually(() => host.requests.some(request => request.method === "session.open" && request.params.sessionId === createdId), true, "Client opens the newly created session");
  steps.push("The paired phone reviews the cwd, Section, model and exact first message; Native confirms the model before the only send, and the recorded session opens normally");
}
