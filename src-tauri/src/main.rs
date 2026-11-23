// OpenCode Config Studio: a small native shell around the editor UI. The UI does parsing, validation and
// comment-preserving edits; this side only touches the disk, the network and the opencode executable.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const BUNDLED_SCHEMA: &str = include_str!("../../src/schema.json");
const BUNDLED_MODEL_SCHEMA: &str = include_str!("../../src/model-schema.json");
const SCHEMA_URL: &str = "https://opencode.ai/config.json";
const MODEL_SCHEMA_URL: &str = "https://models.dev/model-schema.json";
const MAX_BODY: u64 = 20 * 1024 * 1024;

static SAVING: AtomicBool = AtomicBool::new(false);

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

// OPENCODE_GUI_CONFIG, else ~/.config/opencode/opencode.json (or the .jsonc twin when only that exists).
fn config_path() -> PathBuf {
    if let Some(p) = std::env::var_os("OPENCODE_GUI_CONFIG") {
        return PathBuf::from(p);
    }
    let dir = home().join(".config").join("opencode");
    let json = dir.join("opencode.json");
    let jsonc = dir.join("opencode.jsonc");
    if !json.exists() && jsonc.exists() {
        jsonc
    } else {
        json
    }
}

// The Claude workers file read by the OpenCode bridge: CLAUDE_WORKERS_FILE, else ~/.claude/claude-workers.json.
fn workers_path() -> PathBuf {
    std::env::var_os("CLAUDE_WORKERS_FILE").map(PathBuf::from).unwrap_or_else(|| home().join(".claude").join("claude-workers.json"))
}

// "workers" is the Claude workers file; anything else (or nothing) is OpenCode's config.
fn path_for(file: &Option<String>) -> PathBuf {
    match file.as_deref() {
        Some("workers") => workers_path(),
        _ => config_path(),
    }
}

fn revision(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

// 2026-11-22T10-11-13-443Z, safe in file names
fn stamp() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[derive(Serialize)]
struct ConfigFile {
    raw: String,
    path: String,
    revision: String,
    exists: bool,
}

#[tauri::command]
fn config_read(file: Option<String>) -> Result<ConfigFile, String> {
    let path = path_for(&file);
    match fs::read(&path) {
        Ok(bytes) => Ok(ConfigFile {
            revision: revision(&bytes),
            raw: String::from_utf8(bytes).map_err(|_| "The configuration file is not UTF-8.".to_string())?,
            path: path.display().to_string(),
            exists: true,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ConfigFile {
            raw: if file.as_deref() == Some("workers") {
                "{\n  \"workers\": {}\n}\n".into()
            } else {
                "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n".into()
            },
            path: path.display().to_string(),
            revision: "missing".into(),
            exists: false,
        }),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

#[derive(Serialize)]
struct Saved {
    backup: Option<String>,
    revision: String,
}

// Writes only when the file still has the revision the editor loaded; backs it up, then replaces it atomically.
#[tauri::command]
fn config_write(text: String, revision_seen: String, file: Option<String>) -> Result<Saved, String> {
    if SAVING.swap(true, Ordering::SeqCst) {
        return Err("A save is already in progress.".into());
    }
    let result = (|| {
        let path = path_for(&file);
        let current = match fs::read(&path) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
        };
        let now = current.as_deref().map(revision).unwrap_or_else(|| "missing".into());
        if now != revision_seen {
            return Err("The file changed outside this editor. Reload it before saving (export your draft first).".into());
        }
        let dir = path.parent().ok_or("The configuration path has no folder.")?;
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        let backup = match &current {
            Some(bytes) => {
                let b = PathBuf::from(format!("{}.backup-{}", path.display(), stamp()));
                fs::write(&b, bytes).map_err(|e| format!("Could not write the backup {}: {e}", b.display()))?;
                Some(b.display().to_string())
            }
            None => None,
        };
        let temp = dir.join(format!(".{}.tmp-{}", path.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
        let write = || -> std::io::Result<()> {
            let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
            fs::rename(&temp, &path)
        };
        if let Err(e) = write() {
            let _ = fs::remove_file(&temp);
            return Err(format!("Could not save {}: {e}", path.display()));
        }
        Ok(Saved { backup, revision: revision(text.as_bytes()) })
    })();
    SAVING.store(false, Ordering::SeqCst);
    result
}

// The npm shim (opencode.cmd) is not an executable: find the real binary, wherever npm or Scoop put it.
fn find_opencode() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("OPENCODE_EXE") {
        return Some(PathBuf::from(p));
    }
    let exe = if cfg!(windows) { "opencode.exe" } else { "opencode" };
    let real = |dir: &Path| dir.join("node_modules").join("@opencode").join("cli").join("bin").join(exe);
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if real(&dir).is_file() {
                return Some(real(&dir));
            }
            if dir.join(exe).is_file() {
                return Some(dir.join(exe));
            }
        }
    }
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from).unwrap_or_default();
    let h = home();
    [
        real(&h.join("scoop").join("apps").join("nodejs").join("current").join("bin")),
        real(&h.join("scoop").join("persist").join("nodejs").join("bin")),
        real(&env("APPDATA").join("npm")),
        env("LOCALAPPDATA").join("Programs").join("opencode").join(exe),
        h.join(".opencode").join("bin").join(exe),
        h.join(".local").join("bin").join(exe),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

// Runs opencode with fixed arguments (no window), up to 20 s; stdout on success.
fn run_opencode(args: &'static [&'static str]) -> Result<String, String> {
    let exe = find_opencode().ok_or("OpenCode executable not found. Set OPENCODE_EXE to its full path.")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = Command::new(&exe);
        cmd.args(args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let _ = tx.send(cmd.output());
    });
    let what = args.join(" ");
    match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(out)) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        Ok(Ok(out)) => Err(format!("opencode {what} failed: {}", String::from_utf8_lossy(&out.stderr).trim())),
        Ok(Err(e)) => Err(format!("Could not run OpenCode: {e}")),
        Err(_) => Err(format!("opencode {what} did not finish within 20 s.")),
    }
}

