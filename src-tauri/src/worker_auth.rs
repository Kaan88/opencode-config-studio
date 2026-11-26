// Studio doesn't open either SQLite database. Use the trusted installed bridge helper:
// it coordinates with running jobs and delegates login/logout and key storage to OpenCode.
use super::{desktop_config, home, registered_server, studio_opencode_program};
use serde_json::Value;
use std::{fs, io::Write, path::PathBuf, process::{Command, Stdio}};

fn helper() -> Result<Command, String> {
    let server = registered_server(&home().join(".claude.json"))
        .or_else(|| registered_server(&desktop_config()))
        .unwrap_or_else(|| home().join(".claude/mcp-servers/opencode-agent/server.mjs"));
    // A coordinator can stage sign-ins before installing the new bridge. This
    // override comes only from the launching process, never the WebView or contract.
    let script = std::env::var_os("STUDIO_WORKER_AUTH_HELPER").map(PathBuf::from)
        .unwrap_or_else(|| server.with_file_name("bridge-auth.mjs"));
    if !script.is_absolute() || !script.is_file() {
        return Err("Install bridge 3.4.0 or newer to manage worker sign-ins.".into());
    }
    let root = std::env::var_os("BRIDGE_JOB_HOME").map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config/opencode-bridge"));
    let mut cmd = Command::new("node");
    cmd.arg(script).env("BRIDGE_JOB_HOME", &root);
    if let Some(exe) = studio_opencode_program() { cmd.env("OPENCODE_EXE", exe); }
    // Missing on a first install: the helper publishes it. Never run a command or
    // send a secret to an address supplied by the contract; the helper checks identity.
    let contract = root.join("job-service.json");
    if contract.exists() {
        let err = || "Cannot read the worker service profile. Check the bridge installation.".to_string();
        let v: Value = serde_json::from_slice(&fs::read(contract).map_err(|_| err())?).map_err(|_| err())?;
        if v["version"] != 1 { return Err(err()); }
        for (key, field) in [("OPENCODE_CONFIG_DIR", &v["sourceConfig"]), ("BRIDGE_JOB_CONFIG_DIR", &v["env"]["OPENCODE_CONFIG_DIR"]), ("BRIDGE_WORKERS_FILE", &v["workers"])] {
            let path = field.as_str().ok_or_else(err)?;
            if !std::path::Path::new(path).is_absolute() { return Err(err()); }
            cmd.env(key, path);
        }
    }
    Ok(cmd)
}
fn provider_id(id: &str) -> bool {
    id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
#[tauri::command]
pub async fn worker_auth_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = helper()?.arg("status").stdin(Stdio::null()).stderr(Stdio::null()).output()
            .map_err(|_| "Could not start the worker sign-in helper.")?;
        if !out.status.success() { return Err("Could not read worker sign-ins. Check the bridge installation.".into()); }
        serde_json::from_slice(&out.stdout).map_err(|_| "Invalid worker sign-in status.".into())
    }).await.map_err(|_| "Worker sign-in check failed.")?
}
#[tauri::command]
pub async fn worker_auth_key(provider: String, key: String) -> Result<(), String> {
    let mut bytes = key.into_bytes();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            if !provider_id(&provider) || bytes.is_empty() || bytes.len() > 65536 { return Err("Invalid provider or key.".into()); }
            let mut proc = helper()?.args(["key", &provider]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().map_err(|_| "Could not start worker key entry.")?;
            let sent = proc.stdin.take().unwrap().write_all(&bytes);
            bytes.fill(0);
            if !proc.wait().is_ok_and(|s| s.success()) || sent.is_err() { return Err("OpenCode could not save the worker key.".into()); }
            Ok(())
        })();
        bytes.fill(0);
        result
    }).await.map_err(|_| "Worker key entry failed.")?
}
#[tauri::command]
pub fn worker_auth_terminal(action: String, provider: String) -> Result<(), String> {
    if !provider_id(&provider) || !matches!(action.as_str(), "login" | "logout") { return Err("Invalid worker sign-in action.".into()); }
    let cmd = helper()?;
    #[cfg(windows)]
    {
        // Start a real terminal for OpenCode's account picker/browser flow. No user
        // strings are interpolated into PowerShell source or put in a shell command.
        let mut ps = Command::new("powershell");
        for (name, val) in cmd.get_envs() { if let Some(v) = val { ps.env(name, v); } }
        ps.env("STUDIO_AUTH_HELPER", cmd.get_args().next().unwrap())
            .env("STUDIO_AUTH_ACTION", action).env("STUDIO_AUTH_PROVIDER", provider)
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; Start-Process node -ArgumentList @(([char]34 + $env:STUDIO_AUTH_HELPER + [char]34), $env:STUDIO_AUTH_ACTION, $env:STUDIO_AUTH_PROVIDER)"])
            .status().map_err(|_| "Could not open a worker sign-in terminal.")?
            .success().then_some(()).ok_or_else(|| "Could not open a worker sign-in terminal.".into())
    }
    #[cfg(not(windows))]
    { Err(format!("In a terminal run: node \"{}\" {} {}", PathBuf::from(cmd.get_args().next().unwrap()).display(), action, provider)) }
}
