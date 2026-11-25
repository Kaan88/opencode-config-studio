// Agents page: the default agent, then one card per agent defined in the config.
import { EDIT_POLICIES, editPolicy, importCandidates, isLocalUrl, setEditPolicy, setPath, workersOfAgent } from "../core.js";
import { act, button, confirmDialog, dialog, el, field, notice, select, textInput, toggle } from "../dom.js";
import { modelPicker } from "../pickers.js";
import { boundEditor, resolve } from "../schemaEditor.js";
import { mark, render, S } from "../state.js";
import { offerAgent } from "./workers.js";

const BUILT_IN = ["build", "plan", "general", "explore"];
const MODES = [
  { value: "subagent", label: "Subagent (called by other agents)" },
  { value: "primary", label: "Primary (pick it in the UI)" },
  { value: "all", label: "Both (pick it, or let agents call it)" },
];
const agents = () => (S.config.agents ??= {});

export function agentsPage(root) {
  const names = [...new Set([...BUILT_IN, ...Object.keys(S.config.agents || {})])];
  if (S.config.default_agent && !names.includes(S.config.default_agent)) names.push(S.config.default_agent);
  root.append(
    el("div", { class: "pagehead" }, el("div", {}, el("h2", { text: "Agents" }), el("p", { class: "lead", text: "Agents pair a model with instructions and permissions, for OpenCode itself. Built-in agents (build, plan, general, explore) can be overridden here too. Claude Code can run an agent only when a worker on the Workers page offers it." })), el("div", { class: "actions" }, button("Import from OpenCode…", () => act(importDialog)), button("+ New agent", newAgentDialog, "primary"))),
    el("section", { class: "card compact" }, el("div", { class: "split" }, el("div", {}, el("h3", { text: "Default agent" }), el("p", { class: "hint", text: "The agent new sessions start with." })), select([{ value: "", label: "OpenCode default (build)" }, ...names.map((n) => ({ value: n, label: n }))], S.config.default_agent || "", (v) => (setPath(S.config, ["default_agent"], v || undefined), mark()), "Default agent"))),
  );
  const list = Object.entries(S.config.agents || {});
  if (!list.length) root.append(el("section", { class: "card empty" }, el("h3", { text: "No agents defined" }), el("p", { text: "Create one to run a specific model, for example a read-only reviewer on a local model, or import one agent per model OpenCode offers." }), el("div", { class: "actions" }, button("Import from OpenCode…", () => act(importDialog)), button("+ New agent", newAgentDialog, "primary"))));
  for (const [name, a] of list) root.append(agentCard(name, a));
}

function agentCard(name, a) {
  const rules = (a.permissions || []).length;
  const offered = workersOfAgent(S.workers, name);
  const instructions = el("details", { class: "inline" }, el("summary", { text: a.system ? "Instructions (custom)" : "Instructions" }));
  instructions.append(el("textarea", { rows: "6", "aria-label": `Instructions for ${name}`, placeholder: "Extra system prompt for this agent (optional)", value: a.system || "", oninput: (e) => (setPath(a, ["system"], e.target.value || undefined), mark()) }));
  return el(
    "section",
    { class: `card agent${a.disabled ? " off" : ""}` },
    el(
      "header",
      { class: "backendhead" },
      el("div", { class: "title" }, el("h3", { text: name }), el("div", { class: "meta" }, BUILT_IN.includes(name) ? el("span", { class: "status", text: "overrides built-in" }) : null, a.hidden ? el("span", { class: "status", text: "hidden" }) : null, offered.length ? el("span", { class: "status up", text: `offered to Claude as ${offered.join(", ")}` }) : el("span", { class: "status", text: "not offered to Claude" }))),
      el("div", { class: "actions" }, el("label", { class: "inline-toggle" }, toggle(!a.disabled, (v) => (setPath(a, ["disabled"], v ? undefined : true), mark(), render()), `${name} enabled`), "Enabled"), button("Delete", () => confirmDialog("Delete this agent?", `Remove the "${name}" agent from the config?`, "Delete", () => {
        delete agents()[name];
        if (S.config.default_agent === name) delete S.config.default_agent;
        mark();
        render();
      }), "small ghost danger")),
    ),
    el("div", { class: "agentgrid" },
      field("Model", modelPicker(a.model, (v) => (setPath(a, ["model"], v || undefined), mark()), { label: `Model for ${name}`, emptyLabel: "OpenCode default model" })),
      field("Mode", select(MODES, a.mode || "all", (v) => (setPath(a, ["mode"], v), mark()), `Mode for ${name}`)),
      field("Description", textInput(a.description, (v) => (setPath(a, ["description"], v || undefined), mark()), `Description for ${name}`, { placeholder: "When to use this agent" }), "Shown to other agents deciding whether to call it."),
      field("Edits & shell commands", select(EDIT_POLICIES, editPolicy(a), (v) => (setEditPolicy(a, v), mark(), render()), `Edits and shell commands for ${name}`), "Ask first is what a worker needs: its read-only jobs can change nothing, and its edit jobs are approved."),
    ),
    el("div", { class: "switches" },
      el("label", { class: "inline-toggle" }, toggle(!!a.hidden, (v) => (setPath(a, ["hidden"], v || undefined), mark(), render()), `${name} hidden`), "Hidden", el("small", { class: "hint", text: "not listed in the agent picker" })),
    ),
    instructions,
    el("div", { class: "toolbar" }, el("small", { class: "hint", text: rules ? `${rules} permission rule${rules > 1 ? "s" : ""}` : "Default permissions" }), offered.length ? null : button("Offer to Claude", () => {
      const worker = offerAgent(name);
      render();
      notice(`Worker "${worker}" added on the Workers page. Save to let Claude run this agent.`, "ok");
    }, "small"), button("Permissions & all fields…", () => dialog(`All fields · ${name}`, boundEditor(resolve(S.schema.$defs["Config.AgentEncoded"]), agents(), name), [{ label: "Done", kind: "primary", run: () => render() }], { wide: true }), "small")),
  );
}

