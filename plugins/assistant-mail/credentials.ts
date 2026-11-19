import { spawn } from "node:child_process";

export interface MailCredentials {
  readonly supported: boolean;
  get(accountKey: string): Promise<string | undefined>;
  set(accountKey: string, password: string): Promise<void>;
  delete(accountKey: string): Promise<void>;
}

const SERVICE = "Claude Desktop Bridge assistant-mail";

/** Capture Keychain output locally. Never forward process errors, stderr or command input. */
function security(args: string[], input?: string): Promise<{ code: number | null; errorOutput: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    const errors: Buffer[] = [];
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", () => reject(new Error("mail_credentials_unavailable")));
    child.stdin.on("error", () => reject(new Error("mail_credentials_unavailable")));
    child.on("close", (code) => resolve({ code, errorOutput: Buffer.concat(errors).toString("utf8") }));
    child.stdin.end(input);
  });
}

export class KeychainMailCredentials implements MailCredentials {
  readonly supported: boolean;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.supported = platform === "darwin";
  }

  async get(accountKey: string): Promise<string | undefined> {
    if (!this.supported) throw new Error("mail_credentials_unsupported");
    const result = await security(["find-generic-password", "-s", SERVICE, "-a", accountKey, "-g"]);
    if (result.code === 44) return undefined;
    if (result.code !== 0) throw new Error("mail_credentials_unavailable");
    // -w ambiguously emits either plaintext or bare hex. -g marks hex bytes with 0x and quotes printable text.
    const password = /^password: (?:0x([0-9A-Fa-f]+)(?: .*)?|"([^\n]*)")$/m.exec(result.errorOutput);
    if (!password) throw new Error("mail_credentials_unavailable");
    return password[1] ? Buffer.from(password[1], "hex").toString("utf8") : password[2]!;
  }

  async set(accountKey: string, password: string): Promise<void> {
    if (!this.supported) throw new Error("mail_credentials_unsupported");
    // security's interactive parser has a 4096-byte line buffer. The account key is a host-generated hash.
    const command = `add-generic-password -U -s "${SERVICE}" -a ${accountKey} -X ${Buffer.from(password).toString("hex")}\n`;
    if (Buffer.byteLength(command) >= 4096) throw new Error("mail_password_too_long");
    const result = await security(["-i"], command);
    if (result.code !== 0) throw new Error("mail_credentials_unavailable");
  }

  async delete(accountKey: string): Promise<void> {
    if (!this.supported) throw new Error("mail_credentials_unsupported");
    const result = await security(["delete-generic-password", "-s", SERVICE, "-a", accountKey]);
    if (result.code !== 0 && result.code !== 44) throw new Error("mail_credentials_unavailable");
  }
}
