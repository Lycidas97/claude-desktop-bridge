package com.localbridge.mobile;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "BridgeIncomingFile")
public class BridgeIncomingFilePlugin extends Plugin {
    private static final int MAX_BYTES = 20 * 1024 * 1024;
    private static final int CHUNK_BYTES = 128 * 1024;
    private static final String UNREADABLE = "无法读取文件，请在原应用中重新打开";
    private static final String CLOSED = "文件已关闭，请在原应用中重新打开";
    private static final String TOO_LARGE = "单个文件不能超过 20 MiB";

    // A blocked provider read must not occupy the Capacitor plugin thread or
    // prevent cancellation and loading the next file.
    private final ExecutorService fileIo = Executors.newFixedThreadPool(3);
    private Source source;
    private JSObject pending;
    private PluginCall reading;

    static boolean accepts(Intent intent) {
        return intent != null && (Intent.ACTION_SEND.equals(intent.getAction()) ||
            (Intent.ACTION_VIEW.equals(intent.getAction()) && ContentResolver.SCHEME_CONTENT.equals(intent.getScheme())));
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (!accepts(intent)) return;
        getBridge().execute(() -> {
            clearFile();
            Uri candidate = Intent.ACTION_VIEW.equals(intent.getAction()) ? intent.getData()
                : IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            ClipData clip = intent.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri item = clip.getItemAt(i).getUri();
                    if (item == null) continue;
                    if (candidate == null) candidate = item;
                    else if (!candidate.equals(item)) {
                        publishError("一次只能导入一个文件");
                        return;
                    }
                }
            }
            if (candidate == null || !ContentResolver.SCHEME_CONTENT.equals(candidate.getScheme())) {
                publishError("没有可导入的文件");
                return;
            }
            if ((getContext().getPackageName() + ".fileprovider").equals(candidate.getAuthority()) ||
                getContext().checkUriPermission(candidate, Process.myPid(), Process.myUid(),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
                publishError(UNREADABLE);
                return;
            }
            Source next = new Source(candidate);
            source = next;
            fileIo.execute(() -> {
                JSObject metadata = next.describe(getContext().getContentResolver(), intent.getType());
                getBridge().execute(() -> {
                    if (source == next) publish(metadata);
                });
            });
        });
    }

    @PluginMethod
    public void getPendingFile(PluginCall call) {
        call.resolve(new JSObject().put("file", pending));
    }

    @PluginMethod
    public void readFileChunk(PluginCall call) {
        Source current = source;
        if (current == null || !current.id.equals(call.getString("id")) || pending == null || pending.has("error")) {
            call.reject(CLOSED);
            return;
        }
        if (reading != null) {
            call.reject("文件正在读取");
            return;
        }
        reading = call;
        fileIo.execute(() -> {
            try {
                JSObject chunk = current.readChunk(getContext().getContentResolver());
                getBridge().execute(() -> {
                    if (source != current) return;
                    reading = null;
                    if (chunk.has("done")) clearFile();
                    if (chunk.has("error")) {
                        clearFile();
                        call.reject(TOO_LARGE);
                    } else {
                        call.resolve(chunk);
                    }
                });
            } catch (IOException | SecurityException | IllegalArgumentException | OperationCanceledException error) {
                getBridge().execute(() -> {
                    if (source != current) return;
                    reading = null;
                    clearFile();
                    call.reject(UNREADABLE, error);
                });
            }
        });
    }

    @PluginMethod
    public void discardFile(PluginCall call) {
        if (pending != null && pending.getString("id").equals(call.getString("id"))) clearFile();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        getBridge().execute(() -> {
            clearFile();
            fileIo.shutdown();
        });
    }

    private void publishError(String message) {
        publish(new JSObject().put("id", UUID.randomUUID().toString()).put("error", message));
    }

    private void publish(JSObject metadata) {
        pending = metadata;
        notifyListeners("fileReceived", metadata);
    }

    private void clearFile() {
        Source previous = source;
        source = null;
        pending = null;
        if (reading != null) {
            reading.reject(CLOSED);
            reading = null;
        }
        if (previous != null) fileIo.execute(previous::close);
    }

    private static final class Source {
        final String id = UUID.randomUUID().toString();
        final Uri uri;
        final CancellationSignal cancellation = new CancellationSignal();
        private InputStream stream;
        private boolean closed;
        private int bytesRead;

        Source(Uri uri) {
            this.uri = uri;
        }

        JSObject describe(ContentResolver resolver, String mimeType) {
            JSObject metadata = new JSObject().put("id", id);
            try (Cursor cursor = resolver.query(uri,
                new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null, cancellation)) {
                String name = null;
                if (cursor != null && cursor.moveToFirst()) {
                    int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (nameColumn >= 0) name = cursor.getString(nameColumn);
                    int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (sizeColumn >= 0 && cursor.getLong(sizeColumn) > MAX_BYTES) metadata.put("error", TOO_LARGE);
                }
                metadata.put("name", name == null || name.trim().isEmpty() ? "导入文件" : name);
                metadata.put("mimeType", mimeType == null || mimeType.contains("*") ? "application/octet-stream" : mimeType);
            } catch (SecurityException | IllegalArgumentException | OperationCanceledException error) {
                metadata.put("error", UNREADABLE);
            }
            return metadata;
        }

        JSObject readChunk(ContentResolver resolver) throws IOException {
            InputStream input;
            synchronized (this) {
                if (closed) throw new IOException(CLOSED);
                input = stream;
            }
            if (input == null) {
                AssetFileDescriptor descriptor = resolver.openAssetFileDescriptor(uri, "r", cancellation);
                if (descriptor == null) throw new IOException(UNREADABLE);
                try {
                    input = descriptor.createInputStream();
                } catch (IOException error) {
                    descriptor.close();
                    throw error;
                }
                synchronized (this) {
                    if (closed) {
                        input.close();
                        throw new IOException(CLOSED);
                    }
                    stream = input;
                }
            }
            byte[] buffer = new byte[Math.min(CHUNK_BYTES, MAX_BYTES - bytesRead + 1)];
            int count = 0;
            while (count < buffer.length) {
                int length = input.read(buffer, count, buffer.length - count);
                if (length == -1) break;
                count += length;
            }
            if (count == 0) return new JSObject().put("done", true);
            if ((bytesRead += count) > MAX_BYTES) return new JSObject().put("error", TOO_LARGE);
            return new JSObject().put("data", Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP));
        }

        void close() {
            InputStream input;
            synchronized (this) {
                closed = true;
                input = stream;
                stream = null;
            }
            cancellation.cancel();
            if (input != null) {
                try {
                    input.close();
                } catch (IOException error) {
                    Log.w("BridgeIncomingFile", "Unable to close shared file stream", error);
                }
            }
        }
    }
}
