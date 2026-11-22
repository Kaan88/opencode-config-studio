// Pure logic shared by the app and the tests: JSONC parsing, schema validation, comment-preserving edits,
// and model sync planning. No DOM, no Tauri.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { applyEdits, modify, parse } from "jsonc-parser";

export const MODEL_SCHEMA_ID = "https://models.dev/model-schema.json";

export function decode(text) {
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !config || Array.isArray(config) || typeof config !== "object") throw Error("The configuration is not a valid JSON/JSONC object.");
  return config;
}

// Compiles a validator for the OpenCode config schema; throws if the schema itself can't be compiled.
export function makeValidator(schema, modelSchema) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  if (modelSchema) ajv.addSchema(modelSchema, MODEL_SCHEMA_ID);
  const validate = ajv.compile(schema);
  return (config) => {
    if (!validate(config)) throw Error(ajv.errorsText(validate.errors, { separator: "\n", dataVar: "config" }));
  };
}

// Updates only the changed leaves so JSONC comments and unrelated formatting survive.
export function mergeText(text, before, after, keys = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return text;
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) text = mergeText(text, before[key], after[key], [...keys, key]);
    return text;
  }
  return applyEdits(text, modify(text, keys, after, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
}

// Normalises a backend's model listing. LM Studio's native API (/api/v0/models) reports type, load state,
// context length and tool use; any other OpenAI-compatible server only gives ids (/v1/models).
export function normaliseListing(body, native) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return rows
    .filter((m) => m && typeof m.id === "string" && (!native || m.type !== "embeddings"))
    .map((m) => ({
      id: m.id,
      name: m.meta?.label || m.display_name || m.id,
      loaded: native ? m.state === "loaded" : undefined,
      context: native ? m.loaded_context_length || m.max_context_length || undefined : undefined,
      vision: native ? m.type === "vlm" || (Array.isArray(m.capabilities) && m.capabilities.includes("vision")) : undefined,
      tools: native && Array.isArray(m.capabilities) ? m.capabilities.includes("tool_use") : undefined,
    }));
}

// Compares the server's models with the configured ones: what to add, what to update, what's gone.
export function planSync(configured = {}, listing) {
  const byServerId = new Map();
  for (const [key, m] of Object.entries(configured)) byServerId.set(m?.modelID || key, key);
  const add = [];
  const update = [];
  for (const s of listing) {
    const key = byServerId.get(s.id);
    if (!key) {
      add.push(s);
      continue;
    }
    const m = configured[key] || {};
    const changes = {};
    if (s.context && m.limit?.context !== s.context) changes.context = [m.limit?.context, s.context];
    if (s.vision !== undefined && !!m.capabilities?.input?.includes("image") !== s.vision) changes.vision = [!s.vision, s.vision];
    if (s.tools !== undefined && m.capabilities?.tools !== s.tools && s.tools) changes.tools = [m.capabilities?.tools, s.tools];
    update.push({ key, server: s, changes });
  }
  const served = new Set(listing.map((s) => s.id));
  const missing = Object.entries(configured)
    .filter(([key, m]) => !served.has(m?.modelID || key))
    .map(([key]) => key);
  return { add, update, missing };
}

// A new model entry from a listing row.
export function modelEntry(s) {
  const entry = { name: s.name || s.id, capabilities: { tools: s.tools ?? true, input: s.vision ? ["text", "image"] : ["text"], output: ["text"] } };
  if (s.context) entry.limit = { context: s.context, output: Math.min(s.context, 32768) };
  return entry;
}

// Applies chosen sync changes to a provider's models (mutates).
export function applySync(models, plan, { add = [], update = [], remove = [] }) {
  for (const id of add) {
    const s = plan.add.find((x) => x.id === id);
    if (s && !models[id]) models[id] = modelEntry(s);
  }
  for (const key of update) {
    const u = plan.update.find((x) => x.key === key);
    if (!u) continue;
    const m = (models[key] ??= {});
    if (u.changes.context) {
      m.limit ??= {};
      m.limit.context = u.changes.context[1];
      if (m.limit.output && m.limit.output > m.limit.context) m.limit.output = m.limit.context;
    }
    if (u.changes.vision) {
      m.capabilities ??= {};
      const input = m.capabilities.input || ["text"];
      m.capabilities.input = u.changes.vision[1] ? [...new Set([...input, "image"])] : input.filter((t) => t !== "image");
    }
    if (u.changes.tools) {
      m.capabilities ??= {};
      m.capabilities.tools = true;
    }
  }
  for (const key of remove) delete models[key];
  return models;
}

// ---- helpers behind the simple forms ----

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const byLadder = (levels) => [...new Set(levels)].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));

// Reasoning as the form shows it: mode auto (not set) / off / on, the selectable levels, the default level.
export function reasoningOf(m) {
  const r = m?.capabilities?.reasoning;
  return { mode: !r ? "auto" : r.supported ? "on" : "off", levels: r?.supported ? r.effort || [] : [], def: m?.settings?.reasoningEffort || "" };
}

