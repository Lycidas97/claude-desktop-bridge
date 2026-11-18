import assert from "node:assert/strict";
import { QRCodeSVG } from "qrcode.react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPairingUrl } from "../../../packages/protocol/dist/index.js";

export async function scanDesktopPairingQr(context, page, host, steps, baseUrl) {
  const desktop = await context.newPage();
  const pairingUrl = buildPairingUrl(baseUrl, host.pairing);
  await desktop.addInitScript(snapshot => {
    navigator.clipboard.writeText = async text => { window.copiedPairingLink = text; };
    window.bridgeDesktop = {
      getSnapshot: async () => ({ ...snapshot, pairingUrl: undefined, pairingExpiresAt: undefined }),
      onSnapshot: () => () => {},
      onEvent: () => () => {},
      createPairing: async () => snapshot,
      checkClaudeDesktopDeveloperSettings: async () => ({ supported: false, enabled: false, profiles: [] }),
    };
  }, { ...host.snapshot, pairingUrl, pairingExpiresAt: host.pairing.expiresAt });
  await desktop.setViewportSize({ width: 1200, height: 900 });
  await desktop.goto(baseUrl);
  await desktop.getByRole("button", { name: "设置", exact: true }).click();
  await desktop.getByRole("button", { name: "手机配对与设备", exact: true }).click();
  await desktop.getByRole("button", { name: "添加手机", exact: true }).click();
  const panel = desktop.getByRole("region", { name: "手机扫码配对" });
  await panel.getByText("旧版手机端请复制配对链接，在手机上粘贴。", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "复制配对链接", exact: true }).click();
  await panel.getByRole("button", { name: "已复制配对链接", exact: true }).waitFor();
  assert.ok(await desktop.evaluate(link => window.copiedPairingLink === link, pairingUrl), "Copy uses the full V4 link accepted by older phones");

  const fullQr = renderToStaticMarkup(createElement(QRCodeSVG, { value: pairingUrl, level: "M", marginSize: 4 }));
  const fullQrModules = Number(fullQr.match(/viewBox="0 0 (\d+) \d+"/u)?.[1]);
  const qrImage = panel.getByRole("img", { name: "手机配对二维码" });
  assert.deepEqual(await qrImage.evaluate(svg => {
    const { width, height } = svg.getBoundingClientRect();
    return { width, height };
  }), { width: 104, height: 104 }, "Desktop QR must render at 104 × 104 CSS pixels");
  const { qr, qrModules } = await qrImage.evaluate(svg => ({
    qr: new XMLSerializer().serializeToString(svg),
    qrModules: svg.viewBox.baseVal.width,
  }));
  assert.ok(qrModules < fullQrModules, `Desktop QR must use fewer modules than the full link (${qrModules} vs ${fullQrModules})`);
  await desktop.close();
  steps.push("Desktop guides older phones to the full copied V4 link and renders a smaller QR");

  await page.addInitScript(() => {
    const frame = document.createElement("canvas");
    frame.width = 1920;
    frame.height = 1080;
    const pixels = frame.getContext("2d");
    navigator.mediaDevices.getUserMedia = async () => {
      pixels.fillRect(0, 0, frame.width, frame.height);
      return frame.captureStream(12);
    };
    window.showPairingQr = async svg => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      await image.decode();
      pixels.drawImage(image, 720, 300, 480, 480);
    };
  });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "扫描二维码", exact: true }).click();
  const scanner = page.getByRole("dialog", { name: "扫描电脑二维码" });
  await scanner.getByText("将电脑上的配对二维码放入框内", { exact: true }).waitFor();
  const viewfinderRatio = await scanner.locator(".qr-scanner-stage").evaluate(stage => stage.clientWidth / stage.clientHeight);
  assert.ok(Math.abs(viewfinderRatio - 16 / 9) < 0.03, "The viewfinder shows the full landscape camera frame");
  await scanner.getByText(/没有识别到二维码/u).waitFor({ timeout: 8_000 });
  assert.equal(await scanner.isVisible(), true, "Scanning continues after the no-code guidance");
  await page.evaluate(svg => window.showPairingQr(svg), qr);
  await scanner.waitFor({ state: "hidden" });
  steps.push("Desktop pairing QR decoded from a synthetic camera frame after live no-code guidance");
}
