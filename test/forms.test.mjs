import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeValidator, reasoningOf, setReasoning, setVision, hasVision, setPath, parseTokens, formatTokens, parseRef, formatRef, newBackend, freeId, localTwin, isReadOnly, setReadOnly, editPolicy, setEditPolicy } from "../src/core.js";

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
