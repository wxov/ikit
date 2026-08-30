package com.ikit.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewLocalServer;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 自建热更新插件（基于 Capacitor WebViewLocalServer.hostFiles）：
 * 下载 web 资源 zip → 解压到 filesDir/webupdate/<version> → 用本地服务器指向该目录 → reload。
 */
@CapacitorPlugin(name = "WebUpdate")
public class WebUpdatePlugin extends Plugin {
    private static final String DEFAULT_VERSION = "0.1.2";

    @PluginMethod
    public void applyUpdate(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        try {
            String version = inferVersion(url);
            File versionDir = new File(getWebUpdateDir(), version);
            versionDir.mkdirs();

            URL u = new URL(url);
            HttpURLConnection conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            if (conn.getResponseCode() != 200) {
                call.reject("download failed: HTTP " + conn.getResponseCode());
                return;
            }
            try (BufferedInputStream in = new BufferedInputStream(conn.getInputStream());
                 ZipInputStream zis = new ZipInputStream(in)) {
                ZipEntry entry;
                while ((entry = zis.getNextEntry()) != null) {
                    String name = entry.getName();
                    if (name == null || name.isEmpty()) continue;
                    File outFile = new File(versionDir, name);
                    if (entry.isDirectory()) {
                        outFile.mkdirs();
                        continue;
                    }
                    File parent = outFile.getParentFile();
                    if (parent != null) parent.mkdirs();
                    try (FileOutputStream out = new FileOutputStream(outFile)) {
                        byte[] buf = new byte[8192];
                        int len;
                        while ((len = zis.read(buf)) > 0) out.write(buf, 0, len);
                    }
                }
            }
            setCurrentVersion(version);

            // 用本地服务器指向解压目录并重载（hostFiles 后 base 变为该目录）
            hostFiles(versionDir);
            getBridge().reload();

            JSObject ret = new JSObject();
            ret.put("version", version);
            ret.put("base", getWebUpdateDir().getAbsolutePath());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("applyUpdate error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getCurrentVersion(PluginCall call) {
        JSObject ret = new JSObject();
        String current = currentVersion();
        ret.put("version", current);
        File dir = new File(getWebUpdateDir(), current);
        if (dir.exists()) hostFiles(dir);
        call.resolve(ret);
    }

    @PluginMethod
    public void reload(PluginCall call) {
        getBridge().reload();
        call.resolve();
    }

    private void hostFiles(File dir) {
        try {
            WebViewLocalServer local = getBridge().getLocalServer();
            if (local != null) local.hostFiles(dir.getAbsolutePath());
        } catch (Exception ignored) {
        }
    }

    private File getWebUpdateDir() {
        return new File(getContext().getFilesDir(), "webupdate");
    }

    private void setCurrentVersion(String version) {
        try {
            File dir = getWebUpdateDir();
            dir.mkdirs();
            java.io.FileWriter fw = new java.io.FileWriter(new File(dir, "current.json"));
            fw.write("{\"version\":\"" + version + "\"}");
            fw.close();
        } catch (Exception ignored) {
        }
    }

    private String currentVersion() {
        try {
            File f = new File(getWebUpdateDir(), "current.json");
            if (f.exists()) {
                BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
                int idx = sb.indexOf("\"version\":\"");
                if (idx >= 0) {
                    int s = idx + "\"version\":\"".length();
                    int e = sb.indexOf("\"", s);
                    if (e > s) return sb.substring(s, e);
                }
            }
        } catch (Exception ignored) {
        }
        return DEFAULT_VERSION;
    }

    private String inferVersion(String url) {
        String name = url;
        int slash = name.lastIndexOf('/');
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replace("web-update-", "").replace(".zip", "");
        return name.isEmpty() ? DEFAULT_VERSION : name;
    }
}
