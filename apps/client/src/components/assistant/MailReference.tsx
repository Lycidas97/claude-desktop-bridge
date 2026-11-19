import { Mail, X } from "lucide-react";
import { IconButton } from "../common/IconButton.js";
import { useAssistantMail } from "./AssistantMailProvider.js";
import "./assistant-mail.css";

export function MailReference({ sessionId }: { sessionId: string }) {
  const mail = useAssistantMail();
  if (!mail?.selectedMail || mail.assistant?.binding?.nativeSessionId !== sessionId) return null;
  const subject = mail.selectedMail.subject || "无主题";
  const [sender] = mail.selectedMail.from;
  const senderLabel = sender?.name || sender?.address || "未知发件人";
  return <aside className="assistant-mail-reference" aria-label="当前邮件引用">
    <Mail size={16} aria-hidden="true" />
    <div className="assistant-mail-reference-summary">
      <strong title={subject}>{subject}</strong>
      <span title={senderLabel}>{senderLabel}</span>
    </div>
    <IconButton label="清除邮件引用" onClick={mail.clearReference}><X size={17} aria-hidden="true" /></IconButton>
    {!mail.canReference && <p role="alert">当前电脑不支持邮件引用，请先清除引用。</p>}
  </aside>;
}
