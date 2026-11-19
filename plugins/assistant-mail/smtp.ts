import { createTransport, type NodemailerError, type SMTPSentMessageInfo, type SMTPTransportOptions, type Transporter } from "nodemailer";
import type { BridgeSmtpChannel } from "../../packages/protocol/src/assistant-mail.js";

export interface SmtpMessage {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
}

export type SmtpResult =
  | { state: "applied" | "delivery_partial"; accepted: string[]; rejected: string[] }
  | { state: "failed" | "delivery_uncertain"; responseCode?: number };

export async function submitSmtp(channel: BridgeSmtpChannel, password: string, message: SmtpMessage, messageId: string,
  transport: (options: SMTPTransportOptions) => Pick<Transporter<SMTPSentMessageInfo>, "sendMail" | "close"> = createTransport): Promise<SmtpResult> {
  const secure = channel.security === "tls";
  const client = transport({ host: channel.host, port: channel.port, secure, requireTLS: !secure, forceAuth: true,
    auth: { user: channel.user, pass: password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
  try {
    const { accepted, rejected } = await client.sendMail({
      from: message.from, to: message.to, cc: message.cc, subject: message.subject, text: message.bodyText,
      replyTo: message.replyTo, inReplyTo: message.inReplyTo, references: message.references, messageId,
      envelope: { from: message.from, to: [...message.to, ...message.cc] },
    });
    return { state: rejected.length ? "delivery_partial" : "applied", accepted, rejected };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    const { code, command, responseCode } = error as NodemailerError;
    const response = responseCode !== undefined ? { responseCode } : {};
    const rejected = responseCode !== undefined && responseCode >= 400 && responseCode < 600;
    if (code === "EAUTH" || code === "ENOAUTH" || code === "EDNS" || code === "EENVELOPE" || code === "ETLS" ||
      (rejected && (code === "EMESSAGE" || (code === "EPROTOCOL" && command === "CONN")))) {
      return { state: "failed", ...response };
    }
    // A socket failure or non-final DATA reply cannot prove whether the server accepted the message.
    if (code === "ESOCKET" || code === "ETIMEDOUT" || code === "ECONNECTION" || code === "EPROTOCOL" || code === "EMESSAGE") {
      return { state: "delivery_uncertain", ...response };
    }
    throw error;
  } finally {
    client.close();
  }
}
