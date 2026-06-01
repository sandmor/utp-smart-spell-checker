package com.sandmor.utp_smartspellchecker;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;
import org.kivy.android.PythonActivity;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;

public class FileAwarePythonActivity extends PythonActivity {
    private static final int REQUEST_OPEN_TEXT = 7301;
    private static final int REQUEST_CREATE_TEXT = 7302;
    private static WebView bridgeWebView;
    private static Uri activeDocumentUri;
    private static String activeDocumentName;
    private static String pendingSaveText;
    private static boolean isDebugEnabled = false;

    public static void setDebugEnabled(boolean enabled) {
        isDebugEnabled = enabled;
    }

    public static void attachWebView(WebView webView) {
        bridgeWebView = webView;
        webView.addJavascriptInterface(new AndroidFilesBridge(), "AndroidFiles");
    }

    public static class AndroidFilesBridge {
        @JavascriptInterface
        public boolean isAvailable() {
            return true;
        }

        @JavascriptInterface
        public void openTextFile() {
            dispatchDebug("openTextFile called in Java");
            Activity activity = (Activity) PythonActivity.mActivity;
            if (activity != null) {
                activity.runOnUiThread(() -> {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    String[] mimetypes = {"text/*", "application/octet-stream"};
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, mimetypes);
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    activity.startActivityForResult(intent, REQUEST_OPEN_TEXT);
                    dispatchDebug("startActivityForResult executed");
                });
            }
        }

        @JavascriptInterface
        public void saveTextFile(String fileName, String text) {
            if (activeDocumentUri == null) {
                saveTextFileAs(fileName, text);
                return;
            }

            try {
                writeText(activeDocumentUri, text);
                dispatchEvent(
                    "android-file-saved",
                    "{name:" + quote(activeDocumentName) + ",mode:\"update\"}"
                );
            } catch (Exception exception) {
                dispatchError("No se pudo actualizar el archivo: " + exception.getMessage());
            }
        }

        @JavascriptInterface
        public void saveTextFileAs(String fileName, String text) {
            Activity activity = (Activity) PythonActivity.mActivity;
            pendingSaveText = text;

            if (activity != null) {
                activity.runOnUiThread(() -> {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("text/plain");
                    intent.putExtra(Intent.EXTRA_TITLE, normalizeFileName(fileName));
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    activity.startActivityForResult(intent, REQUEST_CREATE_TEXT);
                });
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        
        dispatchDebug("onActivityResult code=" + requestCode + " result=" + resultCode);

        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            dispatchDebug("onActivityResult invalid result or null data");
            if (requestCode == REQUEST_OPEN_TEXT || requestCode == REQUEST_CREATE_TEXT) {
                dispatchError("Operacion cancelada");
            }
            return;
        }

        Uri uri = data.getData();
        dispatchDebug("URI received: " + uri.toString());
        int flags = data.getFlags()
            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

        try {
            getContentResolverForApp().takePersistableUriPermission(uri, flags);
        } catch (Exception ignored) {
            // Some providers grant transient access only. The current operation can still continue.
        }

        if (requestCode == REQUEST_OPEN_TEXT) {
            try {
                dispatchDebug("Reading text from URI");
                String text = readText(uri);
                dispatchDebug("Text read successfully");
                String name = getDisplayName(uri);
                activeDocumentUri = uri;
                activeDocumentName = name;
                
                dispatchDebug("Encoding to Base64");
                String base64Text = android.util.Base64.encodeToString(
                    text.getBytes(StandardCharsets.UTF_8), 
                    android.util.Base64.NO_WRAP
                );
                
                dispatchDebug("Dispatching android-file-opened event");
                dispatchEvent(
                    "android-file-opened",
                    "{name:" + quote(name) + ",textBase64:\"" + base64Text + "\"}"
                );
            } catch (Exception exception) {
                dispatchDebug("Exception reading file: " + exception.getMessage());
                dispatchError("No se pudo abrir el archivo: " + exception.getMessage());
            }
            return;
        }

        if (requestCode == REQUEST_CREATE_TEXT) {
            try {
                writeText(uri, pendingSaveText == null ? "" : pendingSaveText);
                String name = getDisplayName(uri);
                activeDocumentUri = uri;
                activeDocumentName = name;
                pendingSaveText = null;
                dispatchEvent(
                    "android-file-saved",
                    "{name:" + quote(name) + ",mode:\"copy\"}"
                );
            } catch (Exception exception) {
                dispatchError("No se pudo guardar el archivo: " + exception.getMessage());
            }
        }
    }

    private static String readText(Uri uri) throws Exception {
        ContentResolver resolver = getContentResolverForApp();
        InputStream inputStream = resolver.openInputStream(uri);
        if (inputStream == null) {
            throw new IllegalStateException("sin acceso de lectura");
        }

        try {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = inputStream.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            return buffer.toString(StandardCharsets.UTF_8.name());
        } finally {
            inputStream.close();
        }
    }

    private static void writeText(Uri uri, String text) throws Exception {
        ContentResolver resolver = getContentResolverForApp();
        OutputStream outputStream = resolver.openOutputStream(uri, "wt");
        if (outputStream == null) {
            throw new IllegalStateException("sin acceso de escritura");
        }

        try {
            OutputStreamWriter writer = new OutputStreamWriter(outputStream, StandardCharsets.UTF_8);
            writer.write(text);
            writer.flush();
        } finally {
            outputStream.close();
        }
    }

    private static String getDisplayName(Uri uri) {
        ContentResolver resolver = getContentResolverForApp();
        Cursor cursor = null;

        try {
            cursor = resolver.query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) {
                        return name;
                    }
                }
            }
        } catch (Exception ignored) {
            // Fall through to URI based naming.
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }

        String fallback = uri.getLastPathSegment();
        return fallback == null || fallback.isEmpty() ? "documento.txt" : fallback;
    }

    private static String normalizeFileName(String fileName) {
        if (fileName == null || fileName.trim().isEmpty()) {
            return "documento.txt";
        }
        return fileName;
    }

    private static ContentResolver getContentResolverForApp() {
        return ((Activity) PythonActivity.mActivity).getContentResolver();
    }

    private static void dispatchError(String message) {
        dispatchEvent("android-file-error", "{message:" + quote(message) + "}");
    }

    private static void dispatchDebug(String message) {
        if (!isDebugEnabled) {
            return;
        }

        if (PythonActivity.mActivity != null) {
            ((Activity)PythonActivity.mActivity).runOnUiThread(() -> {
                android.widget.Toast.makeText(PythonActivity.mActivity, "DBG: " + message, android.widget.Toast.LENGTH_SHORT).show();
            });
        }
        dispatchEvent("android-debug", "{message:" + quote(message) + "}");
    }

    private static void dispatchEvent(String eventName, String detailJson) {
        if (bridgeWebView == null) {
            return;
        }

        String script = "window.dispatchEvent(new CustomEvent("
            + quote(eventName)
            + ",{detail:"
            + detailJson
            + "}));";

        bridgeWebView.post(() -> bridgeWebView.evaluateJavascript(script, null));
    }

    private static String quote(String value) {
        return JSONObject.quote(value == null ? "" : value);
    }
}
