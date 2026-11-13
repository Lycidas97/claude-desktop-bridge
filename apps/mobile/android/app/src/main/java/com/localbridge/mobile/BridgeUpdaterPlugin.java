package com.localbridge.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "BridgeUpdater")
public class BridgeUpdaterPlugin extends Plugin {
    private static final String DEFAULT_RELEASES_URL =
        "https://api.github.com/repos/Lycidas97/claude-desktop-bridge/releases?per_page=10";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private static final long MAX_APK_BYTES = 250L * 1024L * 1024L;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        try {
            Context context = getContext();
            PackageManager pm = context.getPackageManager();
            PackageInfo pkgInfo = getOwnPackageInfo(pm, context.getPackageName());
            JSObject ret = new JSObject();
            ret.put("versionName", pkgInfo.versionName != null ? pkgInfo.versionName : "0.0.0");
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? pkgInfo.getLongVersionCode()
                : pkgInfo.versionCode;
            ret.put("versionCode", versionCode);
            ret.put("packageName", context.getPackageName());
            ret.put("canInstallPackages", pm.canRequestPackageInstalls());
            ret.put("arch", resolveDeviceArch());
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("读取应用版本信息失败: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void fetchReleasesJson(PluginCall call) {
        final String feedUrl = call.getString("url", DEFAULT_RELEASES_URL);
        final String etag = call.getString("etag");
        if (!isAllowedUrl(feedUrl)) {
            call.reject("不允许的更新检查地址");
            return;
        }
        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                Map<String, String> headers = new HashMap<>();
                headers.put("Accept", "application/vnd.github+json");
                headers.put("X-GitHub-Api-Version", "2022-11-28");
                if (etag != null && !etag.isEmpty()) {
                    headers.put("If-None-Match", etag);
                }
                conn = openGetConnection(feedUrl, headers);
                int status = conn.getResponseCode();
                JSObject ret = new JSObject();
                ret.put("status", status);
                String nextEtag = conn.getHeaderField("ETag");
                if (nextEtag != null && !nextEtag.isEmpty()) {
                    ret.put("etag", nextEtag);
                }
                if (status == HttpURLConnection.HTTP_NOT_MODIFIED) {
                    call.resolve(ret);
                    return;
                }
                if (status < 200 || status >= 300) {
                    call.reject("检查更新失败（HTTP " + status + "）");
                    return;
                }
                try (InputStream in = conn.getInputStream();
                     ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[16 * 1024];
                    int total = 0;
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        total += read;
                        if (total > MAX_JSON_BYTES) {
                            call.reject("Release 响应超过大小上限");
                            return;
                        }
                        out.write(buffer, 0, read);
                    }
                    ret.put("body", out.toString(StandardCharsets.UTF_8.name()));
                    call.resolve(ret);
                }
            } catch (Exception ex) {
                call.reject("检查更新网络请求失败: " + ex.getMessage(), ex);
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void downloadAndVerifyApk(PluginCall call) {
        final String downloadUrl = call.getString("url");
        final String version = call.getString("version", "");
        final String expectedSha256 = call.getString("expectedSha256", "").trim().toLowerCase(Locale.ROOT);
        final Long expectedSizeObj = call.getLong("expectedSize");
        final long expectedSize = expectedSizeObj != null ? expectedSizeObj : -1L;

        if (downloadUrl == null || !isAllowedUrl(downloadUrl)) {
            call.reject("不允许的 APK 下载地址");
            return;
        }
        if (version.isEmpty()) {
            call.reject("缺少目标版本号");
            return;
        }

        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                Context context = getContext();
                PackageManager pm = context.getPackageManager();
                File updatesDir = new File(context.getCacheDir(), "updates");
                if (!updatesDir.exists() && !updatesDir.mkdirs()) {
                    call.reject("无法创建更新缓存目录");
                    return;
                }
                File targetApk = new File(updatesDir, "bridge-update.apk");
                File metaFile = new File(updatesDir, "bridge-update.meta");
                File partApk = new File(updatesDir, "bridge-update.apk.part");

                // Reuse already downloaded & verified APK when version + sha256 match
                if (targetApk.isFile() && metaFile.isFile()) {
                    String cachedMeta = new String(Files.readAllBytes(metaFile.toPath()), StandardCharsets.UTF_8);
                    String[] lines = cachedMeta.split("\n");
                    if (lines.length >= 2 && version.equals(lines[0].trim())) {
                        String cachedSha = lines[1].trim().toLowerCase(Locale.ROOT);
                        if ((expectedSha256.isEmpty() || expectedSha256.equals(cachedSha))
                            && verifyArchivePackageName(pm, targetApk.getAbsolutePath(), context.getPackageName())) {
                            JSObject cachedRet = new JSObject();
                            cachedRet.put("staged", true);
                            cachedRet.put("reusedCache", true);
                            cachedRet.put("sha256", cachedSha);
                            cachedRet.put("bytes", targetApk.length());
                            cachedRet.put("canInstallPackages", pm.canRequestPackageInstalls());
                            call.resolve(cachedRet);
                            return;
                        }
                    }
                }

                conn = openGetConnection(downloadUrl, Collections.emptyMap());
                int status = conn.getResponseCode();
                if (status < 200 || status >= 300) {
                    call.reject("下载安装包失败（HTTP " + status + "）");
                    return;
                }
                long contentLength = conn.getContentLengthLong();
                long totalBytes = contentLength > 0 ? contentLength : expectedSize;
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long downloaded = 0L;
                long lastEmitAt = 0L;

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(partApk, false)) {
                    byte[] buffer = new byte[32 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        downloaded += read;
                        if (downloaded > MAX_APK_BYTES) {
                            call.reject("APK 大小超过安全上限");
                            return;
                        }
                        digest.update(buffer, 0, read);
                        out.write(buffer, 0, read);
                        long now = System.currentTimeMillis();
                        if (now - lastEmitAt >= 150) {
                            lastEmitAt = now;
                            emitProgress(downloaded, totalBytes);
                        }
                    }
                    out.getFD().sync();
                }

                emitProgress(downloaded, totalBytes > 0 ? totalBytes : downloaded);

                if (expectedSize > 0 && downloaded != expectedSize) {
                    call.reject("安装包字节数不匹配（预期 " + expectedSize + "，实际 " + downloaded + "）");
                    return;
                }

                String actualSha256 = toHex(digest.digest());
                if (!expectedSha256.isEmpty() && !expectedSha256.equals(actualSha256)) {
                    call.reject("安装包 SHA-256 校验未通过");
                    return;
                }

                if (!verifyArchivePackageName(pm, partApk.getAbsolutePath(), context.getPackageName())) {
                    call.reject("APK 包名校验未通过，已拒绝安装");
                    return;
                }

                Files.move(partApk.toPath(), targetApk.toPath(), StandardCopyOption.REPLACE_EXISTING);
                String metaPayload = version + "\n" + actualSha256 + "\n";
                Files.write(metaFile.toPath(), metaPayload.getBytes(StandardCharsets.UTF_8));

                JSObject ret = new JSObject();
                ret.put("staged", true);
                ret.put("reusedCache", false);
                ret.put("sha256", actualSha256);
                ret.put("bytes", downloaded);
                ret.put("canInstallPackages", pm.canRequestPackageInstalls());
                call.resolve(ret);
            } catch (Exception ex) {
                call.reject("下载或校验安装包失败: " + ex.getMessage(), ex);
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void installStagedApk(PluginCall call) {
        try {
            Context context = getContext();
            PackageManager pm = context.getPackageManager();
            File targetApk = new File(new File(context.getCacheDir(), "updates"), "bridge-update.apk");
            if (!targetApk.isFile()) {
                call.reject("尚未准备好安装包，请先下载更新");
                return;
            }
            if (!verifyArchivePackageName(pm, targetApk.getAbsolutePath(), context.getPackageName())) {
                call.reject("缓存安装包校验无效，请重新下载");
                return;
            }
            if (!pm.canRequestPackageInstalls()) {
                Intent permIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.getPackageName())
                );
                permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(permIntent);
                JSObject permRet = new JSObject();
                permRet.put("launchedInstaller", false);
                permRet.put("needsPermission", true);
                call.resolve(permRet);
                return;
            }

            Uri apkUri = FileProvider.getUriForFile(
                context,
                context.getPackageName() + ".fileprovider",
                targetApk
            );
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(installIntent);

            JSObject ret = new JSObject();
            ret.put("launchedInstaller", true);
            ret.put("needsPermission", false);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("拉起系统安装器失败: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String rawUrl = call.getString("url");
        if (rawUrl == null || !rawUrl.startsWith("https://")) {
            call.reject("仅支持打开 HTTPS 链接");
            return;
        }
        try {
            Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(rawUrl));
            browserIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(browserIntent);
            call.resolve();
        } catch (Exception ex) {
            call.reject("无法打开外部链接: " + ex.getMessage(), ex);
        }
    }

