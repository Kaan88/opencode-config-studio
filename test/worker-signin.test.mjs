import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { submitWorkerKey, workerSignIn } from "../src/pages/workerSignIn.js";

test("rendering the Workers card does not start a sign-in check", () => {
  let checks = 0;
  globalThis.document = {
    createTextNode: s => s,
    createElement: () => ({ append() {}, setAttribute() {}, addEventListener() {},
      replaceChildren() { checks++; } }),
  };
  try { workerSignIn(); workerSignIn(); assert.equal(checks, 0); }
  finally { delete globalThis.document; }
});

test("worker key field clears before IPC completes, including on rejection", async () => {
  const input = { value: randomUUID() };
  let reject;
  const wait = submitWorkerKey(input, "deepseek", (name, args) => {
    assert.equal(name, "worker_auth_key");
    assert.equal(args.provider, "deepseek");
    assert.ok(args.key === input.value);
    return new Promise((_, fail) => { reject = fail; });
  });
  assert.equal(input.value, "");
  reject(Error("unavailable"));
  await assert.rejects(wait, /unavailable/);
});
