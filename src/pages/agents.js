// Agents page: the default agent, then one card per agent defined in the config.
import { isReadOnly, setPath, setReadOnly } from "../core.js";
import { button, confirmDialog, dialog, el, field, select, textInput, toggle } from "../dom.js";
import { modelPicker } from "../pickers.js";
import { boundEditor, resolve } from "../schemaEditor.js";
import { mark, render, S } from "../state.js";

const BUILT_IN = ["build", "plan", "general", "explore"];
const MODES = [
  { value: "subagent", label: "Subagent (called by other agents)" },
  { value: "primary", label: "Primary (pick it in the UI)" },
  { value: "all", label: "Both" },
];
const agents = () => (S.config.agents ??= {});

export function agentsPage(root) {
  const names = [...new Set([...BUILT_IN, ...Object.keys(S.config.agents || {})])];
  if (S.config.default_agent && !names.includes(S.config.default_agent)) names.push(S.config.default_agent);
  root.append(
    el("div", { class: "pagehead" }, el("div", {}, el("h2", { text: "Agents" }), el("p", { class: "lead", text: "Agents pair a model with instructions and permissions. Built-in agents (build, plan, general, explore) can be overridden here too." })), button("+ New agent", newAgentDialog, "primary")),
    el("section", { class: "card compact" }, el("div", { class: "split" }, el("div", {}, el("h3", { text: "Default agent" }), el("p", { class: "hint", text: "The agent new sessions start with." })), select([{ value: "", label: "OpenCode default (build)" }, ...names.map((n) => ({ value: n, label: n }))], S.config.default_agent || "", (v) => (setPath(S.config, ["default_agent"], v || undefined), mark()), "Default agent"))),
  );
  const list = Object.entries(S.config.agents || {});
  if (!list.length) root.append(el("section", { class: "card empty" }, el("h3", { text: "No agents defined" }), el("p", { text: "Create one to run a specific model, for example a read-only reviewer on a local model." }), button("+ New agent", newAgentDialog, "primary")));
  for (const [name, a] of list) root.append(agentCard(name, a));
}

function agentCard(name, a) {
  const rules = (a.permissions || []).length;
  const instructions = el("details", { class: "inline" }, el("summary", { text: a.system ? "Instructions (custom)" : "Instructions" }));
  instructions.append(el("textarea", { rows: "6", "aria-label": `Instructions for ${name}`, placeholder: "Extra system prompt for this agent (optional)", value: a.system || "", oninput: (e) => (setPath(a, ["system"], e.target.value || undefined), mark()) }));
  return el(
    "section",
    { class: `card agent${a.disabled ? " off" : ""}` },
    el(
      "header",
      { class: "backendhead" },
      el("div", { class: "title" }, el("h3", { text: name }), el("div", { class: "meta" }, BUILT_IN.includes(name) ? el("span", { class: "status", text: "overrides built-in" }) : null, a.hidden ? el("span", { class: "status", text: "hidden" }) : null)),
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
    ),
    el("div", { class: "switches" },
      el("label", { class: "inline-toggle" }, toggle(isReadOnly(a), (v) => (setReadOnly(a, v), mark(), render()), `${name} read-only`), "Read-only", el("small", { class: "hint", text: "no edits, no shell, no subagents" })),
      el("label", { class: "inline-toggle" }, toggle(!!a.hidden, (v) => (setPath(a, ["hidden"], v || undefined), mark(), render()), `${name} hidden`), "Hidden", el("small", { class: "hint", text: "not listed in the agent picker" })),
    ),
    instructions,
    el("div", { class: "toolbar" }, el("small", { class: "hint", text: rules ? `${rules} permission rule${rules > 1 ? "s" : ""}` : "Default permissions" }), button("Permissions & all fields…", () => dialog(`All fields · ${name}`, boundEditor(resolve(S.schema.$defs["Config.AgentEncoded"]), agents(), name), [{ label: "Done", kind: "primary", run: () => render() }], { wide: true }), "small")),
  );
}

function newAgentDialog() {
  const name = el("input", { placeholder: "e.g. local-reviewer" });
  let model = "";
  let mode = "subagent";
  const ro = el("input", { type: "checkbox" });
  const desc = el("input", { placeholder: "When to use this agent" });
  dialog("New agent", [
    field("Name", name),
    field("Model", modelPicker("", (v) => (model = v), { label: "Model", emptyLabel: "OpenCode default model" })),
    field("Mode", select(MODES, mode, (v) => (mode = v), "Mode")),
    field("Description", desc),
    el("label", { class: "check" }, ro, "Read-only (no edits, no shell, no subagents)"),
  ], [
    { label: "Cancel" },
    { label: "Create", kind: "primary", run: () => {
      const n = name.value.trim();
      if (!/^[A-Za-z0-9][\w.-]*$/.test(n)) throw Error("Use letters, numbers, dots, dashes or underscores for the name.");
      if (agents()[n]) throw Error("An agent with that name exists.");
      const a = { mode };
      if (model) a.model = model;
      if (desc.value.trim()) a.description = desc.value.trim();
      if (ro.checked) setReadOnly(a, true);
      agents()[n] = a;
      mark();
      render();
    } },
  ], { wide: true });
}
