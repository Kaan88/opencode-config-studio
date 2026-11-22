# OpenCode Config Studio

A desktop editor for OpenCode's `~/.config/opencode/opencode.json`, shared by the CLI and OpenCode Desktop.
It is one executable, `OpenCodeConfigStudio.exe` (about 10 MB), and needs nothing else: it runs on WebView2, which
ships with Windows 10/11.

OpenCode can sign in to its built-in providers (`opencode auth login`) but has no way to add your own backends.
This fills that gap: LM Studio, llama.cpp, Strata and any other OpenAI-compatible server.

## What it does

- **Backends and models:** add, rename, duplicate and delete backends and models; pick the default model; set context
  and output limits, tool calling, image input, reasoning, variants, request settings, body, headers and compatibility.
- **Every setting:** forms are generated from OpenCode's official schema, so every field it knows is editable, plus a
  raw JSON view.
- **Sync models with server:** compares a backend with your config.
  - LM Studio (native API): new models (embeddings skipped), each model's real context (the loaded context when loaded,
    else its maximum), image input for vision models, tool use, and whether it is loaded;
  - other servers (`/models`): new and missing model IDs only;
  - you tick what to add, update, or remove (removals start unticked).
- **Status:** the overview shows each backend as online (with how many models it serves and, for LM Studio, how many
  are loaded) or offline.
- **Reload OpenCode:** runs `opencode reload` so the running service picks up the saved file. The executable is found
  the way npm and Scoop install it (or set `OPENCODE_EXE`).

## Safe saving

- Validated against the schema before anything is written. The schema is fetched live from opencode.ai at start;
  offline it uses the last downloaded copy, then the snapshot inside the exe. The footer says which.
- Only the changed fields are rewritten, so JSONC comments and formatting elsewhere stay.
- Refuses to save if the file changed on disk since it was loaded (export your draft, reload, re-apply).
- A timestamped backup (`opencode.json.backup-…`) is written beside the file, then the file is replaced atomically.
- Closing the window with unsaved changes asks first. Ctrl+S saves.
- API keys can be `{env:VARIABLE_NAME}`; keys typed in directly end up in the file and its backups.

## Settings

| Variable | |
|---|---|
| `OPENCODE_GUI_CONFIG` | edit another JSON/JSONC file |
| `OPENCODE_EXE` | full path to `opencode.exe` if it isn't found |

## Build

Needs Node 18+, Rust and the Tauri CLI (`cargo install tauri-cli --version ^2`).

```powershell
npm install
npm test
npm run build
```

The exe is `src-tauri/target/release/OpenCodeConfigStudio.exe`. In a deeply nested folder the MSVC linker can hit
Windows' 260-character path limit (`LNK1104`); build with a short `CARGO_TARGET_DIR` (e.g. `$env:CARGO_TARGET_DIR="C:\t\ocs"`),
and the exe lands in `<that>\release\`. `npm run dev` runs it with live reload of the Rust side.

Layout: `src/core.js` (parsing, validation, comment-preserving edits, sync planning; tested in `test/`),
`src/main.js` (the UI), `src-tauri/src/main.rs` (file access, HTTP GET for discovery, `opencode reload`, schema download).
