// App state: the draft config, file revision, schema, OpenCode's live model catalog, and save/load.
import { decode, isFreeModel, isLocalUrl, makeValidator, mergeText } from "./core.js";

export const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

export const S = {
  config: {},
  revision: "",
  path: "",
  exists: true,
  dirty: false,
  check: () => {},
  schema: null,
  schemaSource: "",
  catalog: [], // { provider, id, name, variants[] } from `opencode api model.list`
  catalogError: "",
  page: "models",
  rawDraft: null, // text of the raw JSON editor while it has edits
};

let renderFn = () => {};
export const setRender = (f) => (renderFn = f);
export const render = () => renderFn();

const dirtyListeners = [];
export const onDirty = (f) => dirtyListeners.push(f);
export function mark() {
  S.dirty = true;
  dirtyListeners.forEach((f) => f());
}
function clean() {
  S.dirty = false;
  dirtyListeners.forEach((f) => f());
}

// Applies a pending raw-JSON edit to the draft (throws if it isn't valid JSON).
export function applyRaw() {
  if (S.rawDraft === null) return;
  try {
    S.config = JSON.parse(S.rawDraft);
  } catch (e) {
    throw Error(`The raw JSON has an error: ${e.message}. Fix it or discard your changes.`);
  }
  S.rawDraft = null;
}

export async function loadFile() {
  const r = await invoke("config_read");
  S.config = decode(r.raw);
  S.revision = r.revision;
  S.path = r.path;
  S.exists = r.exists;
  S.rawDraft = null;
  clean();
}

// Re-reads the file, rewrites only the changed fields (comments survive), validates, writes atomically.
export async function saveFile() {
  applyRaw();
  const bad = [...document.querySelectorAll("input,textarea")].find((e) => !e.checkValidity());
  if (bad) {
    bad.reportValidity();
    throw Error("Fix the highlighted field before saving.");
  }
  S.check(S.config);
  const disk = await invoke("config_read");
  if (disk.revision !== S.revision) throw Error("The file changed outside this editor. Reload it before saving (copy your edits from Advanced → Raw JSON first).");
  const text = disk.exists ? mergeText(disk.raw, decode(disk.raw), S.config) : JSON.stringify(S.config, null, 2) + "\n";
  S.check(decode(text));
  const r = await invoke("config_write", { text, revisionSeen: S.revision });
  S.revision = r.revision;
  S.exists = true;
  clean();
  return r;
}

// Live schema from opencode.ai when it compiles, else the last live copy, else the bundled snapshot.
export async function loadSchema() {
  const sets = await invoke("schema_candidates");
  let first;
  for (const s of sets) {
    try {
      const schema = JSON.parse(s.schema);
      S.check = makeValidator(schema, JSON.parse(s.model_schema));
      S.schema = schema;
      S.schemaSource = s.source;
      if (s.source === "live") invoke("schema_cache_save", { schema: s.schema, modelSchema: s.model_schema }).catch(() => {});
      return;
    } catch (e) {
      first ??= e;
    }
  }
  throw Error(`No usable configuration schema: ${first?.message || "unknown error"}`);
}

export async function loadCatalog() {
  try {
    const j = JSON.parse(await invoke("opencode_models"));
    const rows = Array.isArray(j) ? j : j.data || [];
    S.catalog = rows
      .filter((m) => m.enabled !== false && (!m.type || m.type === "chat"))
      .map((m) => ({ provider: m.providerID, id: m.id, name: m.name || m.id, variants: (m.variants || []).map((v) => v.id), free: isFreeModel(m), local: isLocalUrl(m.settings?.baseURL) }));
    S.catalogError = "";
  } catch (e) {
    S.catalog = [];
    S.catalogError = e?.message || String(e);
  }
}
