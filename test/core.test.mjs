import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decode, makeValidator, mergeText, normaliseListing, planSync, applySync } from "../src/core.js";

const schema = JSON.parse(readFileSync(new URL("../src/schema.json", import.meta.url)));
const modelSchema = JSON.parse(readFileSync(new URL("../src/model-schema.json", import.meta.url)));
const check = makeValidator(schema, modelSchema);

test("edits preserve unrelated JSONC comments and fields", () => {
  const raw = '{\n // Keep this comment\n "model":"strata/coder",\n "providers":{"strata":{"models":{"coder":{"limit":{"context":32768,"output":4096}}}}},\n "snapshots":false,\n}';
  const before = decode(raw), after = structuredClone(before);
  after.providers.strata.models.coder.limit.context = 65536;
  const out = mergeText(raw, before, after);
  assert.match(out, /Keep this comment/);
  assert.deepEqual(decode(out), after);
  check(after);
});

test("validates v2 reasoning, limits and variants and rejects bad values", () => {
  const value = { model: "local/coder", providers: { local: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:1234/v1" }, models: { coder: { limit: { context: 32768, output: 4096 }, capabilities: { reasoning: { supported: true, effort: ["low", "high"] } }, variants: [{ id: "deep", settings: { reasoningEffort: "high" } }] } } } } };
  check(value);
  value.providers.local.models.coder.limit.context = "bad";
  assert.throws(() => check(value));
});

test("removal and additions retain all unaffected values", () => {
  const before = { model: "a/b", providers: { a: { name: "A", models: { b: { name: "B" }, c: { name: "C" } } } }, snapshots: true };
  const after = structuredClone(before);
  delete after.providers.a.models.b;
  after.providers.a.models.d = { limit: { context: 16384 } };
  after.model = "a/d";
  assert.deepEqual(decode(mergeText(JSON.stringify(before), before, after)), after);
});

test("LM Studio listing: skips embeddings, reads load state, context, vision and tool use", () => {
  const body = { data: [
    { id: "qwen/qwen3-coder-30b", type: "llm", state: "loaded", max_context_length: 262144, loaded_context_length: 32768, capabilities: ["tool_use"] },
    { id: "gemma-vision", type: "vlm", state: "not-loaded", max_context_length: 131072 },
    { id: "nomic-embed", type: "embeddings", state: "not-loaded", max_context_length: 2048 },
  ] };
  const rows = normaliseListing(body, true);
  assert.deepEqual(rows.map((r) => r.id), ["qwen/qwen3-coder-30b", "gemma-vision"]);
  assert.equal(rows[0].context, 32768); // the loaded context wins over the maximum
  assert.equal(rows[0].loaded, true);
  assert.equal(rows[0].tools, true);
  assert.equal(rows[1].vision, true);
  assert.deepEqual(normaliseListing({ data: [{ id: "x" }] }, false), [{ id: "x", name: "x", loaded: undefined, context: undefined, vision: undefined, tools: undefined }]);
});

test("sync plan adds, updates and flags missing models, honouring modelID aliases", () => {
  const configured = {
    coder: { modelID: "qwen/qwen3-coder-30b", limit: { context: 8192, output: 16384 } },
    old: { name: "gone" },
  };
  const listing = normaliseListing({ data: [
    { id: "qwen/qwen3-coder-30b", type: "llm", state: "loaded", loaded_context_length: 32768, capabilities: ["tool_use"] },
    { id: "gemma-vision", type: "vlm", state: "not-loaded", max_context_length: 131072 },
  ] }, true);
  const plan = planSync(configured, listing);
  assert.deepEqual(plan.add.map((s) => s.id), ["gemma-vision"]);
  assert.deepEqual(plan.missing, ["old"]);
  assert.deepEqual(plan.update[0].changes.context, [8192, 32768]);
  const models = applySync(structuredClone(configured), plan, { add: ["gemma-vision"], update: ["coder"], remove: ["old"] });
  assert.equal(models.coder.limit.context, 32768);
  assert.equal(models.coder.limit.output, 16384); // kept: still within the context
  assert.equal(models.coder.capabilities.tools, true);
  assert.deepEqual(models["gemma-vision"].capabilities.input, ["text", "image"]);
  assert.equal(models["gemma-vision"].limit.context, 131072);
  assert.equal(models.old, undefined);
  check({ providers: { lmstudio: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:1234/v1" }, models } } });
});
