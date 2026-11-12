import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm as recycle, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

createRequire(import.meta.url)('./recycle-cleanup.cjs');

// Compile the complete production plugin. Only Android/Capacitor APIs are stubbed;
// URL, HttpURLConnection, redirects, streams, files and SHA-256 are real JDK APIs.
const stubs = {
  'android/content/Context.java': `package android.content;
    public class Context {
      public android.content.pm.PackageManager getPackageManager() { return new android.content.pm.PackageManager(); }
      public String getPackageName() { return "com.localbridge.mobile"; }
      public java.io.File getCacheDir() { return new java.io.File(System.getProperty("fixture.cache")); }
      public android.content.pm.ApplicationInfo getApplicationInfo() { return new android.content.pm.ApplicationInfo(); }
      public void startActivity(Intent intent) { throw new UnsupportedOperationException(); }
    }`,
  'android/content/Intent.java': `package android.content;
    public class Intent {
      public static final String ACTION_VIEW = "view";
      public static final int FLAG_ACTIVITY_NEW_TASK = 1, FLAG_GRANT_READ_URI_PERMISSION = 2;
      public Intent(String action) {} public Intent(String action, android.net.Uri uri) {}
      public void addFlags(int flags) {} public void setDataAndType(android.net.Uri uri, String type) {}
    }`,
  'android/content/pm/ApplicationInfo.java': `package android.content.pm;
    public class ApplicationInfo { public static final int FLAG_DEBUGGABLE = 2; public int flags = FLAG_DEBUGGABLE; }`,
  'android/content/pm/PackageInfo.java': `package android.content.pm;
    public class PackageInfo {
      public String versionName = "1.0.0", packageName = "com.localbridge.mobile";
      public int versionCode = 1; public long getLongVersionCode() { return 1; }
    }`,
  'android/content/pm/PackageManager.java': `package android.content.pm;
    public class PackageManager {
      public static class NameNotFoundException extends Exception {}
      public static class PackageInfoFlags { public static PackageInfoFlags of(long flags) { return new PackageInfoFlags(); } }
      public boolean canRequestPackageInstalls() { return true; }
      public PackageInfo getPackageInfo(String name, int flags) throws NameNotFoundException { return new PackageInfo(); }
      public PackageInfo getPackageInfo(String name, PackageInfoFlags flags) throws NameNotFoundException { return new PackageInfo(); }
      public PackageInfo getPackageArchiveInfo(String path, int flags) { return new PackageInfo(); }
      public PackageInfo getPackageArchiveInfo(String path, PackageInfoFlags flags) { return new PackageInfo(); }
    }`,
  'android/net/Uri.java': `package android.net;
    public class Uri {
      private final java.net.URI uri;
      private Uri(String raw) { uri = java.net.URI.create(raw); }
      public static Uri parse(String raw) { return new Uri(raw); }
      public String getScheme() { return uri.getScheme(); } public String getHost() { return uri.getHost(); }
    }`,
  'android/os/Build.java': `package android.os;
    public class Build {
      public static final String[] SUPPORTED_ABIS = { "arm64-v8a" };
      public static class VERSION { public static final int SDK_INT = 36; }
      public static class VERSION_CODES { public static final int P = 28, TIRAMISU = 33; }
    }`,
  'android/provider/Settings.java': `package android.provider;
    public class Settings { public static final String ACTION_MANAGE_UNKNOWN_APP_SOURCES = "unknown"; }`,
  'androidx/core/content/FileProvider.java': `package androidx.core.content;
    public class FileProvider {
      public static android.net.Uri getUriForFile(android.content.Context c, String authority, java.io.File file) {
        throw new UnsupportedOperationException();
      }
    }`,
  'com/getcapacitor/JSObject.java': `package com.getcapacitor;
    public class JSObject extends java.util.HashMap<String, Object> {}`,
  'com/getcapacitor/Plugin.java': `package com.getcapacitor;
    public class Plugin {
      public android.content.Context getContext() { return new android.content.Context(); }
      protected void handleOnDestroy() {} public void notifyListeners(String event, JSObject data) {}
    }`,
  'com/getcapacitor/PluginCall.java': `package com.getcapacitor;
    public class PluginCall {
      public final java.util.Map<String, Object> args = new java.util.HashMap<>();
      public final java.util.concurrent.CompletableFuture<JSObject> result = new java.util.concurrent.CompletableFuture<>();
      public String getString(String key) { return (String) args.get(key); }
      public String getString(String key, String fallback) { return (String) args.getOrDefault(key, fallback); }
      public Long getLong(String key) { return (Long) args.get(key); }
      public void resolve(JSObject value) { result.complete(value); } public void resolve() { resolve(new JSObject()); }
      public void reject(String message) { result.completeExceptionally(new IllegalStateException(message)); }
      public void reject(String message, Exception cause) { result.completeExceptionally(new IllegalStateException(message, cause)); }
    }`,
  'com/getcapacitor/PluginMethod.java': 'package com.getcapacitor; public @interface PluginMethod {}',
  'com/getcapacitor/annotation/CapacitorPlugin.java': 'package com.getcapacitor.annotation; public @interface CapacitorPlugin { String name(); }',
  'com/localbridge/mobile/HttpHarness.java': `package com.localbridge.mobile;
    import com.getcapacitor.*;
    public class HttpHarness extends BridgeUpdaterPlugin {
      private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
      public static void main(String[] args) throws Exception {
        HttpHarness plugin = new HttpHarness();
        try {
          PluginCall call = new PluginCall();
          call.args.put("url", args[0]);
          if (!args[2].equals("absent")) call.args.put("etag", args[2]);
          if (args[1].equals("apk")) {
            call.args.put("version", "2.0.0");
            call.args.put("expectedSize", 11L);
            call.args.put("expectedSha256", java.util.HexFormat.of().formatHex(
              java.security.MessageDigest.getInstance("SHA-256").digest("fixture-apk".getBytes(java.nio.charset.StandardCharsets.UTF_8))));
            plugin.downloadAndVerifyApk(call);
          } else plugin.fetchReleasesJson(call);
          JSObject result;
          try { result = call.result.get(10, java.util.concurrent.TimeUnit.SECONDS); }
          catch (java.util.concurrent.ExecutionException error) {
            if (args[1].equals("503") && error.getCause().getMessage().contains("HTTP 503")) return;
            throw error;
          }
          check(!args[1].equals("503"), "HTTP 503 should reject the plugin call");
          if (args[1].equals("apk")) {
            check(Boolean.TRUE.equals(result.get("staged")), "APK was not staged");
            check(Boolean.FALSE.equals(result.get("reusedCache")), "APK unexpectedly reused cache");
            check(Long.valueOf(11).equals(result.get("bytes")), "APK byte count");
            check(java.nio.file.Files.readString(java.nio.file.Path.of(System.getProperty("fixture.cache"), "updates", "bridge-update.apk")).equals("fixture-apk"), "APK contents");
          } else {
            check(Integer.valueOf(args[1]).equals(result.get("status")), "response status: " + result);
            check("\\\"next\\\"".equals(result.get("etag")), "response ETag: " + result);
            if (args[1].equals("304")) check(!result.containsKey("body"), "304 must omit body");
            else check("[]".equals(result.get("body")), "release body: " + result);
          }
        } finally { plugin.handleOnDestroy(); }
      }
    }`,
};

const jdkBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin') : null;
const java = jdkBin ? join(jdkBin, 'java') : 'java';
const javac = jdkBin ? join(jdkBin, 'javac') : 'javac';

test('Android updater configures real HTTP requests before connecting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-android-http-'));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers });
    const [, kind, status, redirect, hop] = request.url.split('/');
    if (hop !== 'final' && redirect !== '0') {
      response.writeHead(Number(redirect), { Location: `/${kind}/${status}/${redirect}/${hop === 'start' ? 'middle' : 'final'}` });
      response.end();
    } else {
      response.writeHead(Number(status), { ETag: '"next"' });
      response.end(kind === 'apk' ? 'fixture-apk' : '[]');
    }
  });
  try {
    const sources = [];
    for (const [path, source] of Object.entries(stubs)) {
      const destination = join(directory, path);
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, source);
      sources.push(destination);
    }
    const plugin = join(directory, 'com/localbridge/mobile/BridgeUpdaterPlugin.java');
    await writeFile(plugin, await readFile(new URL('../apps/mobile/android/app/src/main/java/com/localbridge/mobile/BridgeUpdaterPlugin.java', import.meta.url)));
    const compile = spawnSync(javac, ['-encoding', 'UTF-8', '-d', directory, ...sources, plugin], { encoding: 'utf8' });
    assert.equal(compile.status, 0, `JDK required (set JAVA_HOME). ${compile.error ?? ''}\n${compile.stderr}`);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const [kind, status, redirect, etag] of [
      ['feed', 200, 0, 'absent'],
      ...[301, 302, 303, 307, 308].map(code => ['feed', 200, code, '"cached"']),
      ['feed', 304, 302, '"cached"'],
      ['feed', 200, 0, ''],
      ['feed', 503, 0, 'absent'],
      ['apk', 200, 302, 'absent'],
    ]) {
      await t.test(`${kind} HTTP ${status}, redirect ${redirect}, ETag ${etag}`, async () => {
        requests.length = 0;
        const url = `http://127.0.0.1:${server.address().port}/${kind}/${status}/${redirect}/start`;
        const result = await new Promise((resolve, reject) => {
          const child = spawn(java, [`-Dfixture.cache=${directory}`, '-cp', directory,
            'com.localbridge.mobile.HttpHarness', url, kind === 'apk' ? kind : String(status), etag]);
          let output = '';
          child.stdout.on('data', chunk => { output += chunk; });
          child.stderr.on('data', chunk => { output += chunk; });
          child.on('error', reject);
          child.on('close', code => resolve({ code, output }));
        });
        assert.equal(result.code, 0, result.output);
        assert.equal(requests.length, redirect ? 3 : 1);
        for (const request of requests) {
          assert.equal(request.headers['user-agent'], 'ClaudeDesktopBridge-AndroidUpdater');
          if (kind === 'feed') {
            assert.equal(request.headers.accept, 'application/vnd.github+json');
            assert.equal(request.headers['x-github-api-version'], '2022-11-28');
            assert.equal(request.headers['if-none-match'], etag && etag !== 'absent' ? etag : undefined);
          } else {
            assert.equal(request.headers['x-github-api-version'], undefined);
            assert.equal(request.headers['if-none-match'], undefined);
            assert.notEqual(request.headers.accept, 'application/vnd.github+json');
          }
        }
      });
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await recycle(directory, { recursive: true, force: true });
  }
});
