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
mod worker_auth;

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

// The bridge's worker list (what Claude may run): BRIDGE_WORKERS_FILE, else ~/.config/opencode-bridge/workers.json.
fn workers_path() -> PathBuf {
    std::env::var_os("BRIDGE_WORKERS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config").join("opencode-bridge").join("workers.json"))
}

// The Claude workers file from before the one list: CLAUDE_WORKERS_FILE, else ~/.claude/claude-workers.json.
// Only read, to make the first list from it.
fn legacy_workers_path() -> PathBuf {
    std::env::var_os("CLAUDE_WORKERS_FILE").map(PathBuf::from).unwrap_or_else(|| home().join(".claude").join("claude-workers.json"))
}

// "workers" is the bridge's worker list, "workers_legacy" the earlier Claude workers file; anything else (or
// nothing) is OpenCode's config.
fn path_for(file: &Option<String>) -> PathBuf {
    match file.as_deref() {
        Some("workers") => workers_path(),
        Some("workers_legacy") => legacy_workers_path(),
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
            raw: if matches!(file.as_deref(), Some("workers") | Some("workers_legacy")) {
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
    if file.as_deref() == Some("workers_legacy") {
        return Err("The earlier Claude workers file is only read.".into());
    }
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

fn studio_opencode_program() -> Option<PathBuf> {
    // Keep explicit overrides even if invalid: Studio reports their launch error, not "not found".
    if let Some(p) = std::env::var_os("OPENCODE_EXE") {
        return Some(PathBuf::from(p));
    }
    let path = std::env::var_os("PATH");
    let dirs: Vec<_> = path.iter().flat_map(std::env::split_paths).collect();
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
    let h = home();
    let shared_home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if legacy_search_needed(&dirs, &h, shared_home.as_deref(), &appdata, &local) {
        legacy_opencode_search(&dirs, &h, &appdata, &local, Path::is_file)
    } else {
        opencode_cli::find_program()
    }
}

fn legacy_search_needed(dirs: &[PathBuf], home: &Path, shared_home: Option<&Path>, appdata: &Path, local: &Path) -> bool {
    shared_home != Some(home)
        || [home, appdata, local].into_iter().chain(dirs.iter().map(PathBuf::as_path)).any(|p| !p.is_absolute())
}

// The shared finder excludes relative paths and uses a platform-specific home variable.
// Keep Studio's original search order when relative candidates or a different home are possible.
fn legacy_opencode_search(
    dirs: &[PathBuf],
    home: &Path,
    appdata: &Path,
    local: &Path,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "opencode.exe" } else { "opencode" };
    let real = |dir: &Path| dir.join("node_modules").join("@opencode").join("cli").join("bin").join(exe);
    dirs.iter()
        .flat_map(|dir| [real(dir), dir.join(exe)])
        .chain([
            real(&home.join("scoop/apps/nodejs/current/bin")),
            real(&home.join("scoop/persist/nodejs/bin")),
            real(&appdata.join("npm")),
            local.join("Programs/opencode").join(exe),
            home.join(".opencode/bin").join(exe),
            home.join(".local/bin").join(exe),
        ])
        .find(|p| is_file(p))
}

fn studio_opencode(args: &'static [&'static str], secs: u64) -> Result<String, String> {
    let exe = studio_opencode_program().ok_or("OpenCode executable not found. Set OPENCODE_EXE to its full path.")?;
    // Studio's deadline stops waiting but does not terminate the CLI (which may be reloading or restarting).
    wait_for_opencode(args, secs, move || opencode_cli::run(Command::new(exe), args, Duration::MAX))
}

fn wait_for_opencode(
    args: &[&str],
    secs: u64,
    work: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    rx.recv_timeout(Duration::from_secs(secs))
        .unwrap_or_else(|_| Err(format!("opencode {} did not finish within {secs} s.", args.join(" "))))
}

#[tauri::command]
async fn opencode_reload() -> Result<String, String> {
    let text = tauri::async_runtime::spawn_blocking(|| studio_opencode(&["reload"], 20)).await.map_err(|e| e.to_string())??;
    Ok(if text.is_empty() { "Configuration reloaded".into() } else { text })
}

// How many OpenCode sessions are working right now: a restart interrupts them, so the window asks first.
// `None` when the service does not answer (it is down or failed to start), which a restart is the cure for.
#[tauri::command]
async fn opencode_active() -> Result<Option<usize>, String> {
    // The crate's active_sessions only counts entries of type "running"; Studio warns for every entry.
    let out = tauri::async_runtime::spawn_blocking(|| studio_opencode(&["api", "session.active"], 20)).await.map_err(|e| e.to_string())?;
    Ok(out.ok().and_then(|text| active_count(&text)))
}

fn active_count(text: &str) -> Option<usize> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    Some(v.get("data")?.as_object()?.len())
}

