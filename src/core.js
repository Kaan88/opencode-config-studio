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

// What an agent may do to files and the shell (OpenCode permissions; the last matching rule wins, so these go first):
//   allow - anything (OpenCode's default)
//   ask   - edits and shell commands ask first. In OpenCode's UI you approve them; Claude's bridge runs read-only jobs
//           without auto-approve (every ask is rejected) and edit jobs with it, so one agent serves both.
//   deny  - read-only: no edits, no shell, no subagents.
const POLICY_RULES = {
  allow: [],
  ask: [
    { action: "edit", resource: "*", effect: "ask" },
    { action: "shell", resource: "*", effect: "ask" },
  ],
  deny: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ],
};
export const EDIT_POLICIES = [
  { value: "allow", label: "Allowed" },
  { value: "ask", label: "Ask first (Claude can still run it read-only)" },
  { value: "deny", label: "Blocked (read-only)" },
];
export function editPolicy(a) {
  const last = (a?.permissions || []).filter((r) => r.action === "edit" && r.resource === "*").at(-1);
  return last ? last.effect : "allow";
}
export function setEditPolicy(a, policy) {
  const was = editPolicy(a);
  const rules = (a.permissions || []).filter(
    (r) => !(r.resource === "*" && (r.action === "edit" || r.action === "shell" || (was === "deny" && r.action === "subagent" && r.effect === "deny"))),
  );
  a.permissions = [...POLICY_RULES[policy], ...rules];
  if (!a.permissions.length) delete a.permissions;
  return a;
}
export const isReadOnly = (a) => editPolicy(a) === "deny";
export const setReadOnly = (a, on) => setEditPolicy(a, on ? "deny" : "allow");

// ---- importing OpenCode's models as agents ----

// OpenCode's own free models: the "opencode" provider with a "-free" id or no cost. Subscription and local
// providers also report $0, so zero cost alone doesn't count.
export const isFreeModel = (m) => m.providerID === "opencode" && (/-free$/i.test(m.id) || (m.cost || []).every((c) => !c.input && !c.output));
const LOCAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|[^.]+$|.*\.local$)/i;
export function isLocalUrl(url) {
  try {
    return LOCAL_HOST.test(new URL(url || "").hostname);
  } catch {
    return false;
  }
}

// "claude-opus-4-5-20251101" -> line "claude-opus", version [4,5], date 20251101
function lineOf(m) {
  const line = [], version = [];
  let date = 0;
  for (const t of m.id.split(/[-/]/)) {
    if (/^\d{8}$/.test(t)) date = Number(t);
    else if (/^v?\d+(\.\d+)*$/i.test(t)) version.push(...t.replace(/^v/i, "").split(".").map(Number));
    else line.push(t);
  }
  return { key: `${m.provider}/${line.join("-")}`, version, date };
}
function newer(a, b) {
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const d = (a.version[i] || 0) - (b.version[i] || 0);
    if (d) return d > 0;
  }
  return a.version.length !== b.version.length ? a.version.length > b.version.length : !a.date && !!b.date;
}
// Only the newest version of each model line; local models are all kept (they're whatever is loaded).
export function latestOnly(models) {
  const best = new Map();
  for (const m of models) {
    if (m.local) continue;
    const l = lineOf(m);
    const cur = best.get(l.key);
    if (!cur || newer(l, cur.l)) best.set(l.key, { m, l });
  }
  const keep = new Set([...best.values()].map((b) => b.m));
  return models.filter((m) => m.local || keep.has(m));
}

// An agent name from a model id: "qwen/qwen3.5-9b" -> "qwen3.5-9b", "GPT 5" -> "gpt-5"
export const agentNameFor = (id) => id.split("/").pop().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "") || "model";

// Candidates for "Import from OpenCode": [{ ref, provider, id, label, name, local, exists }], newest versions only,
// free models left out. `exists` marks models some agent already runs on (those start unticked).
export function importCandidates(models, agents = {}) {
  const used = new Set(Object.values(agents).map((a) => parseRef(a.model)).filter((r) => r.provider).map((r) => `${r.provider}/${r.model}`));
  const taken = { build: 1, plan: 1, general: 1, explore: 1, ...agents }; // never shadow a built-in by accident
  return latestOnly(models.filter((m) => !m.free))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
    .map((m) => {
      const ref = `${m.provider}/${m.id}`;
      const name = freeId(agentNameFor(m.id), taken);
      taken[name] = true;
      return { ref, provider: m.provider, id: m.id, label: m.name || m.id, name, local: !!m.local, exists: used.has(ref) };
    });
}

// ---- Claude workers: Claude Code itself, run in the background through the OpenCode bridge ----
// File (read by the bridge): { "workers": { "<name>": { model, effort?, readOnly?, disabled?, description?, instructions? } } }
export const WORKER_MODELS = [
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
export const WORKER_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const WORKER_NAME = /^[A-Za-z0-9][\w.-]*$/;
export function checkWorkers(file) {
  for (const [name, w] of Object.entries(file?.workers || {})) {
    if (!WORKER_NAME.test(name)) throw Error(`Worker "${name}": use letters, numbers, dots, dashes or underscores for the name.`);
    if (!WORKER_MODELS.some((m) => m.value === w.model)) throw Error(`Worker "${name}": pick a model.`);
    if (w.effort && !WORKER_EFFORTS.includes(w.effort)) throw Error(`Worker "${name}": unknown effort "${w.effort}".`);
  }
  return true;
}
export const STARTER_WORKERS = {
  "cc-haiku": { model: "haiku", effort: "low", readOnly: true, description: "Cheap and fast: bulk reading, searching and summaries." },
  "cc-sonnet": { model: "sonnet", description: "General worker: well-specified changes, tests, fixes with a known cause." },
  "cc-reviewer": {
    model: "opus",
    effort: "high",
    readOnly: true,
    description: "Reviews code for correctness bugs.",
    instructions: "You are a code reviewer. Report correctness bugs only, most severe first, each with file:line, what goes wrong and a concrete failing input. No style comments.",
  },
};
