import { createTransport, type NodemailerError, type SMTPSentMessageInfo, type SMTPTransportOptions, type Transporter } from "nodemailer";
import type { BridgeSmtpChannel } from "../../packages/protocol/src/assistant-mail.js";
import type { MailSendFailure } from "../../packages/protocol/src/assistant-proposal.js";

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
  | { state: "failed" | "delivery_uncertain"; failure: MailSendFailure };

export async function submitSmtp(channel: BridgeSmtpChannel, password: string, message: SmtpMessage, messageId: string,
  transport: (options: SMTPTransportOptions) => Pick<Transporter<SMTPSentMessageInfo>, "sendMail" | "close"> = createTransport): Promise<SmtpResult> {
  const secure = channel.security === "tls";
  let terminatorQueued = false;
  const client = transport({ host: channel.host, port: channel.port, secure, requireTLS: !secure, forceAuth: true,
    auth: { user: channel.user, pass: password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    // Nodemailer's DATA stream emits byte counts after piping the terminating dot to the socket.
    // Observe only that boundary; do not log the message, SMTP traffic or credentials.
    logger: { info(entry: { tnx?: string; outByteCount?: number }) {
      if (entry.tnx === "message" && entry.outByteCount !== undefined) terminatorQueued = true;
    } } });
  try {
    const { accepted, rejected } = await client.sendMail({
      from: message.from, to: message.to, cc: message.cc, subject: message.subject, text: message.bodyText,
      replyTo: message.replyTo, inReplyTo: message.inReplyTo, references: message.references, messageId,
      envelope: { from: message.from, to: [...message.to, ...message.cc] },
    });
    return { state: rejected.length ? "delivery_partial" : "applied", accepted, rejected };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    const { code, originalCode, responseCode, timeoutType } = error as NodemailerError;
    const response = responseCode !== undefined && Number.isInteger(responseCode) && responseCode >= 200 && responseCode < 600
      ? { responseCode } : {};
    if (code === "EAUTH" || code === "ENOAUTH") return { state: "failed", failure: { reason: "auth", ...response } };
    if (code === "ETLS" || timeoutType === "UPGRADE_TIMEOUT" ||
      (!terminatorQueued && originalCode && /^(?:ERR_(?:SSL|TLS)_|CERT_|(?:DEPTH_ZERO_)?SELF_SIGNED_CERT|UNABLE_TO_(?:VERIFY_LEAF_SIGNATURE|GET_ISSUER_CERT))/u.test(originalCode))) {
      return { state: "failed", failure: { reason: "tls", ...response } };
    }
    if (code === "EENVELOPE" || (code === "EMESSAGE" && (response.responseCode ?? 0) >= 400)) {
      return { state: "failed", failure: { reason: "rejected", ...response } };
    }
    if (code === "EDNS" || code === "ESOCKET" || code === "ETIMEDOUT" || code === "ECONNECTION" || code === "EPROTOCOL" || code === "EMESSAGE") {
      return terminatorQueued ? { state: "delivery_uncertain", failure: { reason: "unconfirmed", ...response } }
        : { state: "failed", failure: { reason: "connection", ...response } };
    }
    throw error;
  } finally {
    client.close();
  }
}
