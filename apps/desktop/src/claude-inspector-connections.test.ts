import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:util", async (importOriginal) => ({ ...await importOriginal<typeof import("node:util")>(), promisify: () => mocks.run }));
import { readInspectorConnections } from "./claude-inspector-monitor.js";
beforeEach(() => mocks.run.mockReset());

it("classifies the actual executable path, not the short process name or a similar bundle prefix", async () => {
  const paths = [
    "/Applications/Bridge.app/Contents/MacOS/bridge",
    "/Applications/Google Chrome.app/Contents/Frameworks/Helpers/Chrome Helper",
    "/opt/homebrew/bin/node",
    "/Applications/Bridge.app.backup/Contents/MacOS/bridge",
  ];
  mocks.run.mockResolvedValueOnce({ stdout: paths.map((_path, index) => `p${index + 10}\ncnode\nf4\nn127.0.0.1:${50000 + index}->127.0.0.1:9229\nTST=ESTABLISHED`).join("\n") });
  mocks.run.mockResolvedValueOnce({ stdout: paths.map((path, index) => `${index + 10}\0${path}\0\0`).join("") });
  const result = await readInspectorConnections({ helperPath: "/test/helper" });
  expect(result.clients.map(({ approved }) => approved)).toEqual([true, true, false, false]);
  expect(result.clients.map(({ executablePath }) => executablePath)).toEqual(paths);
  expect(mocks.run).toHaveBeenLastCalledWith("/test/helper", ["10", "11", "12", "13"], expect.any(Object));
});

it("marks an unavailable process path as unapproved", async () => {
  mocks.run.mockResolvedValueOnce({ stdout: "p42\ncnode\nf4\nn127.0.0.1:50000->127.0.0.1:9229\nTST=ESTABLISHED\n" });
  mocks.run.mockResolvedValueOnce({ stdout: "42\0\0permission denied\0" });
  expect((await readInspectorConnections({ helperPath: "/test/helper" })).clients).toEqual([{ pid: 42, name: "node", pathError: "permission denied", approved: false }]);
});

it("treats lsof's empty no-match exit as a closed port and propagates command errors", async () => {
  mocks.run.mockRejectedValueOnce(Object.assign(new Error("no matches"), { code: 1, stdout: "", stderr: "" }));
  expect(await readInspectorConnections()).toEqual({ listening: false, clients: [] });
  mocks.run.mockRejectedValueOnce(Object.assign(new Error("access denied"), { code: 1, stdout: "", stderr: "access denied" }));
  await expect(readInspectorConnections()).rejects.toThrow("access denied");
});