// Stops the background service and starts a fresh one: for what a reload does not reach (plugins, MCP
// servers, providers, a service that failed at boot). If the restart itself fails, stop and start apart.
#[tauri::command]
async fn opencode_restart() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| restart_with(studio_opencode))
        .await
        .map_err(|e| e.to_string())?
}

fn restart_with(mut run: impl FnMut(&'static [&'static str], u64) -> Result<String, String>) -> Result<String, String> {
    if run(&["service", "restart"], 60).is_err() {
        let _ = run(&["service", "stop"], 30);
        run(&["service", "start"], 60)?;
    }
    // Unlike the crate's restart_service, Studio treats any successful exit as an answer.
    run(&["api", "session.active"], 60).map_err(|e| format!("OpenCode restarted but does not answer: {e}"))?;
    Ok("OpenCode restarted".into())
}

// Every model OpenCode knows (cloud and local) with its effort variants: feeds the model pickers.
#[tauri::command]
async fn opencode_models() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| studio_opencode(&["api", "model.list"], 20)).await.map_err(|e| e.to_string())?
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

// ---- the bridge: is it installed and registered, and a way to install or update it ----

const BRIDGE_SERVER_URL: &str = "https://raw.githubusercontent.com/Kaan88/claude-flash-bridge/main/server.mjs";
const BRIDGE_SETUP_PS1: &str = "https://raw.githubusercontent.com/Kaan88/claude-flash-bridge/main/setup.ps1";
const BRIDGE_SETUP_SH: &str = "https://raw.githubusercontent.com/Kaan88/claude-flash-bridge/main/setup.sh";

#[derive(Serialize)]
struct BridgeStatus {
    dir: String,
    installed: bool,
    version: Option<String>,
    latest: Option<String>,
    claude_code: bool,
    claude_desktop: bool,
    node: bool,
    claude: bool,
    opencode: bool,
    command: String,
}

fn desktop_config() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("Claude").join("claude_desktop_config.json")
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support").join("Claude").join("claude_desktop_config.json")
    } else {
        home().join(".config").join("Claude").join("claude_desktop_config.json")
    }
}

// The server.mjs a Claude configuration file starts under the name "opencode", if any. Nothing else of the
// file leaves this function.
fn registered_server(file: &Path) -> Option<PathBuf> {
    let v: serde_json::Value = serde_json::from_slice(&fs::read(file).ok()?).ok()?;
    let args = v.get("mcpServers")?.get("opencode")?.get("args")?.as_array()?;
    args.iter().filter_map(|a| a.as_str()).find(|a| a.ends_with("server.mjs")).map(PathBuf::from)
}

// serverInfo: { name: "opencode-agent", version: "3.0.0" } in the bridge's server.mjs
fn server_version(text: &str) -> Option<String> {
    if let Some((_, version)) = text.split_once("const VERSION = \"") {
        return Some(version.split_once('"')?.0.to_string());
    }
    let rest = &text[text.find("serverInfo:")?..];
    let from = rest.find("version: \"")? + 10;
    let len = rest[from..].find('"')?;
    Some(rest[from..from + len].to_string())
}

fn on_path(name: &str) -> bool {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| exts.iter().any(|e| dir.join(format!("{name}{e}")).is_file())))
        .unwrap_or(false)
}

// The one-step setup of the bridge's README: installs what is missing, updates the bridge, registers it.
fn bridge_setup_command() -> String {
    if cfg!(windows) {
        format!("irm {BRIDGE_SETUP_PS1} | iex")
    } else {
        format!("curl -fsSL {BRIDGE_SETUP_SH} | bash")
    }
}

