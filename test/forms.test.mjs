import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeValidator, reasoningOf, setReasoning, setVision, hasVision, setPath, parseTokens, formatTokens, parseRef, formatRef, newBackend, freeId, localTwin, isReadOnly, setReadOnly, editPolicy, setEditPolicy, checkWorkers, STARTER_WORKERS, migrateWorkers, workersOfAgent, contextState, setContextMode, skipsMagic, setSkipMagic, MAGIC_SKIP } from "../src/core.js";

const check = makeValidator(JSON.parse(readFileSync(new URL("../src/schema.json", import.meta.url))), JSON.parse(readFileSync(new URL("../src/model-schema.json", import.meta.url))));
const wrap = (m) => ({ providers: { p: { ...newBackend({ name: "P", url: "http://127.0.0.1:1/v1" }), models: { m } } } });

test("reasoning: auto, off, on with levels and default; result validates", () => {
  const m = { name: "x" };
  assert.equal(reasoningOf(m).mode, "auto");
  setReasoning(m, { mode: "on", levels: ["high", "low", "medium"], def: "medium" });
  assert.deepEqual(m.capabilities.reasoning, { supported: true, effort: ["low", "medium", "high"] });
  assert.equal(m.settings.reasoningEffort, "medium");
  check(wrap(m));
  setReasoning(m, { mode: "on", levels: ["low"], def: "medium" }); // a default that isn't a level is dropped
  assert.equal(m.settings, undefined);
  setReasoning(m, { mode: "off" });
  assert.deepEqual(m.capabilities.reasoning, { supported: false });
  check(wrap(m));
  setReasoning(m, { mode: "auto" });
  assert.equal(m.capabilities, undefined);
});

test("vision, nested paths and empty-object cleanup", () => {
  const m = {};
  setVision(m, true);
  assert.ok(hasVision(m));
  setVision(m, false);
  assert.deepEqual(m.capabilities.input, ["text"]);
  setPath(m, ["limit", "context"], 32768);
  assert.equal(m.limit.context, 32768);
  setPath(m, ["limit", "context"], undefined);
  assert.equal(m.limit, undefined);
});

test("token shorthand", () => {
  assert.equal(parseTokens("32k"), 32768);
  assert.equal(parseTokens("1m"), 1048576);
  assert.equal(parseTokens("128,000"), 128000);
  assert.equal(parseTokens(""), undefined);
  assert.ok(Number.isNaN(parseTokens("lots")));
  assert.equal(formatTokens(262144), "262,144");
});

