// Models page: default model, then one card per backend with its models as an editable table.
import { applySync, EFFORTS, formatTokens, freeId, hasVision, newBackend, parseRef, planSync, PRESETS, reasoningOf, setPath, setReasoning, setVision } from "../core.js";
import { findLocalTwin, forgetProbe, listBackend, probe } from "../backend.js";
import { act, button, confirmDialog, dialog, el, field, notice, select, textInput, toggle, tokenInput } from "../dom.js";
import { modelPicker } from "../pickers.js";
import { boundEditor, resolve } from "../schemaEditor.js";
import { mark, render, S } from "../state.js";

const providers = () => (S.config.providers ??= {});
const validId = (id, provider) => {
  if (!id || id.includes("#") || (provider && id.includes("/")) || ["__proto__", "constructor", "prototype"].includes(id)) throw Error(`Use an ID without #${provider ? " or /" : ""}.`);
};
const defaultRef = () => {
  const r = parseRef(S.config.model);
  return r.provider ? `${r.provider}/${r.model}` : "";
};
const open = new Set(); // expanded model rows, "provider/model"

export function modelsPage(root) {
  root.append(
    el("div", { class: "pagehead" }, el("div", {}, el("h2", { text: "Models" }), el("p", { class: "lead", text: "Your model servers and the models OpenCode may use from them. Changes apply to the OpenCode CLI and Desktop after you save and reload." })), button("+ Add server", addBackendDialog, "primary")),
    el(
      "section",
      { class: "card compact" },
      el("div", { class: "split" }, el("div", {}, el("h3", { text: "Default model" }), el("p", { class: "hint", text: "Used for new sessions when no agent or session picks one." })), modelPicker(S.config.model, (v) => {
        setPath(S.config, ["model"], v || undefined);
        mark();
        render();
      }, { label: "Default model", emptyLabel: "Let OpenCode choose" })),
    ),
  );
  const entries = Object.entries(providers());
  if (!entries.length)
    root.append(el("section", { class: "card empty" }, el("h3", { text: "No model servers yet" }), el("p", { text: "Add LM Studio, Ollama, llama.cpp or any OpenAI-compatible server. Its models are imported for you." }), button("+ Add server", addBackendDialog, "primary")));
  for (const [id, p] of entries) root.append(backendCard(id, p));
}

// ---- one backend ----
function backendCard(id, p) {
  const status = el("span", { class: "status" }, "checking…");
  probe(p, (s) => {
    status.className = `status ${s.state}`;
    status.textContent = s.state === "up" ? `Online · ${s.served} served${s.kind === "LM Studio" ? ` · ${s.loaded} loaded` : ""}` : s.state === "down" ? "Offline" : "No URL";
  });
  const models = Object.entries(p.models || {});
  const card = el(
    "section",
    { class: "card backend" },
    el(
      "header",
      { class: "backendhead" },
      el("div", { class: "title" }, el("h3", { text: p.name || id }), el("div", { class: "meta" }, status, el("code", { text: p.settings?.baseURL || "no URL" }))),
      el("div", { class: "actions" }, button("Sync models", () => syncModels(id, p), "primary small"), button("Edit server", () => connectionDialog(id, p), "small"), button("Delete", () => confirmDialog("Delete this server?", `Remove "${p.name || id}" and its ${models.length} model entries from the config?`, "Delete", () => {
        delete providers()[id];
        if (defaultRef().startsWith(`${id}/`)) delete S.config.model;
        mark();
        render();
      }), "small ghost danger")),
    ),
  );
  if (!models.length) card.append(el("p", { class: "empty-row", text: "No models yet. Use Sync models to import what the server offers, or add one by ID below." }));
  else {
    const table = el("table", { class: "models" });
    table.append(
      el("thead", {}, el("tr", {}, ...["Model", "Context", "Max output", "Tools", "Vision", "Reasoning", "Default", "Enabled", ""].map((h, i) => el("th", { scope: "col", class: i >= 3 && i <= 7 ? "c" : "", text: h })))),
    );
    const body = el("tbody");
    for (const [mid, m] of models) body.append(...modelRows(id, p, mid, m));
    table.append(body);
    card.append(el("div", { class: "tablewrap" }, table));
  }
  card.append(addModelRow(id, p));
  return card;
}

