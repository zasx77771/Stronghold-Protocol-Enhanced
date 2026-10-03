package com.strongholdprotocol.covenant;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String START_URL =
            "https://appassets.androidplatform.net/index.html?desktop=1&android=1";
    private WebView webView;
    private TcpBridge tcpBridge;

    private static final class TcpBridge {
        private static final int MAX_FRAME = 64 * 1024;
        private final WebView webView;
        private final ExecutorService executor = Executors.newCachedThreadPool();
        private final ConcurrentHashMap<String, Client> clients = new ConcurrentHashMap<>();

        private static final class Client {
            final String id;
            final Socket socket = new Socket();
            DataOutputStream output;
            volatile int closeCode = 1006;
            volatile String closeReason = "";

            Client(String id) { this.id = id; }

            synchronized void write(String text) throws IOException {
                if (output == null) throw new IOException("TCP socket is not open");
                byte[] body = text.getBytes(StandardCharsets.UTF_8);
                if (body.length == 0 || body.length > MAX_FRAME) throw new IOException("invalid TCP frame size");
                output.writeInt(body.length);
                output.write(body);
                output.flush();
            }

            void destroy() {
                try { socket.close(); } catch (IOException ignored) { }
            }
        }

        TcpBridge(WebView webView) { this.webView = webView; }

        @JavascriptInterface
        public boolean available() { return true; }

        @JavascriptInterface
        public String readClipboardText() {
            try {
                Context context = webView.getContext();
                ClipboardManager clipboard =
                        (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard == null || !clipboard.hasPrimaryClip()) return "";
                ClipData clip = clipboard.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return "";
                CharSequence text = clip.getItemAt(0).coerceToText(context);
                return text == null ? "" : text.toString();
            } catch (SecurityException denied) {
                return "__SP_CLIPBOARD_DENIED__:" + String.valueOf(denied.getMessage());
            } catch (RuntimeException failed) {
                return "__SP_CLIPBOARD_ERROR__:" + String.valueOf(failed.getMessage());
            }
        }

        @JavascriptInterface
        public void connect(String id, String host, int port) {
            if (id == null || !id.matches("[A-Za-z0-9-]{1,80}") || host == null || host.length() == 0
                    || host.length() > 253 || host.matches(".*[\\s/\\\\].*") || port < 1 || port > 65535) {
                emit(id == null ? "" : id, "error", "TCP 地址格式不正确", null, null);
                emit(id == null ? "" : id, "close", null, 1006, "invalid endpoint");
                return;
            }
            Client client = new Client(id);
            Client previous = clients.put(id, client);
            if (previous != null) previous.destroy();
            executor.execute(() -> runClient(client, host, port));
        }

        private void runClient(Client client, String host, int port) {
            try {
                client.socket.connect(new InetSocketAddress(host, port), 10_000);
                client.socket.setTcpNoDelay(true);
                client.output = new DataOutputStream(client.socket.getOutputStream());
                emit(client.id, "open", null, null, null);
                DataInputStream input = new DataInputStream(client.socket.getInputStream());
                while (!client.socket.isClosed()) {
                    int length;
                    try { length = input.readInt(); } catch (EOFException eof) { break; }
                    if (length <= 0 || length > MAX_FRAME) throw new IOException("invalid TCP frame size");
                    byte[] body = new byte[length];
                    input.readFully(body);
                    String text = new String(body, StandardCharsets.UTF_8);
                    JSONObject control = null;
                    try {
                        JSONObject parsed = new JSONObject(text);
                        if (parsed.has("_sp")) control = parsed;
                    } catch (Exception ignored) { }
                    if (control != null && "ping".equals(control.optString("_sp"))) {
                        client.write("{\"_sp\":\"pong\"}");
                    } else if (control != null && "close".equals(control.optString("_sp"))) {
                        client.closeCode = control.optInt("code", 1000);
                        client.closeReason = control.optString("reason", "");
                        break;
                    } else {
                        emit(client.id, "message", text, null, null);
                    }
                }
            } catch (Exception error) {
                if (!client.socket.isClosed()) emit(client.id, "error", String.valueOf(error.getMessage()), null, null);
            } finally {
                clients.remove(client.id, client);
                client.destroy();
                emit(client.id, "close", null, client.closeCode, client.closeReason);
            }
        }

        @JavascriptInterface
        public void send(String id, String data) {
            Client client = clients.get(id);
            if (client == null || data == null) return;
            try { client.write(data); }
            catch (Exception error) { emit(id, "error", String.valueOf(error.getMessage()), null, null); client.destroy(); }
        }

        @JavascriptInterface
        public void close(String id, int code, String reason) {
            Client client = clients.get(id);
            if (client == null) return;
            client.closeCode = code > 0 ? code : 1000;
            client.closeReason = reason == null ? "" : reason;
            try {
                JSONObject control = new JSONObject();
                control.put("_sp", "close");
                control.put("code", client.closeCode);
                control.put("reason", client.closeReason);
                client.write(control.toString());
            } catch (Exception ignored) { }
            client.destroy();
        }

        private void emit(String id, String type, String value, Integer code, String reason) {
            JSONObject event = new JSONObject();
            try {
                event.put("id", id);
                event.put("type", type);
                if ("message".equals(type)) event.put("data", value == null ? "" : value);
                else if ("error".equals(type)) event.put("message", value == null ? "TCP connection error" : value);
                if (code != null) event.put("code", code);
                if (reason != null) event.put("reason", reason);
            } catch (Exception ignored) { return; }
            String script = "if(globalThis.__strongholdTcpDispatch)globalThis.__strongholdTcpDispatch(" + event + ");";
            webView.post(() -> webView.evaluateJavascript(script, null));
        }

        void shutdown() {
            for (Client client : clients.values()) client.destroy();
            clients.clear();
            executor.shutdownNow();
        }
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(12, 15, 14));
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setOffscreenPreRaster(true);

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return assetLoader.shouldInterceptRequest(android.net.Uri.parse(url));
            }
        });
        webView.setWebChromeClient(new WebChromeClient());
        tcpBridge = new TcpBridge(webView);
        webView.addJavascriptInterface(tcpBridge, "StrongholdAndroidTcp");
        webView.addJavascriptInterface(tcpBridge, "StrongholdAndroid");
        setContentView(webView);
        // The window's DecorView/InsetsController may not exist until content is attached
        // (notably on Android emulators and some vendor builds). Post the first fullscreen
        // request and keep the method null-safe for later focus changes.
        getWindow().getDecorView().post(this::enterImmersiveMode);
        webView.loadUrl(START_URL);
    }

    private void enterImmersiveMode() {
        View decorView = getWindow().getDecorView();
        if (decorView == null) return;
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = decorView.getWindowInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            decorView.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersiveMode();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        enterImmersiveMode();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            if (tcpBridge != null) {
                webView.removeJavascriptInterface("StrongholdAndroidTcp");
                webView.removeJavascriptInterface("StrongholdAndroid");
                tcpBridge.shutdown();
                tcpBridge = null;
            }
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
