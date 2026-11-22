// Talking to model servers: list their models, and a cached online/offline probe.
import { localTwin, normaliseListing } from "./core.js";
import { invoke } from "./state.js";

function headersFor(p) {
  const h = { ...(p.headers || {}) };
  if (p.settings?.apiKey) h.Authorization = `Bearer ${p.settings.apiKey}`;
  return h;
}

const unreachable = (msg) => /timed? ?out|connect|refused|unreachable|dns|resolve|no route|reset/i.test(msg);

function friendly(url, e) {
  const msg = e?.message || String(e);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  if (/timed? ?out/i.test(msg)) return `No answer from ${host}. Is the server running, and does it accept connections from this PC?`;
  if (/refused/i.test(msg)) return `${host} refused the connection: nothing is listening on that port.`;
  if (unreachable(msg)) return `Can't reach ${host} (${msg.replace(/^.*?: /, "")}).`;
  return msg;
}

async function getJSON(url, headers, timeoutMs) {
  const r = await invoke("http_get", { url, headers, timeoutMs });
  if (r.status !== 200) throw Error(`${url} returned HTTP ${r.status}`);
  try {
    return JSON.parse(r.body);
  } catch {
    throw Error(`${url} did not return JSON`);
  }
}

// LM Studio's native API first (load state, context, vision, tool use), then the plain OpenAI-compatible /models.
export async function listBackend(p, timeoutMs = 6000) {
  const base = String(p.settings?.baseURL || "").replace(/\/+$/, "");
  if (!base) throw Error("Set the server URL first.");
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    throw Error("The server URL is not a valid URL.");
  }
  const headers = headersFor(p);
  try {
    const body = await getJSON(`${origin}/api/v0/models`, headers, timeoutMs);
    if (Array.isArray(body?.data) && body.data.some((m) => "state" in m || "max_context_length" in m)) return { kind: "LM Studio", models: normaliseListing(body, true) };
  } catch (e) {
    if (unreachable(e?.message || String(e))) throw Object.assign(Error(friendly(base, e)), { unreachable: true });
  }
  try {
    return { kind: "OpenAI-compatible", models: normaliseListing(await getJSON(`${base}/models`, headers, timeoutMs), false) };
  } catch (e) {
    throw Object.assign(Error(friendly(base, e)), { unreachable: unreachable(e?.message || String(e)) });
  }
}

// When a remote URL doesn't answer, the same server may be running on this PC: returns that URL if it answers.
export async function findLocalTwin(p) {
  const twin = localTwin(p.settings?.baseURL || "");
  if (!twin) return null;
  try {
    await listBackend({ ...p, settings: { ...p.settings, baseURL: twin } }, 1500);
    return twin;
  } catch {
    return null;
  }
}

// online/offline per URL, re-probed at most every 30 s
const probes = new Map();
export function probe(p, onState) {
  const key = p.settings?.baseURL;
  if (!key) return onState({ state: "none" });
  const known = probes.get(key);
  if (known) onState(known);
  if (known && Date.now() - known.at < 30000) return;
  listBackend(p, 2500).then(
    (r) => {
      const s = { at: Date.now(), state: "up", kind: r.kind, served: r.models.length, loaded: r.models.filter((m) => m.loaded).length };
      probes.set(key, s);
      onState(s);
    },
    () => {
      const s = { at: Date.now(), state: "down" };
      probes.set(key, s);
      onState(s);
    },
  );
}
export const forgetProbe = (url) => probes.delete(url);
