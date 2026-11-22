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