    private void emitProgress(long downloadedBytes, long totalBytes) {
        JSObject payload = new JSObject();
        payload.put("downloadedBytes", downloadedBytes);
        if (totalBytes > 0) {
            payload.put("totalBytes", totalBytes);
        }
        notifyListeners("downloadProgress", payload);
    }

    private boolean isAllowedUrl(String rawUrl) {
        try {
            Uri uri = Uri.parse(rawUrl);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) return false;
            if ("https".equalsIgnoreCase(scheme)) {
                String lowerHost = host.toLowerCase(Locale.ROOT);
                return lowerHost.equals("api.github.com")
                    || lowerHost.equals("github.com")
                    || lowerHost.endsWith(".githubusercontent.com");
            }
            boolean debuggable = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            if (debuggable && "http".equalsIgnoreCase(scheme)) {
                return "127.0.0.1".equals(host) || "10.0.2.2".equals(host) || "localhost".equals(host);
            }
            return false;
        } catch (Exception ignored) {
            return false;
        }
    }

    private HttpURLConnection openGetConnection(String targetUrl, Map<String, String> headers) throws Exception {
        String current = targetUrl;
        for (int redirectCount = 0; redirectCount < 5; redirectCount++) {
            URL url = new URL(current);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", "ClaudeDesktopBridge-AndroidUpdater");
            for (Map.Entry<String, String> header : headers.entrySet()) {
                conn.setRequestProperty(header.getKey(), header.getValue());
            }
            int status = conn.getResponseCode();
            if (status == HttpURLConnection.HTTP_MOVED_PERM
                || status == HttpURLConnection.HTTP_MOVED_TEMP
                || status == HttpURLConnection.HTTP_SEE_OTHER
                || status == 307
                || status == 308) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null || location.isEmpty()) {
                    throw new IllegalStateException("重定向缺少 Location 头");
                }
                URL nextUrl = new URL(url, location);
                String resolved = nextUrl.toString();
                if (!isAllowedUrl(resolved)) {
                    throw new SecurityException("拒绝重定向至非授信域名: " + nextUrl.getHost());
                }
                current = resolved;
                continue;
            }
            return conn;
        }
        throw new IllegalStateException("更新请求重定向次数过多");
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo getOwnPackageInfo(PackageManager pm, String packageName)
        throws PackageManager.NameNotFoundException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return pm.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0));
        }
        return pm.getPackageInfo(packageName, 0);
    }

    @SuppressWarnings("deprecation")
    private static boolean verifyArchivePackageName(PackageManager pm, String archivePath, String expectedPackage) {
        PackageInfo info = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? pm.getPackageArchiveInfo(archivePath, PackageManager.PackageInfoFlags.of(0))
            : pm.getPackageArchiveInfo(archivePath, 0);
        return info != null && expectedPackage.equals(info.packageName);
    }

    private static String resolveDeviceArch() {
        String[] abis = Build.SUPPORTED_ABIS;
        if (abis != null) {
            for (String abi : abis) {
                if ("arm64-v8a".equalsIgnoreCase(abi)) return "arm64";
                if ("x86_64".equalsIgnoreCase(abi)) return "x64";
                if ("armeabi-v7a".equalsIgnoreCase(abi)) return "arm";
            }
        }
        return "arm64";
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        }
        return sb.toString();
    }
}