function modelRows(pid, p, mid, m) {
  const ref = `${pid}/${mid}`;
  const r = reasoningOf(m);
  const expanded = open.has(ref);
  const row = el("tr", { class: m.disabled ? "off" : "" });
  const reasoning = select([{ value: "auto", label: "Auto" }, { value: "off", label: "Off" }, { value: "on", label: r.levels.length ? `On · ${r.levels[0]}–${r.levels.at(-1)}` : "On" }], r.mode, (mode) => {
    setReasoning(m, { ...reasoningOf(m), mode, levels: mode === "on" && !r.levels.length ? ["low", "medium", "high"] : reasoningOf(m).levels });
    mark();
    if (mode === "on") open.add(ref);
    render();
  }, `Reasoning for ${mid}`);
  row.append(
    el("td", { class: "name" }, textInput(m.name, (v) => (setPath(m, ["name"], v.trim() || undefined), mark()), `Display name for ${mid}`, { placeholder: mid }), el("small", { class: "id", text: m.modelID && m.modelID !== mid ? `${mid} → ${m.modelID}` : mid })),
    el("td", {}, tokenInput(m.limit?.context, (n) => (setPath(m, ["limit", "context"], n), mark()), `Context window for ${mid}`)),
    el("td", {}, tokenInput(m.limit?.output, (n) => (setPath(m, ["limit", "output"], n), mark()), `Maximum output for ${mid}`)),
    el("td", { class: "c" }, toggle(m.capabilities?.tools ?? false, (v) => (setPath(m, ["capabilities", "tools"], v), mark()), `Tool calling for ${mid}`)),
    el("td", { class: "c" }, toggle(hasVision(m), (v) => (setVision(m, v), mark()), `Image input for ${mid}`)),
    el("td", { class: "c" }, reasoning),
    el("td", { class: "c" }, el("input", { type: "radio", name: "default-model", "aria-label": `Use ${mid} as the default model`, checked: defaultRef() === ref, disabled: !!m.disabled, onchange: () => ((S.config.model = ref), mark(), render()) })),
    el("td", { class: "c" }, toggle(!m.disabled, (v) => (setPath(m, ["disabled"], v ? undefined : true), mark(), render()), `${mid} enabled`)),
    el("td", { class: "c" }, button(expanded ? "▾" : "▸", () => (expanded ? open.delete(ref) : open.add(ref), render()), "icon ghost", { "aria-expanded": String(expanded), "aria-label": `More settings for ${mid}` })),
  );
  if (!expanded) return [row];
  return [row, el("tr", { class: "detail" }, el("td", { colspan: "9" }, modelDetail(pid, p, mid, m)))];
}

function modelDetail(pid, p, mid, m) {
  const r = reasoningOf(m);
  const parts = [];
  if (r.mode === "on") {
    const chips = el("div", { class: "chips", role: "group", "aria-label": "Effort levels" });
    for (const lvl of EFFORTS) {
      const on = r.levels.includes(lvl);
      chips.append(el("label", { class: `chip${on ? " on" : ""}` }, el("input", { type: "checkbox", checked: on, onchange: (e) => {
        const levels = e.target.checked ? [...reasoningOf(m).levels, lvl] : reasoningOf(m).levels.filter((x) => x !== lvl);
        setReasoning(m, { ...reasoningOf(m), mode: "on", levels });
        mark();
        render();
      } }), lvl));
    }
    parts.push(
      el("div", { class: "detailgrid" },
        el("div", { class: "field wide" }, el("span", { class: "label", text: "Effort levels" }), chips, el("small", { class: "hint", text: "The levels OpenCode offers for this model. Only pick what the server actually supports." })),
        field("Default effort", select([{ value: "", label: "Server default" }, ...r.levels.map((l) => ({ value: l, label: l }))], r.def, (def) => (setReasoning(m, { ...reasoningOf(m), def }), mark()), "Default effort")),
      ),
    );
  }
  parts.push(
    el("div", { class: "detailgrid" },
      field("Max input tokens", tokenInput(m.limit?.input, (n) => (setPath(m, ["limit", "input"], n), mark()), "Max input tokens"), "Usually leave unset."),
      field("Temperature", el("input", { type: "number", step: "any", min: "0", max: "2", value: m.settings?.temperature ?? "", placeholder: "server default", oninput: (e) => (setPath(m, ["settings", "temperature"], e.target.value === "" ? undefined : Number(e.target.value)), mark()) })),
      field("Server model ID", textInput(m.modelID, (v) => (setPath(m, ["modelID"], v.trim() || undefined), mark()), "Server model ID", { placeholder: mid }), "Only if the server knows it under another name."),
    ),
    el("div", { class: "toolbar" },
      button("Rename ID…", () => renameModel(pid, p, mid), "small"),
      button("Duplicate", () => {
        const next = freeId(`${mid}-copy`, p.models);
        p.models[next] = { ...structuredClone(m), modelID: m.modelID || mid };
        mark();
        render();
      }, "small"),
      button("All fields…", () => dialog(`All fields · ${mid}`, boundEditor(resolve(S.schema.$defs["Config.ModelEncoded"]), p.models, mid), [{ label: "Done", kind: "primary", run: () => render() }], { wide: true }), "small"),
      button("Delete model", () => confirmDialog("Delete this model?", `Remove ${mid} from ${p.name || pid}?`, "Delete", () => {
        delete p.models[mid];
        if (defaultRef() === `${pid}/${mid}`) delete S.config.model;
        mark();
        render();
      }), "small ghost danger"),
    ),
  );
  return el("div", { class: "detailbox" }, ...parts);
}

