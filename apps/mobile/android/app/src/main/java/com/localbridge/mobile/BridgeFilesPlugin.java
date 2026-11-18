package com.localbridge.mobile;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;

@CapacitorPlugin(name = "BridgeFiles")
public class BridgeFilesPlugin extends Plugin {
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
            getActivity().startActivity(Intent.createChooser(view, "选择打开方式")
                .putExtra(Intent.EXTRA_AUTO_LAUNCH_SINGLE_CHOICE, false));
            call.resolve();
        } catch (IOException | ActivityNotFoundException error) {
            call.reject("无法打开下载文件", error);
        }
    }
}
