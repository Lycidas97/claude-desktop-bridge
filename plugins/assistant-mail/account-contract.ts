import { z } from "zod";

export const mailAccountKey = z.string().regex(/^[a-f0-9]{64}$/u);
export const mailbox = z.email({ pattern: z.regexes.html5Email }).max(254).transform(address => {
  const at = address.lastIndexOf("@");
  return address.slice(0, at + 1) + address.slice(at + 1).toLowerCase();
});

export const smtpChannel = z.strictObject({ host: z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/u),
  port: z.number().int().min(1).max(65535), security: z.enum(["tls", "starttls"]),
  user: z.string().trim().min(1).max(300), from: mailbox });
export const sharedSmtpChannel = smtpChannel.omit({ user: true });
const sharedMailSettings = { credential: z.string().refine(value => value.trim() !== ""), smtp: sharedSmtpChannel.optional() };
export const saveMailAccount = z.union([
  z.strictObject({ host: z.string().trim().min(1).regex(/^\S+$/u), port: z.number().int().min(1).max(65535).optional(),
    user: z.string().trim().min(1), ...sharedMailSettings }),
  z.strictObject({ accountKey: mailAccountKey, ...sharedMailSettings }),
  z.strictObject({ accountKey: mailAccountKey, smtp: sharedSmtpChannel }),
]);
export const configureSmtp = z.strictObject({ accountKey: mailAccountKey,
  smtp: smtpChannel.extend({ credential: z.string().min(1).max(1800) }).nullable() });