#[tauri::command]
async fn bridge_status() -> Result<BridgeStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let code = registered_server(&home().join(".claude.json"));
        let desktop = registered_server(&desktop_config());
        let server = code
            .clone()
            .or_else(|| desktop.clone())
            .unwrap_or_else(|| home().join(".claude").join("mcp-servers").join("opencode-agent").join("server.mjs"));
        let text = fs::read_to_string(&server).ok();
        let none = HashMap::new();
        let latest = get(BRIDGE_SERVER_URL, &none, Duration::from_secs(6)).ok().filter(|r| r.status == 200).and_then(|r| server_version(&r.body));
        let claude_exe = if cfg!(windows) { "claude.exe" } else { "claude" };
        BridgeStatus {
            dir: server.parent().map(|p| p.display().to_string()).unwrap_or_default(),
            installed: text.is_some(),
            version: text.as_deref().and_then(server_version),
            latest,
            claude_code: code.is_some(),
            claude_desktop: desktop.is_some(),
            node: on_path("node"),
            claude: on_path("claude") || home().join(".local").join("bin").join(claude_exe).is_file(),
            opencode: studio_opencode_program().is_some(),
            command: bridge_setup_command(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

// Opens a terminal that runs the bridge's own setup script (the command its README gives), so its questions
// (a DeepSeek key, typed into OpenCode's own prompt) and its output are in front of the user.
#[tauri::command]
fn bridge_install() -> Result<String, String> {
    #[cfg(windows)]
    {
        let command = bridge_setup_command();
        Command::new("cmd")
            .args(["/c", "start", "OpenCode bridge setup", "powershell", "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command.as_str()])
            .spawn()
            .map(|_| "A terminal window is running the setup. When it finishes, press Check again.".to_string())
            .map_err(|e| format!("Could not open a terminal: {e}"))
    }
    #[cfg(not(windows))]
    {
        Err(format!("Run this in a terminal: {}", bridge_setup_command()))
    }
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
        .invoke_handler(tauri::generate_handler![
            config_read,
            config_write,
            opencode_reload,
            opencode_active,
            opencode_restart,
            opencode_models,
            http_get,
            schema_candidates,
            schema_cache_save,
            open_url,
            bridge_status,
            worker_auth::worker_auth_status,
            worker_auth::worker_auth_key,
            worker_auth::worker_auth_terminal,
            bridge_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenCode Config Studio");
}

#[cfg(test)]
mod opencode_tests {
    use super::{active_count, legacy_opencode_search, legacy_search_needed, restart_with, wait_for_opencode};
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn the_active_sessions_are_counted_and_anything_else_is_unknown() {
        assert_eq!(active_count(r#"{"data":{}}"#), Some(0));
        assert_eq!(active_count(r#"{"data":{"ses_a":{"type":"running"},"ses_b":{"type":"waiting"}}}"#), Some(2));
        assert_eq!(active_count("Error: Background service failed to start"), None);
        assert_eq!(active_count(r#"{"data":[]}"#), None);
    }

    #[test]
    fn restart_accepts_a_non_json_answer_and_only_falls_back_if_restart_fails() {
        let mut calls = Vec::new();
        let result = restart_with(|args, secs| {
            calls.push((args.join(" "), secs));
            Ok("not JSON".into())
        });
        assert_eq!(result, Ok("OpenCode restarted".into()));
        assert_eq!(calls, [("service restart".to_owned(), 60), ("api session.active".to_owned(), 60)]);
    }

    #[test]
    fn restart_ignores_stop_errors_and_reports_a_failed_probe() {
        let mut calls = Vec::new();
        let result = restart_with(|args, secs| {
            calls.push((args.join(" "), secs));
            match args {
                ["service", "start"] => Ok(String::new()),
                ["api", "session.active"] => Err("probe failed".into()),
                _ => Err("service command failed".into()),
            }
        });
        assert_eq!(result, Err("OpenCode restarted but does not answer: probe failed".into()));
        assert_eq!(calls, [
            ("service restart".to_owned(), 60), ("service stop".to_owned(), 30),
            ("service start".to_owned(), 60), ("api session.active".to_owned(), 60),
        ]);
    }

    #[test]
    fn failed_start_is_reported_without_probing() {
        let result = restart_with(|args, _| match args {
            ["service", "start"] => Err("start failed".into()),
            ["service", "restart" | "stop"] => Err("restart or stop failed".into()),
            _ => panic!("must not probe after a failed start"),
        });
        assert_eq!(result, Err("start failed".into()));
    }

    #[test]
    fn timeout_keeps_studios_message_and_lets_work_finish() {
        let (release, blocked) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        assert_eq!(
            wait_for_opencode(&["api", "model.list"], 0, move || {
                blocked.recv().unwrap();
                done.send(()).unwrap();
                Ok(String::new())
            }),
            Err("opencode api model.list did not finish within 0 s.".into()),
        );
        release.send(()).unwrap();
        finished.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            wait_for_opencode(&["reload"], 20, || Err("Could not run OpenCode: test".into())),
            Err("Could not run OpenCode: test".into()),
        );
    }

    #[test]
    fn an_earlier_relative_path_keeps_precedence_over_an_absolute_executable() {
        let absolute = Path::new(if cfg!(windows) { r"C:\studio-fixture" } else { "/studio-fixture" });
        let dirs = [PathBuf::from("relative"), absolute.to_path_buf()];
        let exe = if cfg!(windows) { "opencode.exe" } else { "opencode" };
        let relative_exe = dirs[0].join(exe);
        let absolute_exe = dirs[1].join(exe);
        assert!(legacy_search_needed(&dirs, absolute, Some(absolute), absolute, absolute));
        assert!(!legacy_search_needed(&dirs[1..], absolute, Some(absolute), absolute, absolute));
        assert!(legacy_search_needed(&dirs[1..], absolute, None, absolute, absolute));
        assert!(legacy_search_needed(&dirs[1..], absolute, Some(absolute), absolute, Path::new("")));
        assert_eq!(
            legacy_opencode_search(&dirs, absolute, absolute, absolute, |p| p == relative_exe || p == absolute_exe),
            Some(relative_exe),
        );
    }
}
