import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

type IncomingFile = { id: string } & ({ name: string; mimeType: string } | { error: string; name?: string });
type ReadableIncomingFile = Extract<IncomingFile, { mimeType: string }>;

const incomingFile = registerPlugin<{
  addListener(event: "fileReceived", listener: (file: IncomingFile) => void): Promise<PluginListenerHandle>;
  getPendingFile(): Promise<{ file?: IncomingFile }>;
  readFileChunk(options: { id: string }): Promise<{ data: string } | { done: true }>;
  discardFile(options: { id: string }): Promise<void>;
}>("BridgeIncomingFile");

export function observeIncomingFiles(
  onFile: (file: IncomingFile) => void,
  onError: (error: unknown) => void,
): (() => void) | undefined {
  if (Capacitor.getPlatform() !== "android" || !Capacitor.isPluginAvailable("BridgeIncomingFile")) return;
  let active = true;
  let lastId: string | undefined;
  const receive = (file: IncomingFile) => {
    if (!active || file.id === lastId) return;
    lastId = file.id;
    onFile(file);
  };
  const listener = incomingFile.addListener("fileReceived", receive);
  void listener.then(async () => {
    if (!active) return;
    const { file } = await incomingFile.getPendingFile();
    if (file) receive(file);
  }).catch((error: unknown) => { if (active) onError(error); });
  return () => {
    active = false;
    void listener.then((handle) => handle.remove(), () => undefined);
  };
}

export async function readIncomingFile({ id, name, mimeType }: ReadableIncomingFile): Promise<File> {
  const parts: BlobPart[] = [];
  while (true) {
    const result = await incomingFile.readFileChunk({ id });
    if ("done" in result) {
      let basename = name.replace(/[<>:"/\\|?*\p{Cc}]/gu, "_").replace(/[. ]+$/u, "") || "导入文件";
      if (/^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³]) *(?:\.|$)/iu.test(basename)) basename = `_${basename}`;
      return new File(parts, basename, { type: mimeType });
    }
    parts.push(Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0)));
  }
}

export function discardIncomingFile(id: string): Promise<void> {
  return incomingFile.discardFile({ id });
}
