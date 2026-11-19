package com.localbridge.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import org.json.JSONException;

@CapacitorPlugin(name = "BridgeFiles")
public class BridgeFilesPlugin extends Plugin {
    private String pendingSaveId;
    private JSArray pendingSaveChunks;

    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name");
        JSArray chunks = call.getArray("chunks");
        if (name == null || name.trim().isEmpty() || name.contains("/") || name.contains("\\") || chunks == null) {
            call.reject("附件保存参数无效");
            return;
        }
        // Capacitor serializes the saved call to the Activity state Bundle.
        call.getData().remove("chunks");
        getBridge().executeOnMainThread(() -> {
            if (pendingSaveId != null) {
                call.reject("请先完成当前附件的保存");
                return;
            }
            pendingSaveId = call.getCallbackId();
            pendingSaveChunks = chunks;
            try {
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/octet-stream")
                    .putExtra(Intent.EXTRA_TITLE, name);
                startActivityForResult(call, save, "saveResult");
            } catch (ActivityNotFoundException error) {
                pendingSaveId = null;
                pendingSaveChunks = null;
                call.reject("无法选择附件保存位置", error);
            }
        });
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (!call.getCallbackId().equals(pendingSaveId)) {
            call.reject("附件保存已中断，请重新下载");
            return;
        }
        JSArray chunks = pendingSaveChunks;
        pendingSaveId = null;
        pendingSaveChunks = null;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.resolve();
            return;
        }
        Uri destination = result.getData() == null ? null : result.getData().getData();
        if (destination == null) {
            call.reject("未选择附件保存位置");
            return;
        }
        getBridge().execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IOException("保存位置不可写入");
                for (int index = 0; index < chunks.length(); index++) {
                    output.write(Base64.decode(chunks.getString(index), Base64.DEFAULT));
                }
            } catch (IOException | JSONException | IllegalArgumentException | SecurityException error) {
                call.reject("无法保存附件", error);
                return;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("缺少下载文件路径");
            return;
        }

        try {
            Context context = getContext();
            File cache = context.getCacheDir().getCanonicalFile();
            File downloads = new File(cache, "bridge-evidence");
            File file = new File(cache, path).getCanonicalFile();
            if (!file.toPath().startsWith(downloads.toPath()) || !file.isFile()) {
                call.reject("下载文件不在缓存中");
                return;
            }

            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            String mimeType = call.getString("mimeType");
            if (mimeType == null || "application/octet-stream".equals(mimeType)) {
                mimeType = context.getContentResolver().getType(uri);
            }
            Intent view = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, mimeType)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (view.resolveActivity(context.getPackageManager()) == null) {
                call.reject("没有可打开此文件的应用。请安装支持该文件类型的应用后重新下载。");
                return;
            }
            getActivity().startActivity(Intent.createChooser(view, "选择打开方式")
                .putExtra(Intent.EXTRA_AUTO_LAUNCH_SINGLE_CHOICE, false));
            call.resolve();
        } catch (IOException | ActivityNotFoundException error) {
            call.reject("无法打开下载文件", error);
        }
    }
}
