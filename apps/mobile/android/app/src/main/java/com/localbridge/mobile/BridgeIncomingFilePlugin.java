package com.localbridge.mobile;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Process;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.util.UUID;

@CapacitorPlugin(name = "BridgeIncomingFile")
public class BridgeIncomingFilePlugin extends Plugin {
    private static final int MAX_BYTES = 20 * 1024 * 1024;
    private static final int CHUNK_BYTES = 128 * 1024;
    private JSObject pending;
    private Uri uri;
    private InputStream stream;
    private int bytesRead;

    @Override
    protected void handleOnNewIntent(Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) return;

        // Plugin calls and the inbox run on the same Capacitor worker.
        getBridge().execute(() -> {
            clearFile();
            pending = new JSObject().put("id", UUID.randomUUID().toString());
            Uri candidate = Intent.ACTION_VIEW.equals(action) ? intent.getData()
                : IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            ClipData clip = intent.getClipData();
            boolean multiple = false;
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri item = clip.getItemAt(i).getUri();
                    if (item == null) continue;
                    if (candidate == null) candidate = item;
                    else if (!candidate.equals(item)) multiple = true;
                }
            }
            if (multiple) {
                pending.put("error", "一次只能导入一个文件");
            } else if (candidate == null || !ContentResolver.SCHEME_CONTENT.equals(candidate.getScheme())) {
                pending.put("error", "没有可导入的文件");
            } else if ((getContext().getPackageName() + ".fileprovider").equals(candidate.getAuthority()) ||
                getContext().checkUriPermission(candidate, Process.myPid(), Process.myUid(),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
                pending.put("error", "无法读取文件，请在原应用中重新打开");
            } else {
                ContentResolver resolver = getContext().getContentResolver();
                String name = null;
                try (Cursor cursor = resolver.query(candidate,
                    new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (nameColumn >= 0) name = cursor.getString(nameColumn);
                        int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (sizeColumn >= 0 && cursor.getLong(sizeColumn) > MAX_BYTES) {
                            pending.put("error", "单个文件不能超过 20 MiB");
                        }
                    }
                    String safeName = name == null ? "" : name.replaceAll("[/\\\\\\p{Cc}]", "_").trim();
                    pending.put("name", safeName.isEmpty() || safeName.equals(".") || safeName.equals("..") ? "导入文件" : safeName);
                    String mimeType = intent.getType();
                    pending.put("mimeType", mimeType == null || mimeType.contains("*") ? "application/octet-stream" : mimeType);
                    uri = candidate;
                } catch (SecurityException | IllegalArgumentException error) {
                    pending.put("error", "无法读取文件，请在原应用中重新打开");
                }
            }
            notifyListeners("fileReceived", pending);
        });
    }

    @PluginMethod
    public void getPendingFile(PluginCall call) {
        call.resolve(new JSObject().put("file", pending));
    }

    @PluginMethod
    public void readFileChunk(PluginCall call) {
        if (uri == null || !pending.getString("id").equals(call.getString("id"))) {
            call.reject("文件已关闭，请在原应用中重新打开");
            return;
        }
        try {
            if (stream == null) stream = getContext().getContentResolver().openInputStream(uri);
            if (stream == null) throw new IOException("No stream for shared file");
            byte[] buffer = new byte[Math.min(CHUNK_BYTES, MAX_BYTES - bytesRead + 1)];
            int count = stream.read(buffer);
            if (count == -1) {
                clearFile();
                call.resolve(new JSObject().put("done", true));
            } else if ((bytesRead += count) > MAX_BYTES) {
                clearFile();
                call.reject("单个文件不能超过 20 MiB");
            } else {
                call.resolve(new JSObject().put("data", Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)));
            }
        } catch (IOException | SecurityException | IllegalArgumentException error) {
            clearFile();
            call.reject("无法读取文件，请在原应用中重新打开", error);
        }
    }

    @PluginMethod
    public void discardFile(PluginCall call) {
        if (pending != null && pending.getString("id").equals(call.getString("id"))) clearFile();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        getBridge().execute(this::clearFile);
    }

    private void clearFile() {
        if (stream != null) {
            try {
                stream.close();
            } catch (IOException error) {
                Log.w("BridgeIncomingFile", "Unable to close shared file stream", error);
            }
        }
        stream = null;
        pending = null;
        uri = null;
        bytesRead = 0;
    }
}
