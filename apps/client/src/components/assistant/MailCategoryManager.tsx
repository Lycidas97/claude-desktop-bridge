import { MAIL_CATEGORY_LABEL_MAX, MAIL_JUNK_CATEGORY_ID, type BridgeMailCategoryChange, type BridgeMailCategoryEntry } from "@bridge/protocol";
import { Folder, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { mailResult, type AssistantRequest } from "./AssistantMailProvider.js";

export function MailCategoryManager({ categories, mobile, online, request }: {
  categories: readonly BridgeMailCategoryEntry[]; mobile: boolean; online: boolean; request: AssistantRequest;
}) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<{ category?: BridgeMailCategoryEntry; label: string }>();
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formId = useId();
  const list = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (open && mobile) return registerMobileBackHandler(() => {
      if (!busy) {
        if (deleting) setDeleting(false);
        else if (editor) setEditor(undefined);
        else setOpen(false);
        setError("");
      }
      return true;
    }, 150);
  }, [busy, deleting, Boolean(editor), mobile, open]);

  useEffect(() => {
    if (open && !editor && returnTo.current !== undefined) {
      const target = Array.from(list.current?.querySelectorAll("button") ?? []).find(button => button.value === returnTo.current);
      (target ?? list.current?.querySelector("button"))?.focus();
      returnTo.current = undefined;
    }
  }, [editor, open]);

  async function save(change: BridgeMailCategoryChange) {
    setBusy(true); setError("");
    try {
      mailResult(await request("plugin.assistant-mail.category.change", change));
      if (change.action === "delete") returnTo.current = "";
      setDeleting(false);
      setEditor(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法更新邮件分类。");
    } finally { setBusy(false); }
  }

  const category = editor?.category;
  return <>
    <button type="button" className="assistant-session-link assistant-mail-manage-categories" aria-haspopup="dialog" disabled={!online}
      onClick={event => { event.currentTarget.focus(); setEditor(undefined); setError(""); setOpen(true); }}>管理分类</button>
    {open && <Sheet title={editor ? category ? "重命名分类" : "新建分类" : "管理分类"} manageFocus busy={busy}
      focusPaused={deleting} onClose={() => setOpen(false)} footer={editor && <>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setError(""); setEditor(undefined); }}>返回分类</button>
        <button type="submit" form={formId} className="primary-button" disabled={!online || busy || !editor.label.trim()}>保存</button>
      </>}>
      {editor ? <form id={formId} className="assistant-mail-category-form" onSubmit={event => {
        event.preventDefault();
        void save(category ? { action: "rename", id: category.id, label: editor.label } : { action: "add", label: editor.label });
      }}>
        <label>分类名称<input autoFocus value={editor.label} maxLength={MAIL_CATEGORY_LABEL_MAX} required disabled={busy}
          onChange={event => setEditor({ ...editor, label: event.target.value })} /></label>
        {category && category.id !== MAIL_JUNK_CATEGORY_ID && <button type="button" className="assistant-session-link assistant-mail-category-delete"
          disabled={!online || busy} onClick={() => { setError(""); setDeleting(true); }}>删除分类</button>}
        {error && !deleting && <p role="alert">{error}</p>}
      </form> : <div className="m-group assistant-mail-category-list" ref={list}>
        <SheetAction icon={<Plus size={18} />} label="新建分类" disabled={!online} onClick={() => {
          returnTo.current = "";
          setEditor({ label: "" });
        }} />
        {categories.map(entry => <SheetAction key={entry.id} value={entry.id} icon={<Folder size={18} />} label={entry.label}
          aria-label={`编辑分类「${entry.label}」`} disabled={!online} onClick={() => {
            returnTo.current = entry.id;
            setEditor({ category: entry, label: entry.label });
          }} />)}
      </div>}
    </Sheet>}
    {category && <ConfirmationDialog open={deleting} title={`删除「${category.label}」？`} description="分类里的邮件会移回收件箱，原信不会删除。"
      danger confirmLabel="删除分类" busy={busy} confirmDisabled={!online} error={error}
      onCancel={() => { setError(""); setDeleting(false); }} onConfirm={() => void save({ action: "delete", id: category.id })} />}
  </>;
}
