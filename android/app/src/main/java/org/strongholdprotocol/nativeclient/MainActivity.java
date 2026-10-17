package org.strongholdprotocol.nativeclient;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.strongholdprotocol.nativeclient.assets.AssetApkSource;
import org.strongholdprotocol.nativeclient.assets.AssetConfig;
import org.strongholdprotocol.nativeclient.assets.AssetInventory;
import org.strongholdprotocol.nativeclient.assets.AssetJson;
import org.strongholdprotocol.nativeclient.assets.AssetPaths;
import org.strongholdprotocol.nativeclient.assets.AssetStore;
import org.strongholdprotocol.nativeclient.assets.AssetUpdateSession;

public final class MainActivity extends Activity {
  private static final String ORIGIN = "https://appassets.androidplatform.net";
  private static final String ASSET_STORE_DIR = "asset-runtime";
  private static final int REQUEST_IMPORT_PACKAGE = 0x5350;
  private static final String TAG = "StrongholdNative";
  private final ExecutorService io = Executors.newCachedThreadPool();
  private final Map<String, NativeSocket> sockets = new ConcurrentHashMap<>();
  private WebView webView;
  private AssetStore assetStore;
  private AssetConfig assetConfig;
  private AssetUpdateSession assetSession;
  private ExecutorService assetExecutor;
  private volatile boolean importBusy;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    assetStore = openAssetStore();
    assetConfig = loadAssetConfig();
    assetSession = new AssetUpdateSession(assetStore, assetConfig, getCacheDir(), null);
    assetSession.setListener(this::emitAssetState);
    assetExecutor = Executors.newSingleThreadExecutor();
    webView = new WebView(this);
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    webView.getSettings().setAllowFileAccess(false);
    webView.getSettings().setAllowContentAccess(false);
    webView.addJavascriptInterface(new TcpBridge(), "StrongholdAndroidTcp");
    webView.addJavascriptInterface(new AssetBridge(), "StrongholdAndroidAssets");
    WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
        .addPathHandler("/", new NativeAssets())
        .build();
    webView.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        android.net.Uri target = request.getUrl();
        String origin = target.getScheme() + "://" + target.getAuthority();
        return !ORIGIN.equals(origin);
      }
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return loader.shouldInterceptRequest(request.getUrl());
      }
    });
    setContentView(webView);
    webView.loadUrl(ORIGIN + "/index.html");
  }

  @Override protected void onDestroy() {
    if (assetSession != null) assetSession.cancel();
    if (assetExecutor != null) assetExecutor.shutdownNow();
    for (NativeSocket socket : sockets.values()) socket.close(1000, "activity destroyed");
    sockets.clear();
    io.shutdownNow();
    super.onDestroy();
  }

  /**
   * Native-only local package import. The page never receives a path or a content resolver: it can
   * only ask the shell to open the system document picker, and the chosen URI is copied into the
   * app cache and validated by {@link AssetStore#apply} before a new store generation is published.
   */
  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != REQUEST_IMPORT_PACKAGE) return;
    if (resultCode != RESULT_OK || data == null || data.getData() == null) {
      emitImportState("import-failed", "已取消导入", "");
      return;
    }
    if (importBusy) {
      emitImportState("import-failed", "已有导入任务在进行", "");
      return;
    }
    importBusy = true;
    // One writer at a time: a running online transfer must not race the local package.
    if (assetSession != null) assetSession.cancel();
    Uri uri = data.getData();
    emitImportState("importing", "正在读取本地素材包", "");
    ExecutorService executor = assetExecutor;
    if (executor == null) {
      importBusy = false;
      emitImportState("import-failed", "素材导入不可用", "");
      return;
    }
    try {
      executor.execute(() -> importFromUri(uri));
    } catch (RuntimeException rejected) {
      importBusy = false;
      emitImportState("import-failed", "素材导入任务未启动", "");
    }
  }

  private void importFromUri(Uri uri) {
    File temporary = new File(getCacheDir(), "import-package.zip");
    long maxExtract = assetConfig == null ? AssetConfig.DEFAULT_MAX_EXTRACT_BYTES : assetConfig.maxExtractBytes;
    long limit = Math.min(maxExtract, AssetConfig.DEFAULT_MAX_DOWNLOAD_BYTES);
    String digest;
    try {
      MessageDigest sha = MessageDigest.getInstance("SHA-256");
      long total = 0;
      try (InputStream source = getContentResolver().openInputStream(uri);
           OutputStream sink = new FileOutputStream(temporary)) {
        if (source == null) throw new IOException("无法读取所选文件");
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = source.read(buffer)) > 0) {
          total += read;
          if (total > limit) throw new IOException("素材包超过 " + limit + " 字节限制");
          sha.update(buffer, 0, read);
          sink.write(buffer, 0, read);
        }
      }
      digest = hex(sha.digest());
    } catch (Exception error) {
      temporary.delete();
      importBusy = false;
      emitImportState("import-failed", "读取素材包失败：" + describe(error), "");
      return;
    }
    try {
      emitImportState("import-verifying", "校验 ASSETS.json、SHA-256 与 inventory", "");
      emitImportState("import-applying", "解压并原子切换素材层", "");
      AssetStore store = assetStore;
      if (store == null) throw new IOException("素材存储不可用");
      AssetStore.Applied applied = store.apply(temporary, digest, maxExtract);
      emitImportState("imported",
          "已导入 " + applied.kind + " " + applied.version + "（" + applied.files + " 个文件）",
          applied.version);
    } catch (Exception error) {
      emitImportState("import-failed", "导入失败：" + describe(error), "");
    } finally {
      temporary.delete();
      importBusy = false;
    }
  }

  private static String hex(byte[] bytes) {
    StringBuilder text = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) text.append(String.format("%02x", value & 255));
    return text.toString();
  }

  /**
   * A message safe to cross into page JavaScript: local directories, content URIs and drive
   * letters are replaced, so the WebView never learns where the app keeps the picked package or
   * its private asset store.
   */
  private String describe(Throwable error) {
    String message = error.getMessage();
    if (message == null || message.isEmpty()) message = error.getClass().getSimpleName();
    String cache = getCacheDir().getAbsolutePath();
    String files = getFilesDir().getAbsolutePath();
    String text = message.replace(cache, "<应用私有目录>").replace(files, "<应用私有目录>");
    text = text.replaceAll("(?i)[a-z]:\\\\[^\\s\"']+", "<本地路径>");
    text = text.replaceAll("(?i)file://[^\\s\"']+", "<本地文件>");
    text = text.replaceAll("/data/[^\\s\"']+", "<本地路径>");
    text = text.replaceAll("(?i)/(?:storage|sdcard|mnt)/[^\\s\"']+", "<本地路径>");
    text = text.replaceAll("content://[^\\s\"']+", "<本地文件>");
    return text;
  }

  private void emitImportState(String state, String message, String current) {
    Map<String, Object> payload = new HashMap<>();
    payload.put("format", AssetUpdateSession.STATUS_FORMAT);
    payload.put("state", state);
    payload.put("message", message);
    payload.put("error", "import-failed".equals(state) ? message : "");
    payload.put("current", current == null || current.isEmpty()
        ? (assetStore != null && assetStore.hasState() ? assetStore.version() : "") : current);
    payload.put("mirrors", assetConfig == null ? new java.util.ArrayList<Map<String, String>>() : assetConfig.mirrors);
    payload.put("mirrorProblems", assetConfig == null ? new java.util.ArrayList<String>() : assetConfig.mirrorProblems);
    payload.put("importAvailable", assetStore != null);
    emitAssetState(payload);
  }

  private final class NativeAssets implements WebViewAssetLoader.PathHandler {
    @Override public WebResourceResponse handle(String path) {
      String clean = path == null || path.isEmpty() || "/".equals(path) ? "index.html" : path.replaceFirst("^/", "");
      if (clean.contains("..") || clean.contains("\\")) return response("text/plain", "Not Found");
      if ("index.html".equals(clean)) return fromApk(clean);
      if (clean.startsWith("media/")) {
        WebResourceResponse stored = fromStoreMedia(clean);
        return stored != null ? stored : fromApk(clean);
      }
      String plain = stripHash(clean);
      if (assetStore != null && assetStore.hasState() && AssetPaths.isAssetPath(plain)) {
        WebResourceResponse stored = fromStore(plain);
        if (stored != null) return stored;
        // A published inventory answers for removed assets: the APK floor must not mask a deletion.
        return notFound("asset not in the published store");
      }
      return fromApk(clean);
    }
  }

  /** One plain asset path from the published store, or null; never falls back to APK bytes. */
  private WebResourceResponse fromStore(String rel) {
    if (assetStore == null || rel == null || rel.isEmpty()) return null;
    AssetStore.Hit hit = assetStore.resolve(rel);
    if (hit == null) return null;
    try {
      return streamResponse(mime(rel), hit.open(), "no-cache");
    } catch (IOException error) {
      return null;
    }
  }

  private WebResourceResponse fromApk(String rel) {
    try (InputStream source = openAsset(rel)) {
      byte[] body = readAll(source);
      if ("index.html".equals(rel)) {
        String html = new String(body, StandardCharsets.UTF_8);
        if (!html.contains("/native/bridge.js")) html = html.replaceFirst("<head>", "<head><script src=\"/native/bridge.js\" data-sp-platform=\"android\"></script>");
        body = html.getBytes(StandardCharsets.UTF_8);
        return streamResponse(mime(rel), new ByteArrayInputStream(body), "no-store");
      }
      return streamResponse(mime(rel), new ByteArrayInputStream(body), "no-cache");
    } catch (IOException missing) {
      return notFound("not packaged");
    }
  }

  /** `/media/<name>` is the page's extensionless audio alias; the store keys carry the extension. */
  private WebResourceResponse fromStoreMedia(String rel) {
    String base = mediaAssetPath(rel);
    String[] extensions = { ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav" };
    for (String extension : extensions) {
      WebResourceResponse stored = fromStore(base + extension);
      if (stored != null) return stored;
    }
    return null;
  }

  private static String stripHash(String rel) {
    int first = rel.indexOf('/');
    if (first < 0) return rel;
    String root = rel.substring(0, first);
    if (!"assets".equals(root) && !"fonts".equals(root) && !"media".equals(root)) return rel;
    int next = rel.indexOf('/', first + 1);
    if (next < 0) return rel;
    String segment = rel.substring(first + 1, next);
    if (!segment.matches("~[0-9a-f]{16}")) return rel;
    return root + "/" + rel.substring(next + 1);
  }

  private static String mediaAssetPath(String rel) {
    String rest = stripHash(rel).substring("media/".length());
    return "assets/audio/" + rest;
  }

  private final class TcpBridge {
    @JavascriptInterface public void connect(String id, String host, int port) {
      if (id == null || host == null || port < 1 || port > 65535) { emit(id, "error", "invalid TCP endpoint", 0); return; }
      NativeSocket prior = sockets.remove(id);
      if (prior != null) prior.close(1000, "replaced");
      NativeSocket socket = new NativeSocket(id, host, port);
      sockets.put(id, socket);
      io.execute(socket::run);
    }
    @JavascriptInterface public void send(String id, String data) {
      NativeSocket socket = sockets.get(id);
      if (socket == null) { emit(id, "error", "TCP socket not found", 0); return; }
      socket.send(data == null ? "" : data);
    }
    @JavascriptInterface public void close(String id, int code, String reason) {
      NativeSocket socket = sockets.remove(id);
      if (socket != null) socket.close(code, reason == null ? "" : reason);
    }
    @JavascriptInterface public void setAssetSessionToken(String token) {
      AssetUpdateSession session = assetSession;
      if (session != null && token != null && token.matches("[0-9a-f]{32}")) session.setSessionToken(token);
    }
  }

  /**
   * The only JavaScript surface for runtime assets: read status, prepare a plan, start/retry the
   * confirmed transfer, cancel.  It carries no token in either direction and never starts a
   * transfer by itself.
   */
  private final class AssetBridge {
    @JavascriptInterface public boolean available() { return assetSession != null; }

    @JavascriptInterface public String status() {
      AssetUpdateSession session = assetSession;
      if (session == null) {
        return "{\"format\":\"" + AssetUpdateSession.STATUS_FORMAT + "\",\"state\":\""
            + AssetUpdateSession.UNAVAILABLE + "\",\"message\":\"the runtime asset store is unavailable\"}";
      }
      return AssetJson.stringify(session.status());
    }

    @JavascriptInterface public void prepare() { submit(AssetUpdateSession::prepare); }
    @JavascriptInterface public void start() { submit(AssetUpdateSession::start); }
    @JavascriptInterface public void retry() { submit(AssetUpdateSession::retry); }
    @JavascriptInterface public void cancel() {
      AssetUpdateSession session = assetSession;
      if (session != null) session.cancel();
    }

    /** Native picker only: opens the system document UI; the page gets no path and no URI. */
    @JavascriptInterface public void importPackage() {
      if (assetStore == null) {
        emitImportState("import-failed", "素材存储不可用", "");
        return;
      }
      if (importBusy) return;
      Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
      intent.addCategory(Intent.CATEGORY_OPENABLE);
      intent.setType("application/zip");
      intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
          "application/zip", "application/x-zip-compressed", "application/octet-stream" });
      try {
        startActivityForResult(intent, REQUEST_IMPORT_PACKAGE);
      } catch (RuntimeException error) {
        emitImportState("import-failed", "无法打开文件选择器：" + describe(error), "");
      }
    }

    private void submit(java.util.function.Consumer<AssetUpdateSession> task) {
      // A local import owns the store while it runs; queued online actions must not race it.
      if (importBusy) return;
      AssetUpdateSession session = assetSession;
      ExecutorService executor = assetExecutor;
      if (session == null || executor == null || executor.isShutdown()) return;
      try {
        executor.execute(() -> {
          try { task.accept(session); }
          catch (RuntimeException failed) { Log.w(TAG, "asset request failed", failed); }
        });
      } catch (RuntimeException rejected) {
        Log.w(TAG, "asset request was not scheduled", rejected);
      }
    }
  }

  private AssetStore openAssetStore() {
    AssetApkSource floor = null;
    AssetInventory floorInventory = null;
    String floorVersion = null;
    String text = readPackagedText(AssetPaths.STATE_FILE);
    if (text != null) {
      try {
        Map<String, Object> state = AssetJson.object(AssetJson.parse(text));
        floorInventory = AssetInventory.fromState(state);
        floorVersion = AssetJson.string(AssetJson.get(state, "version"), null);
        floor = new AssetApkSource(getAssets());
      } catch (IllegalArgumentException error) {
        Log.w(TAG, "ignoring the packaged asset state; a baseline can repair it", error);
      }
    }
    try {
      return AssetStore.open(new File(getFilesDir(), ASSET_STORE_DIR), floor, floorInventory, floorVersion);
    } catch (IOException error) {
      Log.w(TAG, "runtime asset store unavailable", error);
      return null;
    }
  }

  /** Public configuration only: the packaged file is the whole source (no build-time fallback). */
  private AssetConfig loadAssetConfig() {
    try {
      String text = readPackagedText(AssetPaths.CONFIG_FILE);
      if (text != null) return AssetConfig.from(AssetJson.object(AssetJson.parse(text)));
    } catch (IllegalArgumentException error) {
      Log.w(TAG, "ignoring the packaged asset configuration: " + error.getMessage());
    }
    return AssetConfig.disabled("no asset-config.json is packaged");
  }

  private String readPackagedText(String name) {
    try (InputStream source = getAssets().open(name)) {
      return new String(readAll(source), StandardCharsets.UTF_8);
    } catch (IOException missing) {
      return null;
    }
  }

  private void emitAssetState(Map<String, Object> status) {
    WebView view = webView;
    if (view == null || status == null) return;
    String script = "if(globalThis.__strongholdAssetUpdate)globalThis.__strongholdAssetUpdate("
        + AssetJson.stringify(status) + ");";
    view.post(() -> view.evaluateJavascript(script, null));
  }

  private final class NativeSocket {
    private final String id, host;
    private final int port;
    private volatile Socket socket;
    NativeSocket(String id, String host, int port) { this.id = id; this.host = host; this.port = port; }
    void run() {
      try (Socket opened = new Socket(host, port)) {
        socket = opened;
        emit(id, "open", "", 0);
        while (!opened.isClosed()) {
          byte[] length = readFully(opened.getInputStream(), 4);
          if (length.length != 4) break;
          int size = ((length[0] & 255) << 24) | ((length[1] & 255) << 16) | ((length[2] & 255) << 8) | (length[3] & 255);
          if (size <= 0 || size > 65536) { emit(id, "error", "invalid TCP frame", 0); break; }
          byte[] data = readFully(opened.getInputStream(), size);
          if (data.length != size) break;
          emit(id, "message", new String(data, StandardCharsets.UTF_8), 0);
        }
      } catch (IOException error) { emit(id, "error", error.getMessage(), 0); }
      finally { sockets.remove(id, this); emit(id, "close", "connection closed", 1006); }
    }
    synchronized void send(String text) {
      try {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > 65536) throw new IOException("invalid TCP frame");
        if (socket == null) throw new IOException("TCP socket not open");
        socket.getOutputStream().write(new byte[] {(byte)(bytes.length >>> 24), (byte)(bytes.length >>> 16), (byte)(bytes.length >>> 8), (byte)bytes.length});
        socket.getOutputStream().write(bytes);
        socket.getOutputStream().flush();
      } catch (IOException error) { emit(id, "error", error.getMessage(), 0); }
    }
    void close(int code, String reason) {
      try { if (socket != null) socket.close(); } catch (IOException ignored) { }
    }
  }

  private void emit(String id, String type, String text, int code) {
    String json = "{\"id\":" + quoted(id) + ",\"type\":" + quoted(type)
        + ("message".equals(type) ? ",\"data\":" + quoted(text) : "")
        + ("error".equals(type) ? ",\"message\":" + quoted(text) : "")
        + ("close".equals(type) ? ",\"code\":" + code + ",\"reason\":" + quoted(text) : "") + "}";
    runOnUiThread(() -> webView.evaluateJavascript("window.__strongholdNativeTcpEvent && window.__strongholdNativeTcpEvent(" + json + ")", null));
  }

  private InputStream openAsset(String clean) throws IOException {
    try { return getAssets().open(clean); }
    catch (IOException missing) {
      if (!clean.startsWith("media/")) throw missing;
      String rest = clean.substring("media/".length());
      if (rest.startsWith("~")) {
        int slash = rest.indexOf('/');
        if (slash < 1) throw missing;
        rest = rest.substring(slash + 1);
      }
      String base = "assets/audio/" + rest;
      String[] extensions = { ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav" };
      for (String extension : extensions) {
        try { return getAssets().open(base + extension); } catch (IOException ignored) { }
      }
      throw missing;
    }
  }

  private static WebResourceResponse response(String type, String text) {
    return new WebResourceResponse(type, "utf-8", new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
  }

  private static WebResourceResponse streamResponse(String type, InputStream body, String cacheControl) {
    boolean text = type.startsWith("text/") || type.contains("javascript") || type.contains("json")
        || type.contains("xml");
    WebResourceResponse answer = new WebResourceResponse(type, text ? "utf-8" : null, body);
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", cacheControl);
    headers.put("X-Content-Type-Options", "nosniff");
    answer.setResponseHeaders(headers);
    return answer;
  }

  private static WebResourceResponse notFound(String reason) {
    WebResourceResponse answer = response("text/plain", reason);
    answer.setStatusCodeAndReasonPhrase(404, "Not Found");
    return answer;
  }

  private static String mime(String path) {
    String lower = path.toLowerCase(java.util.Locale.ROOT);
    if (lower.endsWith(".html")) return "text/html";
    if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
    if (lower.endsWith(".css")) return "text/css";
    if (lower.endsWith(".json") || lower.endsWith(".atlas") || lower.endsWith(".skel")) return "application/json";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".woff2")) return "font/woff2";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".m4a") || lower.endsWith(".aac")) return "audio/mp4";
    if (lower.endsWith(".ogg") || lower.endsWith(".oga") || lower.endsWith(".opus")) return "audio/ogg";
    if (lower.endsWith(".wav")) return "audio/wav";
    return "application/octet-stream";
  }
  private static String quoted(String value) { return "\"" + (value == null ? "" : value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")) + "\""; }
  private static byte[] readAll(InputStream input) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int count;
    while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
    return output.toByteArray();
  }
  private static byte[] readFully(InputStream input, int expected) throws IOException {
    byte[] out = new byte[expected];
    int offset = 0;
    while (offset < expected) {
      int count = input.read(out, offset, expected - offset);
      if (count < 0) break;
      offset += count;
    }
    return offset == expected ? out : java.util.Arrays.copyOf(out, offset);
  }
}
