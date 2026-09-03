use std::fs::{self, File};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use tauri::http::Response;

// 热更新解压后的资源目录（app data /webupdate/<version>）
fn update_dir(app: &AppHandle, version: &str) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("no app data dir")
        .join("webupdate")
        .join(version)
}

// 当前生效版本指针文件
fn current_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("no app data dir")
        .join("webupdate")
        .join("current.json")
}

const CURRENT_FALLBACK: &str = "0.1.2";

/// 记录当前生效的 web 版本
fn set_current(app: &AppHandle, version: &str) {
    if let Some(dir) = app.path().app_data_dir().ok() {
        let d = dir.join("webupdate");
        let _ = fs::create_dir_all(&d);
        let _ = fs::write(d.join("current.json"), format!("{{\"version\":\"{version}\"}}"));
    }
}

/// 返回当前生效的 web 版本
fn current_version(app: &AppHandle) -> String {
    if let Ok(data) = fs::read_to_string(current_file(app)) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(s) = v.get("version").and_then(|x| x.as_str()) {
                return s.to_string();
            }
        }
    }
    CURRENT_FALLBACK.to_string()
}

/// Tauri command: apply_web_update(url) —— 下载 zip → 解压到 app data → 记录版本
#[tauri::command]
async fn apply_web_update(app: AppHandle, url: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read failed: {e}"))?;

    let version = infer_version(&url);
    let dir = update_dir(&app, &version);
    let _ = fs::create_dir_all(&dir);

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("bad zip: {e}"))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = sanitize(&dir, file.name());
        if file.is_dir() {
            let _ = fs::create_dir_all(&outpath);
            continue;
        }
        if let Some(parent) = outpath.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut out = File::create(&outpath).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
    }

    set_current(&app, &version);
    Ok(version)
}

/// Tauri command: install_update(url) —— 下载完整安装包（.exe）→ 写入 app data/updates → 启动安装器（自动弹出安装向导）
#[tauri::command]
async fn install_update(app: AppHandle, url: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read failed: {e}"))?;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("updates");
    let _ = fs::create_dir_all(&dir);

    // 取 URL 末段作为文件名并清洗（防路径穿越/非法字符）
    let raw_name = url.rsplit('/').next().unwrap_or("i-kit-setup.exe").to_string();
    let cleaned: String = raw_name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let filename = if cleaned.is_empty() {
        "i-kit-setup.exe".to_string()
    } else {
        cleaned
    };
    let path = dir.join(filename);
    fs::write(&path, bytes).map_err(|e| format!("write failed: {e}"))?;

    // 启动安装器：Windows 直接运行 NSIS 安装包（安装向导接管）；其他平台用系统默认打开
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&path)
            .spawn()
            .map_err(|e| format!("launch failed: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("open").arg(&path).spawn();
    }
    Ok(path.to_string_lossy().to_string())
}

/// 从 URL 推断版本号
fn infer_version(url: &str) -> String {
    let base = url.rsplit('/').next().unwrap_or("").to_string();
    let trimmed = base
        .trim_start_matches("web-update-")
        .trim_end_matches(".zip")
        .to_string();
    if trimmed.is_empty() {
        CURRENT_FALLBACK.to_string()
    } else {
        trimmed
    }
}

/// 防目录穿越
fn sanitize(base: &Path, name: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        out = out.join(part);
    }
    out
}

/// 返回当前生效 web 版本（前端启动时调用决定加载哪个资源）
#[tauri::command]
fn get_current_version(app: AppHandle) -> String {
    current_version(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            apply_web_update,
            get_current_version,
            install_update
        ])
        .register_uri_scheme_protocol("webupdate", |ctx, request| {
            let handle = ctx.app_handle();
            let current = current_version(handle);
            let base = handle
                .path()
                .app_data_dir()
                .unwrap_or_default()
                .join("webupdate")
                .join(&current);
            let uri = request.uri();
            let path = uri.path().trim_start_matches('/');
            let file_path = sanitize(&base, path);
            let file_path = if file_path.is_dir() || path.is_empty() || path == "/" {
                base.join("index.html")
            } else {
                file_path
            };
            serve_file(file_path)
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 读取文件并从内存返回
fn serve_file(path: PathBuf) -> Response<Vec<u8>> {
    let mime = mime_for(&path);
    match fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Cache-Control", "no-store")
            .body(bytes)
            .unwrap(),
        Err(_) => Response::builder().status(404).body(Vec::new()).unwrap(),
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        _ => "application/octet-stream",
    }
}
