import { beforeEach, describe, expect, it, vi } from "vitest";

const image = vi.hoisted(() => ({
  size: { width: 0, height: 0 },
  resize: vi.fn((_size: { width: number; height: number; quality: string }) => ({ toJPEG: () => Buffer.from("jpeg") })),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => false, getSize: () => image.size, resize: image.resize }),
  },
}));

const { ElectronEvidencePreviewRenderer } = await import("./artifact-preview.js");

describe("ElectronEvidencePreviewRenderer.image", () => {
  beforeEach(() => image.resize.mockClear());

  it("scales a large figure down to a 1600 px long edge for the phone", async () => {
    image.size = { width: 3_200, height: 2_000 };

    const preview = await new ElectronEvidencePreviewRenderer().image(Buffer.from("png"), "image/png");

    expect(image.resize).toHaveBeenCalledWith({ width: 1_600, height: 1_000, quality: "better" });
    expect(preview.mimeType).toBe("image/jpeg");
  });

  it("passes a figure within the preview size through unchanged", async () => {
    image.size = { width: 1_600, height: 900 };
    const bytes = Buffer.from("png");

    const preview = await new ElectronEvidencePreviewRenderer().image(bytes, "image/png");

    expect(image.resize).not.toHaveBeenCalled();
    expect(preview).toEqual({ bytes, mimeType: "image/png" });
  });
});
