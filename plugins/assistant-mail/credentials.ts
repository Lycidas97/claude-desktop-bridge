import { spawn } from "node:child_process";

export interface MailCredentials {
  readonly supported: boolean;
  get(accountKey: string): Promise<string | undefined>;
  set(accountKey: string, password: string): Promise<void>;
}

const SERVICE = "Claude Desktop Bridge assistant-mail";

/** Capture Keychain output locally. Never forward process errors, stderr or command input. */
function security(args: string[], input?: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on("error", () => reject(new Error("mail_credentials_unavailable")));
    child.stdin.on("error", () => reject(new Error("mail_credentials_unavailable")));
    child.on("close", (code) => resolve({ code, output: Buffer.concat(chunks).toString("utf8") }));
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
    const result = await security(["find-generic-password", "-s", SERVICE, "-a", accountKey, "-w"]);
    if (result.code === 44) return undefined;
    if (result.code !== 0) throw new Error("mail_credentials_unavailable");
    // security appends one LF; preserve any newline bytes belonging to the password.
    return result.output.replace(/\n$/, "");
  }

  async set(accountKey: string, password: string): Promise<void> {
    if (!this.supported) throw new Error("mail_credentials_unsupported");
    // security's interactive parser has a 4096-byte line buffer. The account key is a host-generated hash.
    const command = `add-generic-password -U -s "${SERVICE}" -a ${accountKey} -X ${Buffer.from(password).toString("hex")}\n`;
    if (Buffer.byteLength(command) >= 4096) throw new Error("mail_password_too_long");
    const result = await security(["-i"], command);
    if (result.code !== 0) throw new Error("mail_credentials_unavailable");
  }
}