#[tauri::command]
async fn opencode_reload() -> Result<String, String> {
    let text = tauri::async_runtime::spawn_blocking(|| run_opencode(&["reload"])).await.map_err(|e| e.to_string())??;
    Ok(if text.is_empty() { "Configuration reloaded".into() } else { text })
}

// Every model OpenCode knows (cloud and local) with its effort variants: feeds the model pickers.
#[tauri::command]
async fn opencode_models() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| run_opencode(&["api", "model.list"])).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct HttpReply {
    status: u16,
    body: String,
}

// {env:NAME} in header values, as OpenCode itself allows in the config
fn expand_env(v: &str) -> String {
    let mut out = String::new();
    let mut rest = v;
    while let Some(i) = rest.find("{env:") {
        out.push_str(&rest[..i]);
        match rest[i..].find('}') {
            Some(j) => {
                out.push_str(&std::env::var(&rest[i + 5..i + j]).unwrap_or_default());
                rest = &rest[i + j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out + rest
}

fn get(url: &str, headers: &HashMap<String, String>, timeout: Duration) -> Result<HttpReply, String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Use an HTTP(S) URL.".into());
    }
    let authority = url.splitn(4, '/').nth(2).unwrap_or("");
    if authority.contains('@') {
        return Err("Put credentials in the API key field, not in the URL.".into());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let mut req = agent.get(url);
    for (k, v) in headers {
        req = req.header(k.as_str(), expand_env(v).as_str());
    }
    let mut resp = req.call().map_err(|e| format!("{url}: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.body_mut().with_config().limit(MAX_BODY).read_to_string().map_err(|e| format!("{url}: {e}"))?;
    Ok(HttpReply { status, body })
}

// Discovery and LM Studio status: GET only, no redirects, no credentials in URLs, 10 s, 20 MB.
#[tauri::command]
async fn http_get(url: String, headers: Option<HashMap<String, String>>, timeout_ms: Option<u64>) -> Result<HttpReply, String> {
    let t = Duration::from_millis(timeout_ms.unwrap_or(10_000).clamp(500, 30_000));
    tauri::async_runtime::spawn_blocking(move || get(&url, &headers.unwrap_or_default(), t)).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct SchemaSet {
    source: String,
    schema: String,
    model_schema: String,
}

fn cache_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok()
}

// Schema candidates, best first: live from opencode.ai, the last live copy that compiled, the bundled snapshot.
#[tauri::command]
async fn schema_candidates(app: tauri::AppHandle) -> Result<Vec<SchemaSet>, String> {
    let dir = cache_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let none = HashMap::new();
        let fetch = |u: &str| get(u, &none, Duration::from_secs(8)).ok().filter(|r| r.status == 200 && r.body.trim_start().starts_with('{'));
        if let (Some(s), Some(m)) = (fetch(SCHEMA_URL), fetch(MODEL_SCHEMA_URL)) {
            out.push(SchemaSet { source: "live".into(), schema: s.body, model_schema: m.body });
        }
        if let Some(d) = dir {
            if let (Ok(s), Ok(m)) = (fs::read_to_string(d.join("schema.json")), fs::read_to_string(d.join("model-schema.json"))) {
                out.push(SchemaSet { source: "cached".into(), schema: s, model_schema: m });
            }
        }
        out.push(SchemaSet { source: "bundled".into(), schema: BUNDLED_SCHEMA.into(), model_schema: BUNDLED_MODEL_SCHEMA.into() });
        out
    })
    .await
    .map_err(|e| e.to_string())
}

// Called by the UI once a live schema compiled, so the next offline start uses it.
#[tauri::command]
fn schema_cache_save(app: tauri::AppHandle, schema: String, model_schema: String) -> Result<(), String> {
    let d = cache_dir(&app).ok_or("no cache folder")?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    fs::write(d.join("schema.json"), schema).map_err(|e| e.to_string())?;
    fs::write(d.join("model-schema.json"), model_schema).map_err(|e| e.to_string())
}

// Opens documentation links in the default browser (https only).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened.".into());
    }
    #[cfg(windows)]
    let r = Command::new("explorer").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        // one editor per file: starting it again brings the open window forward instead
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![config_read, config_write, opencode_reload, opencode_models, http_get, schema_candidates, schema_cache_save, open_url])
        .run(tauri::generate_context!())
        .expect("error while running OpenCode Config Studio");
}