test("model refs, ids, local twin and read-only agents", () => {
  assert.deepEqual(parseRef("lmstudio/qwen/qwen3-coder#high"), { provider: "lmstudio", model: "qwen/qwen3-coder", variant: "high" });
  assert.deepEqual(parseRef({ providerID: "a", model: "b" }), { provider: "a", model: "b", variant: "" });
  assert.equal(formatRef({ provider: "a", model: "b", variant: "" }), "a/b");
  assert.equal(freeId("lmstudio", { lmstudio: 1, "lmstudio-2": 1 }), "lmstudio-3");
  assert.equal(localTwin("http://172.16.0.2:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.equal(localTwin("http://127.0.0.1:1234/v1"), null);
  const a = { model: "a/b", permissions: [{ action: "skill", resource: "x", effect: "allow" }] };
  setReadOnly(a, true);
  assert.ok(isReadOnly(a));
  assert.equal(a.permissions.length, 4);
  setReadOnly(a, false);
  assert.deepEqual(a.permissions, [{ action: "skill", resource: "x", effect: "allow" }]);
  check({ agents: { ro: setReadOnly({ model: "a/b", mode: "subagent" }, true) } });
});

test("edit policy: allow, ask, deny; own rules kept after the managed ones", () => {
  const a = { model: "a/b", permissions: [{ action: "shell", resource: "git status*", effect: "allow" }, { action: "subagent", resource: "*", effect: "deny" }] };
  assert.equal(editPolicy(a), "allow");
  setEditPolicy(a, "ask");
  assert.equal(editPolicy(a), "ask");
  assert.deepEqual(a.permissions.slice(0, 2).map((r) => `${r.action}:${r.effect}`), ["edit:ask", "shell:ask"]);
  assert.ok(a.permissions.some((r) => r.resource === "git status*")); // later, so it still wins over shell:ask
  assert.ok(a.permissions.some((r) => r.action === "subagent")); // the agent's own rule stays
  setEditPolicy(a, "deny");
  assert.ok(isReadOnly(a));
  setEditPolicy(a, "ask");
  assert.equal(a.permissions.filter((r) => r.action === "subagent").length, 0); // read-only's subagent rule goes with it
  setEditPolicy(a, "allow");
  assert.equal(editPolicy(a), "allow");
  check({ agents: { x: setEditPolicy({ model: "a/b" }, "ask") } });
});

test("workers: names, what runs them, models and efforts are checked; starters are valid", () => {
  assert.ok(checkWorkers({ workers: STARTER_WORKERS }));
  assert.ok(checkWorkers({ default: "f", workers: { f: { runs: "opencode", agent: "deepseek-flash", model: "deepseek/deepseek-flash", effort: "high" } } }));
  assert.throws(() => checkWorkers({ workers: { "bad name": { runs: "claude", model: "haiku" } } }), /name/);
  assert.throws(() => checkWorkers({ workers: { x: { runs: "claude", model: "gpt" } } }), /model/);
  assert.throws(() => checkWorkers({ workers: { x: { runs: "claude", model: "opus", effort: "ultra" } } }), /effort/);
  assert.throws(() => checkWorkers({ workers: { x: { model: "opus" } } }), /what runs it/);
  assert.throws(() => checkWorkers({ workers: { x: { runs: "opencode" } } }), /agent/);
  assert.throws(() => checkWorkers({ workers: { x: { runs: "opencode", agent: "a", model: "no-slash" } } }), /provider\/id/);
  assert.throws(() => checkWorkers({ default: "gone", workers: {} }), /default worker/);
});

test("workers: the list of an earlier install is the default agent plus its Claude workers", () => {
  const legacy = { workers: { "cc-sonnet": { model: "sonnet" }, "cc-reviewer": { model: "opus", readOnly: true } } };
  const made = migrateWorkers(legacy, { "deepseek-flash": { description: "Cheap." }, other: {} });
  assert.deepEqual(made, {
    default: "deepseek-flash",
    workers: {
      "deepseek-flash": { runs: "opencode", agent: "deepseek-flash", description: "Cheap." },
      "cc-sonnet": { runs: "claude", model: "sonnet" },
      "cc-reviewer": { runs: "claude", model: "opus", readOnly: true },
    },
  });
  assert.ok(checkWorkers(made));
  assert.deepEqual(migrateWorkers({}, {}), { workers: {} }, "nothing to start from");
  assert.deepEqual(migrateWorkers(legacy, {}).default, "cc-sonnet", "no default agent: the first worker");
  assert.deepEqual(workersOfAgent(made, "deepseek-flash"), ["deepseek-flash"]);
  assert.deepEqual(workersOfAgent(made, "other"), []);
});

test("context: one switch lists the plugin and turns OpenCode's compaction off, or the reverse", () => {
  const cfg = { plugins: ["@cortexkit/opencode-magic-context@latest", "@el4cteo/opencode-goal"], compaction: { auto: false, prune: false } };
  assert.deepEqual(contextState(cfg), { magic: true, spec: "@cortexkit/opencode-magic-context@latest", native: false, mode: "magic" });
  setContextMode(cfg, "native");
  assert.deepEqual(cfg, { plugins: ["@el4cteo/opencode-goal"], compaction: { auto: true } });
  assert.equal(contextState(cfg).mode, "native");
  check(cfg);
  setContextMode(cfg, "magic", "@cortexkit/opencode-magic-context@0.49.71");
  assert.deepEqual(cfg, { plugins: ["@cortexkit/opencode-magic-context@0.49.71", "@el4cteo/opencode-goal"], compaction: { auto: false, prune: false } });
  check(cfg);
  // the other shapes: the object form, the older "plugin" key, and nothing set at all
  assert.equal(contextState({ plugins: [{ package: "@cortexkit/opencode-magic-context" }] }).mode, "both", "listed, and compaction left at its default");
  assert.equal(contextState({}).mode, "native");
  assert.equal(contextState({ compaction: { auto: false } }).mode, "none");
  assert.deepEqual(setContextMode({ plugin: ["other"] }, "magic"), { plugin: ["@cortexkit/opencode-magic-context", "other"], compaction: { auto: false, prune: false } });
  assert.deepEqual(setContextMode({ plugins: [{ package: "@cortexkit/opencode-magic-context@1.0.0" }] }, "native"), { compaction: { auto: true } });
  assert.deepEqual(setContextMode({ compaction: { auto: false, buffer: "30%" } }, "native").compaction, { auto: true, buffer: "30%" }, "other compaction settings stay");
});

test("context: the plugin's opt-out line is added to and taken out of an agent's instructions", () => {
  const a = { system: "Be brief." };
  assert.equal(skipsMagic(a), false);
  setSkipMagic(a, true);
  assert.equal(a.system, "Be brief.\n\n" + MAGIC_SKIP);
  setSkipMagic(a, true);
  assert.equal(a.system.split(MAGIC_SKIP).length, 2, "added once");
  assert.ok(skipsMagic(a));
  assert.deepEqual(setSkipMagic(a, false), { system: "Be brief." });
  assert.deepEqual(setSkipMagic(setSkipMagic({}, true), false), {}, "no empty instructions left behind");
});
