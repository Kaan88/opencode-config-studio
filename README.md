# OpenCode Config Studio

A desktop editor for OpenCode's `~/.config/opencode/opencode.json`, shared by the CLI and OpenCode Desktop.
It is one executable, `OpenCodeConfigStudio.exe` (about 5 MB), and needs nothing else: it runs on WebView2, which
ships with Windows 10/11.

OpenCode can sign in to its built-in providers (`opencode auth login`) but has no way to add your own backends.
This fills that gap: LM Studio, llama.cpp, Strata and any other OpenAI-compatible server.

## What it does

Three pages; everyday edits are plain switches and fields, no JSON.

- **Models.** The default model, then one card per server with its models in a table: display name, context,
  max output (type `32k` or `1m`), tools, vision, reasoning (Auto / Off / On), default, enabled. Expand a row for effort
  levels (chips) and the default effort, max input, temperature, server model ID, rename, duplicate, delete, or all fields.
  - **Add server** with presets: LM Studio, Ollama, llama.cpp, vLLM, or any OpenAI-compatible server. Its models are
    imported right after.
  - **Sync models** compares the server with your config. LM Studio's native API gives each model's context (the loaded
    context when loaded, else its maximum), vision, tool use and load state; embedding models are skipped. Other servers
    give IDs. You tick what to add, update or remove (removals start unticked).
  - When a server doesn't answer and the same server answers on this PC (for example LM Studio moved from another
    machine to this one), it offers to switch the URL.
  - Each card shows the server as online (models served, and loaded for LM Studio) or offline.
- **Agents.** The default agent, then each agent: model and effort (from every model OpenCode knows, read live), mode,
  description, enabled, read-only (denies edits, shell and subagents), hidden, instructions; permissions and every other
  field behind "Permissions & all fields".
- **Advanced.** Every other setting through a form generated from OpenCode's schema, and the raw JSON.
- **Reload OpenCode** runs `opencode reload` so the running service picks up the saved file.

## Safe saving

- Validated against the schema before anything is written. The schema is fetched live from opencode.ai at start;
  offline it uses the last downloaded copy, then the snapshot inside the exe. The footer says which.
- Only the changed fields are rewritten, so JSONC comments and formatting elsewhere stay.
- Refuses to save if the file changed on disk since it was loaded (copy your edits from Advanced → Raw JSON, reload, re-apply).
- A timestamped backup (`opencode.json.backup-…`) is written beside the file, then the file is replaced atomically.
- A save bar appears while there are unsaved changes; Ctrl+S saves. Closing the window with unsaved changes asks first.
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
`src/main.js` (shell), `src/pages/` (Models, Agents, Advanced), `src/pickers.js` (model + effort picker), `src/backend.js` (server listing and status), `src/schemaEditor.js` (generic schema form), `src-tauri/src/main.rs` (file access, HTTP GET for servers, `opencode reload` and `opencode api model.list`, schema download).
