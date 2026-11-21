import assert from "node:assert/strict";
import { eventually } from "../helpers.mjs";
import { assistantViewCapture, openDesktopAssistant, openMobileAssistant } from "./assistant-mail.mjs";

export async function verifyAssistantMailAccounts(page, host, steps, directory, viewports, baseUrl) {
  const capture = assistantViewCapture(page, directory, viewports);
  const [originalMail] = host.nativeApproval.assistantMail.service.page({ limit: 1 }).events;
  await openMobileAssistant(page);
  const accounts = page.getByRole("region", { name: "邮箱账号", exact: true });
  const extraUser = "second@example.test";
  const extraAccount = accounts.locator(".assistant-account-row").filter({ hasText: extraUser });
  await page.getByRole("button", { name: "助理设置", exact: true }).click();
  await accounts.getByText("assistant@example.test", { exact: true }).waitFor();
  await host.send({ kind: "snapshot", snapshot: { ...host.snapshot, assistantMail: {
    ...host.snapshot.assistantMail, accounts: [], receiverState: "error", accountConfigError: "mail_account_config_unavailable",
  } } });
  await accounts.getByRole("alert").getByText("无法读取邮箱配置。修复本机配置后重启 Bridge。", { exact: true }).waitFor();
  assert.equal(await accounts.getByRole("button", { name: "添加邮箱", exact: true }).isDisabled(), true);
  assert.equal(await accounts.getByText("尚未添加邮箱。", { exact: true }).count(), 0);
  await capture("mail-config-unavailable");
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  steps.push("unreadable account settings show a repair notice and disable account mutations until the host reports healthy settings");
  await accounts.getByRole("button", { name: "添加邮箱", exact: true }).click();
  assert.equal(await accounts.getByLabel("SMTP 服务器", { exact: true }).count(), 1, "SMTP is configured in the same form as IMAP");
  assert.equal(await accounts.locator('input[type="password"]').count(), 1, "The account form asks for one credential");
  await accounts.getByLabel("邮箱地址", { exact: true }).fill(extraUser);
  await accounts.getByLabel("IMAP 服务器", { exact: true }).fill("imap.second.example.test");
  const smtpHost = accounts.getByLabel("SMTP 服务器", { exact: true });
  const smtpPort = accounts.getByLabel("SMTP 端口", { exact: true });
  await smtpHost.fill("smtp.second.example.test");
  await smtpPort.fill("");
  await smtpHost.fill("");
  assert.equal(await smtpPort.isDisabled(), true, "An empty optional SMTP host does not require an SMTP port");
  await smtpHost.fill("smtp.second.example.test");
  await smtpPort.fill("465");
  await accounts.getByLabel("密码", { exact: true }).fill("fixture-credential-add");
  await capture("mobile-mail-shared-auth");
  const beforeAccountSave = host.requests.length;
  await accounts.getByRole("button", { name: "添加账号", exact: true }).click();
  await extraAccount.getByText("imap.second.example.test:993", { exact: true }).waitFor();
  await extraAccount.getByText("SMTP smtp.second.example.test:465", { exact: true }).waitFor();
  await accounts.getByText("实时接收", { exact: true }).waitFor();
  await extraAccount.getByText("定时轮询", { exact: true }).waitFor();
  const { accountKey, smtp, smtpSharedAuth } = host.snapshot.assistantMail.accounts.find(account => account.user === extraUser);
  assert.equal(smtpSharedAuth, true);
  assert.deepEqual(smtp, { host: "smtp.second.example.test", port: 465, security: "tls", user: extraUser, from: extraUser });
  const accountRequests = host.requests.slice(beforeAccountSave).filter(request => request.method.startsWith("plugin.assistant-mail.account."));
  assert.deepEqual(accountRequests.map(request => request.method), ["plugin.assistant-mail.account.save"]);
  const { client: _accountClient, ...accountParams } = accountRequests[0].params;
  assert.deepEqual(accountParams, { host: "imap.second.example.test", user: extraUser, credential: "fixture-credential-add",
    smtp: { host: "smtp.second.example.test", port: 465, security: "tls", from: extraUser } });
  const accountSettings = extraAccount.getByRole("button", { name: `账号设置：${extraUser}`, exact: true });
  const credential = extraAccount.getByLabel("密码", { exact: true });
  const fromAddress = extraAccount.getByLabel("发件地址", { exact: true });
  await accountSettings.click();
  assert.equal(await accountSettings.getAttribute("aria-expanded"), "true");
  assert.equal(await credential.inputValue(), "", "Stored credentials are never prefilled");
  assert.equal(await credential.getAttribute("required"), null);
  await smtpHost.fill("new-smtp.example.test");
  assert.equal(await credential.evaluate(input => input.required), true);
  await smtpHost.fill(smtp.host);
  await smtpPort.fill("2525");
  assert.equal(await credential.evaluate(input => input.required), true);
  await smtpPort.fill(String(smtp.port));
  await extraAccount.getByLabel("加密方式").selectOption("starttls");
  assert.equal(await credential.evaluate(input => input.required), true);
  await extraAccount.getByLabel("加密方式").selectOption(smtp.security);
  assert.equal(await credential.evaluate(input => input.required), false);
  const from = "alias@example.test";
  await fromAddress.fill(from);
  await capture("mobile-mail-account-inline");
  await extraAccount.getByRole("button", { name: "保存设置", exact: true }).click();
  await credential.waitFor({ state: "hidden" });
  assert.deepEqual(host.snapshot.assistantMail.accounts.find(account => account.accountKey === accountKey)?.smtp, { ...smtp, from });
  const { client: _fromClient, ...fromParams } = host.requests.findLast(request => request.method === "plugin.assistant-mail.account.save").params;
  assert.deepEqual(fromParams, { accountKey, smtp: { host: smtp.host, port: smtp.port, security: smtp.security, from } });
  steps.push("the selected account expands inline and saves its From address without submitting a stored credential; changing the SMTP connection requires a password");
  await accountSettings.click();
  await extraAccount.getByRole("button", { name: "关闭发信", exact: true }).click();
  await extraAccount.getByText("SMTP smtp.second.example.test:465", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(host.snapshot.assistantMail.accounts.find(account => account.accountKey === accountKey)?.enabled, true);
  await extraAccount.getByText("定时轮询", { exact: true }).waitFor();
  const pollInterval = extraAccount.getByRole("combobox", { name: /^备用轮询间隔/u });
  assert.equal(await pollInterval.inputValue(), "60");
  await accounts.getByRole("button", { name: "添加邮箱", exact: true }).click();
  const draftAddress = accounts.getByLabel("邮箱地址", { exact: true });
  await draftAddress.fill("unsaved@example.test");
  const allowPollingUpdate = Promise.withResolvers();
  host.pollIntervalGate = allowPollingUpdate.promise;
  try {
    await pollInterval.selectOption("off");
    await eventually(() => pollInterval.isDisabled(), true, "The interval control is disabled during the settings request");
    assert.equal(await pollInterval.inputValue(), "off", "The pending selection is visible before the host acknowledges it");
  } finally {
    host.pollIntervalGate = undefined;
    allowPollingUpdate.resolve();
  }
  await extraAccount.getByText("不支持持续收件，轮询已关闭", { exact: true }).waitFor();
  assert.equal(await draftAddress.count(), 1, "Saving a polling interval keeps the open account form");
  assert.equal(await draftAddress.inputValue(), "unsaved@example.test");
  await accounts.getByRole("button", { name: "取消", exact: true }).click();
  await pollInterval.selectOption("30");
  await extraAccount.getByText("定时轮询", { exact: true }).waitFor();
  assert.equal(await pollInterval.inputValue(), "30");
  const { client: _client, ...pollingParams } = host.requests.findLast(request => request.method === "plugin.assistant-mail.account.set-poll-interval").params;
  assert.deepEqual(pollingParams, { accountKey, pollIntervalSeconds: 30 });
  assert.equal(host.snapshot.assistantMail.accounts.find(account => account.accountKey !== accountKey).pollIntervalSeconds, 60);
  assert.equal(JSON.stringify(host.snapshot).includes("fixture-credential-add"), false);
  for (const [state, errorCode, label, tone] of [
    ["reconnecting", "mail_authentication_failed", "密码错误", "error"],
    ["error", "mail_credentials_unavailable", "凭据不可用", "error"],
    ["unsupported", "mail_idle_unsupported", "不支持持续收件，轮询已关闭", "unsupported"],
  ]) {
    const assistantMail = host.snapshot.assistantMail;
    await host.send({ kind: "snapshot", snapshot: { ...host.snapshot, assistantMail: {
      ...assistantMail, accounts: assistantMail.accounts.map(account => account.accountKey === accountKey ? { ...account, state, errorCode } : account),
    } } });
    const status = extraAccount.getByText(label, { exact: true });
    await status.waitFor({ timeout: 5000 });
    assert.equal(await status.getAttribute("data-state"), tone);
  }
  await accounts.getByRole("button", { name: `停用：${extraUser}`, exact: true }).click();
  await extraAccount.getByText("已停用", { exact: true }).waitFor();
  const { accountKey: disabledAccountKey, enabled } = host.requests.findLast(request => request.method === "plugin.assistant-mail.account.set-enabled").params;
  assert.deepEqual({ accountKey: disabledAccountKey, enabled }, { accountKey, enabled: false });
  await capture("mobile-mail-accounts");
  const assistantMail = host.snapshot.assistantMail;
  const originalAccount = assistantMail.accounts.find(account => account.accountKey === originalMail.accountKey);
  await host.send({ kind: "snapshot", snapshot: { ...host.snapshot, assistantMail: {
    ...assistantMail, accounts: assistantMail.accounts.map(account => account.accountKey === accountKey ? { ...account, user: originalAccount.user } : account),
  } } });
  await page.locator(".assistant-page .m-header").getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "收件", exact: true }).click();
  await page.locator(`.assistant-mail-list [data-mail-id="${originalMail.mailRefId}"] header`).getByText(`${originalAccount.user} (${originalAccount.host}:${originalAccount.port})`, { exact: true }).waitFor();
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  steps.push("mobile account settings add and disable a second inbox, report account errors, and disambiguate the cards of same-name accounts");

  const desktopRequests = [];
  await openDesktopAssistant(page, host, baseUrl, desktopRequests);
  await page.getByRole("button", { name: "助理设置", exact: true }).click();
  await extraAccount.getByText("已停用", { exact: true }).waitFor();
  assert.equal(await pollInterval.inputValue(), "30");
  await pollInterval.selectOption("120");
  await eventually(() => host.snapshot.assistantMail.accounts.find(account => account.accountKey === accountKey)?.pollIntervalSeconds,
    120, "Desktop saves the same account's polling interval");
  assert.deepEqual(desktopRequests.findLast(request => request.method === "plugin.assistant-mail.account.set-poll-interval").params,
    { accountKey, pollIntervalSeconds: 120 });
  await accountSettings.click();
  assert.equal(await credential.inputValue(), "", "Stored credentials are never prefilled");
  assert.equal(await credential.evaluate(input => input.required), true, "Re-enabling SMTP requires explicit authorization");
  await smtpHost.fill(smtp.host);
  await credential.fill("fixture-credential-replacement");
  await accounts.getByRole("button", { name: "保存设置", exact: true }).click();
  await credential.waitFor({ state: "hidden" });
  assert.deepEqual(desktopRequests.findLast(request => request.method === "plugin.assistant-mail.account.save").params,
    { accountKey, credential: "fixture-credential-replacement", smtp: { host: smtp.host, port: smtp.port, security: smtp.security, from: smtp.from } });
  assert.equal(JSON.stringify(host.snapshot).includes("fixture-credential-replacement"), false);
  await accounts.getByRole("button", { name: `启用：${extraUser}`, exact: true }).click();
  await accounts.getByRole("button", { name: `停用：${extraUser}`, exact: true }).waitFor();
  await eventually(() => host.snapshot.assistantMail.accounts.find(account => account.accountKey === accountKey)?.state,
    "connected", "The re-enabled synthetic receiver reconnects after its RPC acknowledgement");
  await page.evaluate(assistantMail => window.assistantDesktopSnapshot({ assistantMail }), host.snapshot.assistantMail);
  await extraAccount.getByText("定时轮询", { exact: true }).waitFor();
  assert.equal(await pollInterval.inputValue(), "120");
  await accountSettings.click();
  assert.equal(await credential.inputValue(), "");
  await fromAddress.fill(from);
  await extraAccount.getByRole("button", { name: "保存设置", exact: true }).click();
  await credential.waitFor({ state: "hidden" });
  assert.deepEqual(desktopRequests.findLast(request => request.method === "plugin.assistant-mail.account.save").params, fromParams);
  await page.evaluate(host => window.assistantDesktopSnapshot({ host }), { ...host.snapshot.host,
    capabilities: host.snapshot.host.capabilities.filter(capability => capability !== "plugin.assistant-mail.keep-credential.v1") });
  await accountSettings.click();
  assert.equal(await credential.evaluate(input => input.required), true, "Older hosts still require the password");
  await extraAccount.getByRole("button", { name: "取消", exact: true }).click();
  await accounts.getByRole("button", { name: `移除：${extraUser}`, exact: true }).click();
  assert.ok(host.snapshot.assistantMail.accounts.some(account => account.accountKey === accountKey));
  await page.getByRole("alertdialog", { name: "移除邮箱？" }).getByRole("button", { name: "确认移除", exact: true }).click();
  await extraAccount.waitFor({ state: "detached" });
  assert.equal(host.snapshot.assistantMail.accounts.some(account => account.accountKey === accountKey), false);

  const accountRequestCount = desktopRequests.filter(request => request.method.startsWith("plugin.assistant-mail.account.")).length;
  await page.evaluate(assistantMail => window.assistantDesktopSnapshot({ assistantMail }), {
    ...host.snapshot.assistantMail, credentialsSupported: false,
  });
  await accounts.getByText("当前电脑不支持存储邮箱凭据。", { exact: true }).waitFor();
  assert.equal(await accounts.getByRole("button", { name: "添加邮箱", exact: true }).isDisabled(), true);
  assert.equal(await accounts.getByRole("button", { name: "停用：assistant@example.test", exact: true }).isDisabled(), true);
  assert.equal(desktopRequests.filter(request => request.method.startsWith("plugin.assistant-mail.account.")).length, accountRequestCount);
  await capture("desktop-mail-accounts-unsupported");
  steps.push("desktop settings update, re-enable and confirm removal of the same account; the unsupported-credentials snapshot disables writes");
}
