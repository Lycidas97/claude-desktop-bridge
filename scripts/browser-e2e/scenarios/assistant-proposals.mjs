import assert from "node:assert/strict";
import { resolve } from "node:path";
import { eventually, openMobileDrawer } from "../helpers.mjs";
import { openDesktopAssistant } from "./assistant-mail.mjs";

const action = { kind: "calendar.create", sourceId: "local", value: {
  title: "项目评审", startAt: "2027-01-04T14:00:00.000Z", endAt: "2027-01-04T15:00:00.000Z", allDay: false, timeZone: "UTC",
} };
const detachedTitle = "整理评审纪要";
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

export async function verifyAssistantProposals(page, host, steps, directory, viewports, baseUrl) {
  const capture = async (surface, name) => {
    await surface.screenshot({ path: resolve(directory, `${name}.png`) });
    viewports.push({ page: name, ...surface.viewportSize() });
  };
  const agenda = host.nativeApproval.assistantMail.agenda;
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
  const stale = await host.nativeApproval.controllerRequest({ kind: "request", requestId: "fixture-stale", method: "assistant.proposal.commit", params: inline }, "desktop").catch(error => error);
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

  const desktop = await page.context().newPage();
  const desktopRequests = [];
  await openDesktopAssistant(desktop, host, baseUrl, desktopRequests);
  await desktop.locator(`.conversation-stream [data-proposal-id="${inline.proposalId}"]`).getByText("已写入", { exact: true }).waitFor();
  await capture(desktop, "desktop-proposal-inline");
  await desktop.getByRole("button", { name: "待确认提案", exact: true }).click();
  await desktop.locator(".proposal-list").getByRole("button", { name: new RegExp(detachedTitle, "u") }).click();
  await detail.getByRole("button", { name: "返回列表", exact: true }).click();
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
  await desktop.close();
}
