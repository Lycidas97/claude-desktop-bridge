import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Preview tools may run --serve without launching a browser. Only this debug
// mode accepts a fixed port; the automated suite always binds random ports.
export const serve = process.argv.includes("--serve");
export const remotePreview = serve && process.argv.includes("--remote-execution-preview");
export const projectGroupingPreview = serve && !remotePreview && process.argv.includes("--project-grouping-preview");
export const sectionCreatePreview = serve && !remotePreview && process.argv.includes("--section-create-preview");
export const nativePromptsPreview = serve && !remotePreview && process.argv.includes("--native-prompts-preview");
export const assistantMailPreview = serve && process.argv.includes("--assistant-mail-preview");
export const nativePreview = serve && !remotePreview && (assistantMailPreview || sectionCreatePreview || projectGroupingPreview || nativePromptsPreview || process.argv.includes("--native-permissions-preview"));
export const sessionId = "browser-e2e-session";
export const originalTitle = remotePreview ? "远程执行交接预览" : "隔离回归会话";
export const renamedTitle = "隔离回归新名称";
export const userText = "只发送一次的隔离测试消息";
export const recoveredText = "断线期间积累的固定回复";
export const replyText = "审批后完成的固定回复";
