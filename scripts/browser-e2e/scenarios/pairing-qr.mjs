import assert from "node:assert/strict";
import { buildPairingUrl } from "../../../packages/protocol/dist/index.js";

export async function scanDesktopPairingQr(context, page, host, steps, baseUrl) {
  const desktop = await context.newPage();
  const pairingUrl = buildPairingUrl(baseUrl, host.pairing);
  await desktop.addInitScript(snapshot => {
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
  const qr = await desktop.locator(".device-pairing-band svg[viewBox]").first().evaluate(svg => new XMLSerializer().serializeToString(svg));
  await desktop.close();

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
