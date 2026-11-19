import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { KeychainMailCredentials } from "./credentials.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
let code: number;
let output: string;
let errorOutput: string;
let input: string;

beforeEach(() => {
  code = 0; output = ""; errorOutput = "raw Keychain diagnostics must stay private"; input = "";
  mocked.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on("data", chunk => { input += String(chunk); });
    child.stdin.on("finish", () => {
      child.stdout.end(output);
      child.stderr.end(errorOutput);
      child.emit("close", code);
    });
    return child;
  });
});

it("writes the exact UTF-8 password through stdin hex without putting secrets in argv", async () => {
  const password = 'secret " slash\\ newline\n emoji☃';
  await new KeychainMailCredentials("darwin").set("a".repeat(64), password);
  expect(mocked.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/security", ["-i"], { stdio: ["pipe", "pipe", "pipe"] });
  expect(input).toContain(`-X ${Buffer.from(password).toString("hex")}\n`);
  expect(input).not.toContain(password);
  expect(JSON.stringify(mocked.spawn.mock.calls)).not.toContain(password);
});

it.each([
  ["password\n", 'password: 0x70617373776F72640A "password\\012"\n'],
  ["中文密码", "password: 0xE4B8ADE69687E5AF86E7A081\n"],
  ["deadbeef", 'password: "deadbeef"\n'],
  ['quote"in password', 'password: "quote"in password"\n'],
  ["slash\\in password", 'password: 0x736C6173685C696E2070617373776F7264 "slash\\134in password"\n'],
])("reads marked Keychain output without confusing hex-looking plaintext: %j", async (password, markedOutput) => {
  output = "keychain item attributes\n";
  errorOutput = markedOutput;
  expect(await new KeychainMailCredentials("darwin").get("a".repeat(64))).toBe(password);
  expect(mocked.spawn.mock.calls[0]?.[1]).toEqual(["find-generic-password", "-s", "Claude Desktop Bridge assistant-mail", "-a", "a".repeat(64), "-g"]);
});

it("distinguishes a missing item from an unavailable Keychain without exposing subprocess output", async () => {
  const credentials = new KeychainMailCredentials("darwin");
  code = 44;
  expect(await credentials.get("a".repeat(64))).toBeUndefined();
  code = 36; output = "sensitive server output";
  await expect(credentials.get("a".repeat(64))).rejects.toThrow(/^mail_credentials_unavailable$/);
  await expect(credentials.set("a".repeat(64), "secret")).rejects.toThrow(/^mail_credentials_unavailable$/);
});

it("deletes only the requested Keychain item and treats an already missing item as success", async () => {
  const credentials = new KeychainMailCredentials("darwin");
  const accountKey = "a".repeat(64);
  await credentials.delete(accountKey);
  expect(mocked.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/security",
    ["delete-generic-password", "-s", "Claude Desktop Bridge assistant-mail", "-a", accountKey],
    { stdio: ["pipe", "pipe", "pipe"] });
  expect(input).toBe("");
  code = 44;
  await expect(credentials.delete(accountKey)).resolves.toBeUndefined();
  code = 36;
  await expect(credentials.delete(accountKey)).rejects.toThrow(/^mail_credentials_unavailable$/);
});

it("rejects a command exceeding security's line buffer before starting the process", async () => {
  await expect(new KeychainMailCredentials("darwin").set("a".repeat(64), "secret".repeat(1_000))).rejects.toThrow("mail_password_too_long");
  expect(mocked.spawn).not.toHaveBeenCalled();
});

it.each(["win32", "linux"] as const)("explicitly refuses mailbox configuration on %s", async platform => {
  const credentials = new KeychainMailCredentials(platform);
  expect(credentials.supported).toBe(false);
  await expect(credentials.set("a".repeat(64), "secret")).rejects.toThrow("mail_credentials_unsupported");
  await expect(credentials.get("a".repeat(64))).rejects.toThrow("mail_credentials_unsupported");
  await expect(credentials.delete("a".repeat(64))).rejects.toThrow("mail_credentials_unsupported");
  expect(mocked.spawn).not.toHaveBeenCalled();
});