function newAgentDialog() {
  const name = el("input", { placeholder: "e.g. local-reviewer" });
  let model = "";
  let mode = "subagent";
  let policy = "ask";
  const desc = el("input", { placeholder: "When to use this agent" });
  dialog("New agent", [
    field("Name", name),
    field("Model", modelPicker("", (v) => (model = v), { label: "Model", emptyLabel: "OpenCode default model" })),
    field("Mode", select(MODES, mode, (v) => (mode = v), "Mode")),
    field("Description", desc),
    field("Edits & shell commands", select(EDIT_POLICIES, policy, (v) => (policy = v), "Edits and shell commands")),
  ], [
    { label: "Cancel" },
    { label: "Create", kind: "primary", run: () => {
      const n = name.value.trim();
      if (!/^[A-Za-z0-9][\w.-]*$/.test(n)) throw Error("Use letters, numbers, dots, dashes or underscores for the name.");
      if (agents()[n]) throw Error("An agent with that name exists.");
      const a = { mode };
      if (model) a.model = model;
      if (desc.value.trim()) a.description = desc.value.trim();
      setEditPolicy(a, policy);
      agents()[n] = a;
      mark();
      render();
    } },
  ], { wide: true });
}

// Every model OpenCode lists (plus unsaved models from this file), as one agent each. Free models and older
// versions of a model line are left out; models an agent already runs on start unticked.
function importDialog() {
  const models = S.catalog.map((m) => ({ ...m }));
  const known = new Set(models.map((m) => `${m.provider}/${m.id}`));
  for (const [pid, p] of Object.entries(S.config.providers || {}))
    for (const [mid, m] of Object.entries(p.models || {}))
      if (!m.disabled && !known.has(`${pid}/${mid}`)) models.push({ provider: pid, id: mid, name: m.name || mid, local: isLocalUrl(p.settings?.baseURL) });
  const list = importCandidates(models, S.config.agents || {});
  if (!list.length) throw Error(S.catalogError ? `Couldn't read OpenCode's model list (${S.catalogError}).` : "OpenCode lists no models besides free ones.");

  let mode = "all";
  let policy = "ask";
  const rows = list.map((c) => {
    const box = el("input", { type: "checkbox", checked: !c.exists, "aria-label": `Import ${c.ref}` });
    const name = el("input", { value: c.name, "aria-label": `Agent name for ${c.ref}`, class: "importname" });
    return { c, box, name, row: el("label", { class: "syncrow" }, box, el("span", { class: "grow" }, c.label, " ", el("small", { class: "hint", text: c.id })), c.exists ? el("span", { class: "status", text: "has an agent" }) : null, c.local ? el("span", { class: "status up", text: "local" }) : null, name) };
  });
  const groups = [];
  for (const r of rows) {
    if (groups.at(-1)?.provider !== r.c.provider) groups.push({ provider: r.c.provider, rows: [] });
    groups.at(-1).rows.push(r);
  }
  const all = (on) => rows.forEach((r) => (r.box.checked = on));
  dialog("Import agents from OpenCode", [
    el("p", { text: `${rows.length} models, newest version of each, OpenCode's free models left out. Each ticked model becomes an agent on that model with its default effort; change the name on the right if you like.` }),
    el("div", { class: "agentgrid" }, field("Mode for all", select(MODES, mode, (v) => (mode = v), "Mode for imported agents"), "Both: pick them in OpenCode, and let other agents call them."), field("Edits & shell for all", select(EDIT_POLICIES, policy, (v) => (policy = v), "Edits and shell commands for imported agents"), "Ask first suits agents you will offer to Claude as workers.")),
    el("div", { class: "toolbar" }, el("div", { class: "actions" }, button("Select all", () => all(true), "small"), button("Select none", () => all(false), "small"))),
    ...groups.flatMap((g) => [el("h4", { text: g.provider }), ...g.rows.map((r) => r.row)]),
  ], [
    { label: "Cancel" },
    { label: "Import", kind: "primary", run: () => {
      const picked = rows.filter((r) => r.box.checked);
      const names = new Set();
      for (const r of picked) {
        const n = r.name.value.trim();
        if (!/^[A-Za-z0-9][\w.-]*$/.test(n)) throw Error(`"${n}" isn't a valid agent name: use letters, numbers, dots, dashes or underscores.`);
        if (agents()[n] || BUILT_IN.includes(n) || names.has(n)) throw Error(`The name "${n}" is already used.`);
        names.add(n);
      }
      for (const r of picked) agents()[r.name.value.trim()] = setEditPolicy({ model: r.c.ref, mode, description: r.c.label.toLowerCase().includes(r.c.provider.toLowerCase()) ? `Runs ${r.c.label}.` : `Runs ${r.c.label} (${r.c.provider}).` }, policy);
      if (picked.length) mark();
      render();
      notice(picked.length ? `${picked.length} agent${picked.length > 1 ? "s" : ""} added. Save, then Reload OpenCode to use them.` : "Nothing selected.", "ok");
    } },
  ], { wide: true });
}
