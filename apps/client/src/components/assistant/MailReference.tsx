import { X } from "lucide-react";
import { IconButton } from "../common/IconButton.js";
import { useAssistantMail } from "./AssistantMailProvider.js";
import "./assistant-mail.css";

export function MailReference({ sessionId }: { sessionId: string }) {
  const mail = useAssistantMail();
  if (!mail?.selectedMail || mail.assistant?.binding?.nativeSessionId !== sessionId) return null;
  return <aside className="assistant-mail-reference" aria-label="当前邮件引用">
    <div><span>邮件引用</span><strong>{mail.selectedMail.subject || "无主题"}</strong><code>{mail.selectedMail.mailRefId}</code></div>
    <IconButton label="清除邮件引用" onClick={mail.clearReference}><X size={17} /></IconButton>
    {!mail.canReference && <p role="alert">当前电脑不支持邮件引用，请先清除引用。</p>}
  </aside>;
}
