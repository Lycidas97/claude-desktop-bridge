import assert from "node:assert/strict";
import { eventually } from "../helpers.mjs";
import { assistantViewCapture, openMobileAssistant } from "../assistant-helpers.mjs";

export async function verifyAssistantReadDirectories(page, host, steps, directory, viewports) {
  await openMobileAssistant(page);
  const tabs = page.locator(".assistant-view-tabs");
  const settings = tabs.getByRole("button", { name: "助理设置", exact: true });
  await settings.click();
  await page.getByRole("button", { name: "初始化托管助理", exact: true }).click();
  await page.getByRole("button", { name: "确认初始化", exact: true }).click();
  await tabs.getByRole("button", { name: "对话", exact: true, pressed: true }).waitFor();
  await settings.click();

  const readDirectories = page.getByRole("region", { name: "可读目录", exact: true });
  const empty = readDirectories.getByText("未授权工作区外的文件夹。", { exact: true });
  await empty.waitFor();
  const previousSessions = await page.locator(".assistant-binding summary").filter({ hasText: /^以前的会话$/u }).boundingBox();
  const directorySettings = await readDirectories.boundingBox();
  assert.ok(previousSessions && directorySettings && previousSessions.y + previousSessions.height <= directorySettings.y,
    "Former sessions remain above the separate read-only directory settings");

  const addDirectory = readDirectories.getByRole("button", { name: "添加可读目录", exact: true });
  await addDirectory.click();
  const picker = page.getByRole("dialog", { name: "选择文件夹", exact: true });
  const readablePath = host.nativeApproval.cwd;
  await picker.getByRole("button", { name: `选择 ${readablePath}`, exact: true }).click();
  await readDirectories.getByText(readablePath, { exact: true }).waitFor();
  assert.deepEqual(host.snapshot.assistantMail.workspace.readDirectories, [], "Picking a folder does not grant access");
  assert.equal(await empty.isVisible(), true, "The directory remains ungranted until confirmation");
  await readDirectories.getByRole("button", { name: "授权读取", exact: true }).click();
  await eventually(() => host.snapshot.assistantMail.workspace.readDirectories[0], readablePath, "Confirmed directory is projected by the host");
  const revoke = readDirectories.getByRole("button", { name: `撤销读取 ${readablePath}`, exact: true });
  await revoke.waitFor();
  const capture = assistantViewCapture(page, directory, viewports);
  await capture("mobile-assistant-read-directory");

  await host.send({ kind: "snapshot", snapshot: { ...host.snapshot,
    host: { ...host.snapshot.host, capabilities: host.snapshot.host.capabilities.filter(cap => cap !== "plugin.assistant-mail.workspace.v1") },
    assistantMail: { ...host.snapshot.assistantMail, bindingState: "unavailable" },
  } });
  await addDirectory.and(page.locator(":disabled")).waitFor();
  assert.equal(await revoke.isEnabled(), true, "Existing directories can be revoked while Native is disconnected");
  await revoke.click();
  await empty.waitFor();
  assert.deepEqual(host.snapshot.assistantMail.workspace.readDirectories, []);
  steps.push("managed assistant directory picker grants only after confirmation and revokes through the paired host");
}