export function setReasoning(m, { mode, levels = [], def = "" }) {
  if (mode === "auto") {
    if (m.capabilities) delete m.capabilities.reasoning;
  } else if (mode === "off") {
    (m.capabilities ??= {}).reasoning = { supported: false };
    def = "";
  } else {
    const prev = m.capabilities?.reasoning?.supported ? m.capabilities.reasoning : {};
    const r = { ...prev, supported: true };
    if (levels.length) r.effort = byLadder(levels);
    else delete r.effort;
    (m.capabilities ??= {}).reasoning = r;
    if (def && levels.length && !levels.includes(def)) def = "";
  }
  if (def) (m.settings ??= {}).reasoningEffort = def;
  else if (m.settings) delete m.settings.reasoningEffort;
  tidy(m, ["capabilities", "settings"]);
  return m;
}

// image input on/off, leaving other input types alone
export const hasVision = (m) => !!m?.capabilities?.input?.includes("image");
export function setVision(m, on) {
  const input = m.capabilities?.input || ["text"];
  (m.capabilities ??= {}).input = on ? [...new Set([...input, "image"])] : input.filter((t) => t !== "image");
  return m;
}

// sets or clears a nested value, removing objects it leaves empty
export function setPath(obj, keys, value) {
  let p = obj;
  for (const k of keys.slice(0, -1)) p = p[k] ??= {};
  if (value === undefined || value === "" || value === null) delete p[keys.at(-1)];
  else p[keys.at(-1)] = value;
  tidy(obj, [keys[0]]);
  return obj;
}
function tidy(obj, keys) {
  for (const k of keys) if (obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k]) && !Object.keys(obj[k]).length) delete obj[k];
}

// "32k" -> 32768, "1m" -> 1048576, "128,000" -> 128000; "" -> undefined; anything else -> NaN
export function parseTokens(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/[,_\s]/g, "");
  if (!t) return undefined;
  const m = t.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return NaN;
  return Math.round(Number(m[1]) * (m[2] === "k" ? 1024 : m[2] === "m" ? 1048576 : 1));
}
export const formatTokens = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("en-US"));

// "provider/model#variant" or { providerID, model, variant } -> parts; and back to the string form
export function parseRef(v) {
  if (!v) return { provider: "", model: "", variant: "" };
  if (typeof v === "object") return { provider: v.providerID || "", model: v.model || "", variant: v.variant || "" };
  const [ref, variant = ""] = String(v).split("#");
  const i = ref.indexOf("/");
  return i < 0 ? { provider: "", model: ref, variant } : { provider: ref.slice(0, i), model: ref.slice(i + 1), variant };
}
export const formatRef = ({ provider, model, variant }) => (provider && model ? `${provider}/${model}${variant ? `#${variant}` : ""}` : "");

export const PRESETS = [
  { key: "lmstudio", label: "LM Studio", id: "lmstudio", name: "LM Studio", url: "http://127.0.0.1:1234/v1" },
  { key: "ollama", label: "Ollama", id: "ollama", name: "Ollama", url: "http://127.0.0.1:11434/v1" },
  { key: "llamacpp", label: "llama.cpp server", id: "llamacpp", name: "llama.cpp", url: "http://127.0.0.1:8080/v1" },
  { key: "vllm", label: "vLLM", id: "vllm", name: "vLLM", url: "http://127.0.0.1:8000/v1" },
  { key: "custom", label: "Other OpenAI-compatible server", id: "local", name: "Local server", url: "http://127.0.0.1:8000/v1" },
];

export function newBackend({ name, url, apiKey }) {
  const p = { name, package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: url }, compatibility: { maxTokensField: "max_tokens" }, models: {} };
  if (apiKey) p.settings.apiKey = apiKey;
  return p;
}

// a free id: "lmstudio", "lmstudio-2", ...
export function freeId(base, taken) {
  let id = base, n = 2;
  while (id in taken) id = `${base}-${n++}`;
  return id;
}

// The same server on this PC: http://172.16.0.2:1234/v1 -> http://127.0.0.1:1234/v1 (null when already local).
export function localTwin(url) {
  try {
    const u = new URL(url);
    if (/^(127\.|localhost$|\[?::1\]?$)/.test(u.hostname)) return null;
    u.hostname = "127.0.0.1";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

// Read-only agents deny edits, shell and subagents (OpenCode permissions).
const READ_ONLY_RULES = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
];
export const isReadOnly = (a) => ["edit", "shell"].every((act) => (a.permissions || []).some((r) => r.action === act && r.resource === "*" && r.effect === "deny"));
export function setReadOnly(a, on) {
  const rules = (a.permissions || []).filter((r) => !READ_ONLY_RULES.some((x) => x.action === r.action && x.resource === r.resource && x.effect === r.effect));
  a.permissions = on ? [...READ_ONLY_RULES, ...rules] : rules;
  if (!a.permissions.length) delete a.permissions;
  return a;
}
