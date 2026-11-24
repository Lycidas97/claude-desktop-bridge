import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eventually, openMobileDrawer, selectCustomOption } from "../helpers.mjs";
import { installDesktopConversationFixture } from "./desktop.mjs";

export async function verifyFirstAttachments(page, host, steps, directory, baseUrl) {
  const photo = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#216f88";
    ctx.fillRect(0, 0, 32, 32);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  const bytes = Buffer.from("synthetic first-turn attachment\n");
  const createCalls = () => host.requests.filter(request => request.method === "session.create");
  const uploadCalls = () => host.requests.filter(request => request.method === "file.upload.open");
  const starts = () => host.requests.filter(request => request.method === "turn.start");
  const nativeSends = () => host.nativeApproval.calls.filter(call => call.method === "sendMessage");

  for (const surface of ["mobile", "desktop"]) {
    const desktop = surface === "desktop";
    if (desktop) {
      host.snapshot.sessions = []; // Exercise the canvas shown before Desktop has any sessions.
      await installDesktopConversationFixture(page, host);
      await page.setViewportSize({ width: 1280, height: 820 });
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    }
    const canvas = page.locator(".new-chat-canvas");
    const thumbnail = name => canvas.locator(".composer-attachments > span").filter({ hasText: name }).locator('img[alt=""]');
    const openNewChat = async () => {
      if (!desktop) await openMobileDrawer(page);
      await page.locator(desktop ? ".desktop-session-sidebar" : ".mobile-home-catalog")
        .getByRole("button", { name: "新建会话", exact: true }).click();
    };
    const chooseDirectory = async (cwd) => {
      await canvas.getByRole("button", { name: "选择文件夹", exact: true }).click();
      const picker = page.locator(".session-create-dialog");
      const browse = picker.getByRole("button", { name: "浏览电脑文件夹", exact: true });
      if (await browse.isVisible()) await browse.click();
      await picker.getByRole("button", { name: "输入路径", exact: true }).click();
      await picker.getByLabel("当前路径", { exact: true }).fill(cwd);
      await picker.getByLabel("当前路径", { exact: true }).press("Enter");
      await picker.getByRole("button", { name: "使用此文件夹", exact: true }).click();
      await picker.waitFor({ state: "hidden" });
    };
    const enterNewChat = async (title, emptyDesktop = false) => {
      if (!emptyDesktop) await openNewChat();
      await chooseDirectory(host.nativeApproval.cwd);
      await canvas.getByLabel("会话标题", { exact: true }).fill(title);
    };
    const title = `首发附件 ${surface}`;
    const counts = [createCalls().length, uploadCalls().length, starts().length, nativeSends().length];
    await enterNewChat(title, desktop);
    const trigger = canvas.locator(".composer-attach-trigger");
    await trigger.click();
    assert.equal(await page.locator(".session-create-dialog").count(), 0, "The composer plus must not open the folder picker");
    const menu = canvas.getByRole("menu", { name: "添加附件选项" });
    await menu.getByRole("menuitem", { name: /添加图片/u }).waitFor();
    await menu.getByRole("menuitem", { name: /添加文件/u }).waitFor();
    await page.screenshot({ path: resolve(directory, `${surface}-first-attachment-menu.png`) });
    const pick = async (label, files) => {
      if (!await menu.isVisible()) await trigger.click();
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"), menu.getByRole("menuitem", { name: label }).click(),
      ]);
      await chooser.setFiles(files);
    };
    await pick(/添加图片/u, ["first.png", "discard.png"].map(name => ({ name, mimeType: "image/png", buffer: photo })));
    await thumbnail("first.png").waitFor();
    await eventually(() => thumbnail("first.png").evaluate(image => image.naturalWidth), 32, "The thumbnail loads while its filename is announced once");
    await canvas.getByRole("button", { name: "移除 discard.png", exact: true }).click();
    await pick(/添加文件/u, ["first.txt", "second.txt", "discard.txt"].map(name => ({ name, mimeType: "text/plain", buffer: bytes })));
    await canvas.getByRole("button", { name: "移除 discard.txt", exact: true }).click();
    await canvas.getByText("first.txt", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(directory, `${surface}-first-attachment-draft.png`) });
    assert.deepEqual([createCalls().length, uploadCalls().length, starts().length], counts.slice(0, 3), "Picking and removing files must not create a session, upload, or send");

    const text = `读取首条附件 ${surface}`;
    await canvas.locator("textarea").fill(text);
    const permission = canvas.getByRole("combobox", { name: "权限模式", exact: true });
    await selectCustomOption(page, permission, "plan");
    host.rejectPermissionMode = "plan";
    await canvas.getByRole("button", { name: "发送", exact: true }).click();
    await canvas.getByRole("alert").filter({ hasText: "隔离权限模式未应用" }).waitFor();
    assert.deepEqual([createCalls().length, uploadCalls().length, starts().length], [counts[0] + 1, counts[1], counts[2]], "A rejected configuration must not upload or send");
    assert.ok(await permission.isEnabled(), "A rejected configuration must leave the mode editable on the pinned draft");
    await selectCustomOption(page, permission, "acceptEdits");
    host.rejectPermissionMode = undefined;
    let commits = 0;
    host.uploadCommitFailure = () => ++commits === 2 ? "隔离首发文件保存失败" : undefined;
    const uploadGate = Promise.withResolvers();
    host.uploadCommitGate = uploadGate.promise;
    await canvas.getByRole("button", { name: "发送", exact: true }).click();
    try {
      await canvas.getByRole("progressbar", { name: "first.txt 上传进度", exact: true }).waitFor();
      await canvas.getByText(/正在保存/u).waitFor();
    } finally {
      uploadGate.resolve();
    }
    await page.getByText("隔离首发文件保存失败", { exact: false }).first().waitFor();
    assert.equal(await page.locator("textarea:visible").inputValue(), text, "Upload failure keeps the original text");
    await thumbnail("first.png").waitFor();
    await page.getByRole("button", { name: "移除 second.txt", exact: true }).waitFor();
    assert.deepEqual([createCalls().length, uploadCalls().length, starts().length, nativeSends().length], [counts[0] + 1, counts[1] + 2, counts[2], counts[3]], "Upload failure must not fall through to a partial Native send");
    const created = host.snapshot.sessions.find(session => session.title === title);
    assert.ok(created, "Native created the target session before any upload");
    assert.deepEqual(host.requests.filter(request => request.method === "session.configure" && request.params.sessionId === created.sessionId)
      .map(request => request.params.permissionMode), ["plan", "acceptEdits"], "Retry can correct the Native session configuration without creating another session");

    if (desktop) await canvas.getByRole("button", { name: "返回会话", exact: true }).click();
    else await openMobileDrawer(page);
    await openNewChat();
    assert.equal(await canvas.getByLabel("会话标题", { exact: true }).inputValue(), title, "The resumed canvas identifies its existing session");
    assert.equal(await canvas.locator("textarea").inputValue(), text);
    await thumbnail("first.png").waitFor();
    await canvas.getByRole("button", { name: "移除 first.txt", exact: true }).waitFor();
    await canvas.getByRole("button", { name: "移除 second.txt", exact: true }).waitFor();
    await canvas.getByRole("button", { name: "发送", exact: true }).click();
    await eventually(() => nativeSends().length, counts[3] + 1, `${surface}: retry sends once through Native`);
    assert.equal(createCalls().length, counts[0] + 1, "Retry reuses the created Native session");
    const uploads = uploadCalls().slice(counts[1]);
    assert.deepEqual(uploads.map(({ params }) => ({ sessionId: params.sessionId, name: params.name, size: params.size, sha256: params.sha256 })), ["first.txt", "second.txt", "second.txt"].map(name => ({
      sessionId: created.sessionId, name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    })), "Only the failed file is retried; all opens target the created session");
    assert.ok(host.requests.indexOf(createCalls().at(-1)) < host.requests.indexOf(uploads[0]));
    const batchCommits = host.requests.filter(request => request.method === "file.upload.commit").slice(-3);
    const paths = [`.bridge-uploads/${batchCommits[0].params.uploadId}/first.txt`, `.bridge-uploads/${batchCommits[2].params.uploadId}/second.txt`];
    for (const path of paths) assert.deepEqual(await readFile(resolve(created.cwd, path)), bytes, "Native fixture receives exact file bytes in the selected directory");
    const sentText = `${text}\n\n已上传文件（相对当前会话目录）：\n${paths.map(path => `- ${JSON.stringify(path)}`).join("\n")}`;
    assert.deepEqual(nativeSends().at(-1).args.slice(0, 3), [created.sessionId, sentText,
      [{ filename: "first.png", mimeType: "image/png", base64: photo.toString("base64") }]]);
    await canvas.waitFor({ state: "hidden" });

    const imageTitle = `纯图片首发 ${surface}`;
    host.snapshot.host.capabilities = host.snapshot.host.capabilities.filter(capability => capability !== "workspace.upload.v1");
    await host.send({ kind: "snapshot", snapshot: host.snapshot });
    await enterNewChat(imageTitle);
    await canvas.locator('input[aria-label="选择要上传的文件"]').waitFor({ state: "detached" });
    await pick(/添加图片/u, { name: "only.png", mimeType: "image/png", buffer: photo });
    await thumbnail("only.png").waitFor();
    await canvas.getByRole("button", { name: "发送", exact: true }).click();
    await eventually(() => nativeSends().length, counts[3] + 2, `${surface}: image-only first send reaches Native without an upload`);
    const imageSession = host.snapshot.sessions.find(session => session.title === imageTitle);
    assert.ok(imageSession);
    assert.deepEqual(nativeSends().at(-1).args.slice(0, 3), [imageSession.sessionId, "",
      [{ filename: "only.png", mimeType: "image/png", base64: photo.toString("base64") }]]);
    await canvas.waitFor({ state: "hidden" });

    assert.equal(uploadCalls().length, counts[1] + 3, "Image-only first send does not touch the file upload path");
    host.snapshot.host.capabilities.push("workspace.upload.v1");
    await host.send({ kind: "snapshot", snapshot: host.snapshot });

    const abandonedTitle = `待放弃首发 ${surface}`;
    await enterNewChat(abandonedTitle);
    await pick(/添加图片/u, { name: "abandoned.png", mimeType: "image/png", buffer: photo });
    await pick(/添加文件/u, ["kept-on-host.txt", "abandoned.txt"].map(name => ({ name, mimeType: "text/plain", buffer: bytes })));
    await canvas.locator("textarea").fill("不要发送这条草稿");
    commits = 0;
    await canvas.getByRole("button", { name: "发送", exact: true }).click();
    await canvas.getByRole("alert").filter({ hasText: "隔离首发文件保存失败" }).waitFor();
    const abandoned = host.snapshot.sessions.find(session => session.title === abandonedTitle);
    assert.ok(abandoned);
    const keptUpload = host.requests.filter(request => request.method === "file.upload.commit").at(-2);
    for (const name of ["kept-on-host.txt", "abandoned.txt", "abandoned.png"]) {
      await canvas.getByRole("button", { name: `移除 ${name}`, exact: true }).click();
    }
    await canvas.locator("textarea").fill("");
    if (desktop) await canvas.getByRole("button", { name: "返回会话", exact: true }).click();
    else await openMobileDrawer(page);
    await openNewChat();
    assert.ok(await canvas.getByRole("button", { name: "放弃草稿", exact: true }).isVisible(), "A pinned first turn must have an explicit way to start over after clearing it");
    const discard = canvas.getByRole("button", { name: "放弃草稿", exact: true });
    const confirmation = page.getByRole("alertdialog", { name: "放弃首发草稿？" });
    await discard.click();
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await canvas.getByLabel("会话标题", { exact: true }).inputValue(), abandonedTitle);
    await discard.click();
    await confirmation.waitFor();
    await page.screenshot({ path: resolve(directory, `${surface}-discard-first-attachment-draft.png`) });
    await confirmation.getByRole("button", { name: "放弃草稿", exact: true }).click();
    assert.ok(await canvas.getByRole("button", { name: "创建空会话", exact: true }).isEnabled(), "Abandoning makes this a fresh canvas");

    const plainTitle = `纯文本首发 ${surface}`;
    await chooseDirectory(host.nativeApproval.harnessCwd);
    await canvas.getByLabel("会话标题", { exact: true }).fill(plainTitle);
    await selectCustomOption(page, canvas.getByRole("combobox", { name: "模型", exact: true }), "synthetic-model");
    await canvas.locator("textarea").fill("纯文本首发内容");
    await canvas.getByRole("button", { name: "发送", exact: true }).click();
    await eventually(() => nativeSends().length, counts[3] + 3, `${surface}: plain text still sends through Native`);
    const plain = host.snapshot.sessions.find(session => session.title === plainTitle);
    assert.equal(plain?.cwd, host.nativeApproval.harnessCwd);
    assert.notEqual(plain.sessionId, abandoned.sessionId, "The next first message targets a different Native session");
    assert.ok(host.snapshot.sessions.some(session => session.sessionId === abandoned.sessionId), "Abandoning the draft leaves its Native session intact");
    assert.deepEqual(await readFile(resolve(abandoned.cwd, ".bridge-uploads", keptUpload.params.uploadId, "kept-on-host.txt")), bytes);
    assert.deepEqual(nativeSends().at(-1).args.slice(0, 3), [plain.sessionId, "纯文本首发内容", undefined]);
    assert.equal(uploadCalls().length, counts[1] + 5, "Plain text does not touch the file upload path");
    steps.push(`${surface}: retained image and exact uploaded bytes reach the same newly created Native session after a deterministic failure; abandoning a later draft leaves its Native session and uploaded file, then text-only sends to a different directory`);
  }
}
