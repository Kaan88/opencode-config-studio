// App state: the draft config, file revision, schema, OpenCode's live model catalog, and save/load.
import { checkWorkers, decode, isFreeModel, isLocalUrl, makeValidator, mergeText, migrateWorkers } from "./core.js";

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
  base: "", // the config as loaded, to tell whether it needs writing
  workers: { workers: {} }, // the bridge's worker list: what Claude may run
  workersRev: "",
  workersPath: "",
  workersBase: "",
  workersImported: false, // the list is not on disk yet: it was made from the earlier Claude workers file
  bridge: null, // the bridge's install state (the Bridge page)
  bridgeError: "",
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
  S.base = JSON.stringify(S.config);
  const w = await invoke("config_read", { file: "workers" });
  const parse = (f) => {
    try {
      return JSON.parse(f.raw);
    } catch (e) {
      throw Error(`${f.path} is not valid JSON (${e.message}). Fix or delete it, then reload.`);
    }
  };
  // no list yet: show what the bridge uses meanwhile (the default agent and the earlier Claude workers file)
  S.workersImported = !w.exists;
  S.workers = w.exists ? parse(w) : migrateWorkers(parse(await invoke("config_read", { file: "workers_legacy" })), S.config.agents || {});
  S.workers.workers ??= {};
  S.workersRev = w.revision;
  S.workersPath = w.path;
  S.workersBase = JSON.stringify(S.workers);
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
  const configChanged = JSON.stringify(S.config) !== S.base;
  const workersChanged = JSON.stringify(S.workers) !== S.workersBase;
  // check everything before writing anything
  if (configChanged) S.check(S.config);
  if (workersChanged) checkWorkers(S.workers);
  let r = {};
  if (configChanged) {
    const disk = await invoke("config_read");
    if (disk.revision !== S.revision) throw Error("The file changed outside this editor. Reload it before saving (copy your edits from Advanced → Raw JSON first).");
    const text = disk.exists ? mergeText(disk.raw, decode(disk.raw), S.config) : JSON.stringify(S.config, null, 2) + "\n";
    S.check(decode(text));
    r = await invoke("config_write", { text, revisionSeen: S.revision });
    S.revision = r.revision;
    S.exists = true;
    S.base = JSON.stringify(S.config);
  }
  if (workersChanged) {
    const disk = await invoke("config_read", { file: "workers" });
    if (disk.revision !== S.workersRev) throw Error(`${S.workersPath} changed outside this editor. Reload before saving.`);
    const w = await invoke("config_write", { text: JSON.stringify(S.workers, null, 2) + "\n", revisionSeen: S.workersRev, file: "workers" });
    S.workersRev = w.revision;
    S.workersBase = JSON.stringify(S.workers);
    S.workersImported = false;
    r.backup ||= w.backup;
    r.workers = true;
  }
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