function renameModel(pid, p, mid) {
  const input = el("input", { value: mid });
  dialog("Rename model ID", [field("Model ID", input, "The name OpenCode uses (provider/ID). The server still receives the old ID unless you set Server model ID.")], [
    { label: "Cancel" },
    { label: "Rename", kind: "primary", run: () => {
      const next = input.value.trim();
      validId(next);
      if (next === mid) return;
      if (p.models[next]) throw Error("That model ID already exists.");
      p.models[next] = { ...p.models[mid], modelID: p.models[mid].modelID || mid };
      delete p.models[mid];
      if (defaultRef() === `${pid}/${mid}`) S.config.model = `${pid}/${next}`;
      mark();
      render();
    } },
  ]);
}

function addModelRow(pid, p) {
  const input = el("input", { placeholder: "model ID, e.g. qwen/qwen3-coder-30b", "aria-label": "New model ID" });
  const add = () => act(() => {
    const id = input.value.trim();
    validId(id);
    p.models ??= {};
    if (p.models[id]) throw Error("That model is already listed.");
    p.models[id] = { name: id, capabilities: { tools: true, input: ["text"], output: ["text"] } };
    open.add(`${pid}/${id}`);
    mark();
    render();
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && add());
  return el("div", { class: "addmodel" }, input, button("Add model", add, "small"));
}

// ---- server dialogs ----
function addBackendDialog() {
  let preset = PRESETS[0];
  const name = el("input", { value: preset.name });
  const url = el("input", { value: preset.url });
  const key = el("input", { type: "password", placeholder: "none", autocomplete: "off" });
  const cards = el("div", { class: "presets", role: "radiogroup", "aria-label": "Server type" });
  for (const p of PRESETS)
    cards.append(el("label", { class: "preset" }, el("input", { type: "radio", name: "preset", checked: p === preset, onchange: () => {
      preset = p;
      name.value = p.name;
      url.value = p.url;
    } }), el("span", { text: p.label })));
  dialog("Add a model server", [cards, field("Name", name), field("Server URL", url, "OpenAI-compatible URLs usually end in /v1. Use the PC's IP for a server on another machine."), field("API key (optional)", key, "Most local servers need none. {env:NAME} reads an environment variable.")], [
    { label: "Cancel" },
    { label: "Add and import models", kind: "primary", run: () => {
      const u = new URL(url.value.trim());
      if (!/^https?:$/.test(u.protocol)) throw Error("Use an http:// or https:// URL.");
      const id = freeId(preset.id, providers());
      providers()[id] = newBackend({ name: name.value.trim() || preset.name, url: url.value.trim().replace(/\/+$/, ""), apiKey: key.value.trim() });
      mark();
      render();
      setTimeout(() => syncModels(id, providers()[id]), 0);
    } },
  ]);
}

function connectionDialog(id, p) {
  const name = el("input", { value: p.name || "" });
  const newId = el("input", { value: id });
  const url = el("input", { value: p.settings?.baseURL || "" });
  const key = el("input", { type: "password", value: p.settings?.apiKey || "", placeholder: "none", autocomplete: "off" });
  const more = el("details", {}, el("summary", { text: "All server settings (headers, timeouts, compatibility…)" }));
  more.addEventListener("toggle", () => {
    if (more.open && more.children.length === 1) more.append(boundEditor(resolve(S.schema.$defs["Config.ProviderEncoded"]), providers(), id));
  });
  dialog(`Edit server · ${p.name || id}`, [
    el("div", { class: "detailgrid" }, field("Name", name), field("ID", newId, "Used in model references: ID/model.")),
    field("Server URL", url),
    field("API key", key, "{env:NAME} reads an environment variable; a key typed here is stored in the file and its backups."),
    more,
  ], [
    { label: "Cancel" },
    { label: "Apply", kind: "primary", run: () => {
      const nid = newId.value.trim();
      validId(nid, true);
      if (nid !== id && providers()[nid]) throw Error("That ID is already used.");
      setPath(p, ["name"], name.value.trim() || undefined);
      setPath(p, ["settings", "baseURL"], url.value.trim().replace(/\/+$/, "") || undefined);
      setPath(p, ["settings", "apiKey"], key.value.trim() || undefined);
      if (nid !== id) {
        providers()[nid] = p;
        delete providers()[id];
        const d = parseRef(S.config.model);
        if (d.provider === id) S.config.model = `${nid}/${d.model}${d.variant ? `#${d.variant}` : ""}`;
      }
      forgetProbe(p.settings?.baseURL);
      mark();
      render();
    } },
  ], { wide: true });
}

// ---- sync ----
async function syncModels(pid, p) {
  await act(async () => {
    notice(`Contacting ${p.name || pid}…`);
    let result;
    try {
      result = await listBackend(p);
    } catch (e) {
      if (!e.unreachable) throw e;
      const twin = await findLocalTwin(p);
      if (!twin) throw e;
      notice("");
      return dialog("Server not reachable", el("p", { text: `${e.message}\n\nThe same kind of server is answering on this PC at ${twin}. Use that address instead?` }), [
        { label: "Cancel" },
        { label: "Use this PC's server", kind: "primary", run: () => {
          setPath(p, ["settings", "baseURL"], twin);
          forgetProbe(twin);
          mark();
          render();
          setTimeout(() => syncModels(pid, p), 0);
        } },
      ]);
    }
    forgetProbe(p.settings?.baseURL);
    p.models ??= {};
    const plan = planSync(p.models, result.models);
    const picks = { add: [], update: [], remove: [] };
    const box = (group, value, checked, label, extra) => {
      const input = el("input", { type: "checkbox", checked });
      picks[group].push({ value, input });
      return el("label", { class: "syncrow" }, input, el("span", { class: "grow", text: label }), extra || null);
    };
    const tag = (s) => (s.loaded === undefined ? null : el("span", { class: `status ${s.loaded ? "up" : ""}`, text: s.loaded ? "loaded" : "not loaded" }));
    const changed = plan.update.filter((u) => Object.keys(u.changes).length);
    const parts = [el("p", { text: `${result.models.length} models on the server (${result.kind}).` })];
    if (plan.add.length) parts.push(el("h4", { text: `New · ${plan.add.length}` }), ...plan.add.map((s) => box("add", s.id, true, `${s.name}${s.context ? ` · ${formatTokens(s.context)} context` : ""}${s.vision ? " · vision" : ""}${s.tools ? " · tools" : ""}`, tag(s))));
    if (changed.length) parts.push(el("h4", { text: `Changed · ${changed.length}` }), ...changed.map((u) => box("update", u.key, true, `${u.key} · ${Object.entries(u.changes).map(([k, [a, b]]) => (k === "context" ? `context ${formatTokens(a) || "unset"} → ${formatTokens(b)}` : `${k} ${b ? "on" : "off"}`)).join(", ")}`, tag(u.server))));
    if (plan.missing.length) parts.push(el("h4", { text: `No longer on the server · ${plan.missing.length}` }), ...plan.missing.map((k) => box("remove", k, false, `Remove ${k}`)));
    if (parts.length === 1) parts.push(el("p", { class: "hint", text: "Everything already matches the server." }));
    notice("");
    dialog(`Sync · ${p.name || pid}`, parts, [
      { label: "Close" },
      ...(parts.length > 2 || plan.add.length || changed.length || plan.missing.length
        ? [{ label: "Apply", kind: "primary", run: () => {
          const chosen = Object.fromEntries(Object.entries(picks).map(([g, list]) => [g, list.filter((x) => x.input.checked).map((x) => x.value)]));
          for (const id of chosen.add) validId(id);
          applySync(p.models, plan, chosen);
          for (const k of chosen.remove) if (defaultRef() === `${pid}/${k}`) delete S.config.model;
          const n = chosen.add.length + chosen.update.length + chosen.remove.length;
          if (n) mark();
          render();
          notice(n ? `${chosen.add.length} added, ${chosen.update.length} updated, ${chosen.remove.length} removed. Save to keep the changes.` : "Nothing selected.", "ok");
        } }]
        : []),
    ], { wide: true });
  });
}
