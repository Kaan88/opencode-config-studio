// Workers page: the one list of what Claude Code can hand work to through the bridge. A worker runs either an
// OpenCode agent or Claude Code itself; Claude sees these names and nothing else.
import { STARTER_WORKERS, WORKER_EFFORTS, WORKER_MODELS, WORKER_NAME, WORKER_RUNS, agentWorker, editPolicy, formatRef, freeId, parseRef, setPath, workerBill } from "../core.js";
import { button, confirmDialog, dialog, el, field, notice, select, textInput, toggle } from "../dom.js";
import { modelPicker } from "../pickers.js";
import { mark, render, S } from "../state.js";

const BUILT_IN = ["build", "plan", "general", "explore"];
const EDITS = [
  { value: "follow", label: "When Claude allows it" },
  { value: "never", label: "Never (read-only)" },
];
const EFFORT_OPTIONS = [{ value: "", label: "Model default" }, ...WORKER_EFFORTS.map((e) => ({ value: e, label: e }))];
const list = () => (S.workers.workers ??= {});
const agentNames = () => [...new Set([...Object.keys(S.config.agents || {}), ...BUILT_IN])];
const agentOptions = (current) => {
  const names = agentNames();
  if (current && !names.includes(current)) names.unshift(current);
  return names.map((n) => ({ value: n, label: S.config.agents?.[n] || BUILT_IN.includes(n) ? n : `${n} (not in OpenCode's config)` }));
};

export function workersPage(root) {
  const entries = Object.entries(list());
  root.append(
    el(
      "div",
      { class: "pagehead" },
      el(
        "div",
        {},
        el("h2", { text: "Workers" }),
        el("p", {
          class: "lead",
          text: "What Claude Code can hand work to. Claude sees these workers and nothing else: an OpenCode agent or model is reachable only through a worker listed here. Name one in a prompt, for example \"ask cc-reviewer to check src/\".",
        }),
      ),
      button("+ New worker", newWorkerDialog, "primary"),
    ),
  );
  if (S.workersImported && entries.length)
    root.append(
      el(
        "section",
        { class: "card compact" },
        el(
          "div",
          { class: "split" },
          el("div", {}, el("h3", { text: "Made from your earlier setup" }), el("p", { class: "hint", text: "The default agent and your Claude workers, as the bridge uses them now. Save it to make this the list you edit here." })),
          button("Save this list", () => ((S.workersBase = ""), mark()), "primary"),
        ),
      ),
    );
  if (!entries.length)
    root.append(
      el(
        "section",
        { class: "card empty" },
        el("h3", { text: "No workers yet" }),
        el("p", { text: "Without a worker Claude can run nothing through the bridge. Start with three Claude Code workers (cc-haiku, cc-sonnet, cc-reviewer), or offer an OpenCode agent from the Agents page." }),
        el("div", { class: "actions" }, button("Add the starter set", addStarters, "primary"), button("+ New worker", newWorkerDialog)),
      ),
    );
  else
    root.append(
      el(
        "section",
        { class: "card compact" },
        el(
          "div",
          { class: "split" },
          el("div", {}, el("h3", { text: "Default worker" }), el("p", { class: "hint", text: "Runs a job when Claude names no worker. An OpenCode worker here keeps routine work off your Claude plan." })),
          select([{ value: "", label: "First OpenCode worker in the list" }, ...entries.map(([n]) => ({ value: n, label: n }))], S.workers.default || "", (v) => (setPath(S.workers, ["default"], v || undefined), mark(), render()), "Default worker"),
        ),
      ),
    );
  for (const [name, w] of entries) root.append(workerCard(name, w));
  root.append(
    el(
      "p",
      { class: "hint" },
      `Saved to ${S.workersPath}. Claude sessions see changes within seconds; no restart needed. A Claude Code worker runs on your Claude plan with Claude Code's tools and your CLAUDE.md, without MCP servers. An OpenCode worker runs its agent with that agent's permissions, on that provider's bill.`,
    ),
  );
}

function workerCard(name, w) {
  const set = (keys, v) => (setPath(w, keys, v), mark());
  const claude = w.runs === "claude";
  const switchRuns = (runs) => {
    const kept = { runs, description: w.description, readOnly: w.readOnly, disabled: w.disabled };
    for (const k of Object.keys(w)) delete w[k];
    Object.assign(w, kept, runs === "claude" ? { model: "sonnet" } : { agent: agentNames()[0] });
    for (const k of Object.keys(w)) if (w[k] === undefined) delete w[k];
    mark();
    render();
  };
  const fields = [field("Runs", select(WORKER_RUNS, w.runs, switchRuns, `What runs ${name}`), workerBill(w) + ".")];
  if (claude) {
    fields.push(
      field("Model", select(WORKER_MODELS, w.model, (v) => (set(["model"], v), render()), `Model for ${name}`)),
      field("Effort", select(EFFORT_OPTIONS, w.effort || "", (v) => set(["effort"], v || undefined), `Effort for ${name}`), "Claude can still ask for another level per job."),
    );
  } else {
    const agent = S.config.agents?.[w.agent];
    const open = agent && editPolicy(agent) === "allow";
    fields.push(
      field("OpenCode agent", select(agentOptions(w.agent), w.agent, (v) => (set(["agent"], v), render()), `Agent for ${name}`), open ? "This agent edits without asking, so the bridge refuses it for read-only jobs. Set it to Ask first on the Agents page." : "Its instructions and permissions apply."),
      field(
        "Model and effort",
        modelPicker(formatRef({ ...parseRef(w.model || ""), variant: w.effort }), (ref) => {
          const r = parseRef(ref);
          set(["model"], r.provider ? `${r.provider}/${r.model}` : undefined);
          set(["effort"], r.variant || undefined);
        }, { label: `Model for ${name}`, emptyLabel: "The agent's own model" }),
        "Leave it on the agent's own model unless this worker should run the same agent on another one.",
      ),
    );
  }
  fields.push(
    field("File edits", select(EDITS, w.readOnly ? "never" : "follow", (v) => set(["readOnly"], v === "never" || undefined), `File edits for ${name}`), "Read-only workers are refused for edit jobs."),
    field("Description", textInput(w.description, (v) => set(["description"], v || undefined), `Description for ${name}`, { placeholder: "What it's for; Claude reads this" })),
  );
  const instructions = claude ? el("details", { class: "inline" }, el("summary", { text: w.instructions ? "Instructions (custom)" : "Instructions" })) : null;
  instructions?.append(
    el("textarea", {
      rows: "5",
      "aria-label": `Instructions for ${name}`,
      placeholder: "Added to the worker's system prompt, e.g. the role it plays or the format of its answer (optional)",
      value: w.instructions || "",
      oninput: (e) => set(["instructions"], e.target.value || undefined),
    }),
  );
  return el(
    "section",
    { class: `card agent${w.disabled ? " off" : ""}` },
    el(
      "header",
      { class: "backendhead" },
      el(
        "div",
        { class: "title" },
        el("h3", { text: name }),
        el(
          "div",
          { class: "meta" },
          el("span", { class: "status", text: claude ? `Claude Code ${w.model}` : `OpenCode agent ${w.agent}` }),
          el("span", { class: `status${claude ? "" : " up"}`, text: workerBill(w) }),
          (S.workers.default || "") === name ? el("span", { class: "status", text: "default" }) : null,
        ),
      ),
      el(
        "div",
        { class: "actions" },
        el("label", { class: "inline-toggle" }, toggle(!w.disabled, (v) => (set(["disabled"], v ? undefined : true), render()), `${name} enabled`), "Enabled"),
        button("Rename", () => renameDialog(name), "small ghost"),
        button(
          "Delete",
          () =>
            confirmDialog("Delete this worker?", `Remove the "${name}" worker? Claude can no longer run it.`, "Delete", () => {
              delete list()[name];
              if (S.workers.default === name) delete S.workers.default;
              mark();
              render();
            }),
          "small ghost danger",
        ),
      ),
    ),
    el("div", { class: "agentgrid" }, ...fields),
    instructions,
  );
}

function addStarters() {
  const taken = list();
  let n = 0;
  for (const [name, w] of Object.entries(STARTER_WORKERS))
    if (!taken[name]) {
      taken[name] = structuredClone(w);
      n++;
    }
  mark();
  render();
  notice(`${n} worker${n === 1 ? "" : "s"} added. Save to use them.`, "ok");
}

function checkName(n, except) {
  if (!WORKER_NAME.test(n)) throw Error("Use letters, numbers, dots, dashes or underscores for the name.");
  if (n !== except && list()[n]) throw Error("A worker with that name exists.");
}

// Adds a worker for an OpenCode agent (the Agents page's "Offer to Claude"); returns its name.
export function offerAgent(agentName) {
  const name = freeId(agentName, list());
  list()[name] = agentWorker(agentName, S.config.agents?.[agentName]);
  mark();
  return name;
}

function newWorkerDialog() {
  const name = el("input", { placeholder: "e.g. cc-tests" });
  const w = { runs: "claude", model: "sonnet" };
  const desc = el("input", { placeholder: "What it's for; Claude reads this" });
  const detail = el("div");
  const draw = () => {
    detail.replaceChildren(
      ...(w.runs === "claude"
        ? [field("Model", select(WORKER_MODELS, w.model, (v) => (w.model = v), "Model")), field("Effort", select(EFFORT_OPTIONS, w.effort || "", (v) => (w.effort = v || undefined), "Effort"))]
        : [field("OpenCode agent", select(agentOptions(w.agent), w.agent, (v) => (w.agent = v), "OpenCode agent"), "Runs on the agent's own model; change that on the worker's card.")]),
    );
  };
  draw();
  dialog(
    "New worker",
    [
      field("Name", name, "What you'll call it in prompts."),
      field(
        "Runs",
        select(WORKER_RUNS, w.runs, (v) => {
          w.runs = v;
          delete w.model;
          delete w.effort;
          delete w.agent;
          if (v === "claude") w.model = "sonnet";
          else w.agent = agentNames()[0];
          draw();
        }, "What runs it"),
        "An OpenCode agent runs on its provider's bill; Claude Code runs on your Claude plan.",
      ),
      detail,
      field("File edits", select(EDITS, "follow", (v) => (w.readOnly = v === "never" || undefined), "File edits")),
      field("Description", desc),
    ],
    [
      { label: "Cancel" },
      {
        label: "Create",
        kind: "primary",
        run: () => {
          const n = name.value.trim();
          checkName(n);
          if (desc.value.trim()) w.description = desc.value.trim();
          list()[n] = JSON.parse(JSON.stringify(w));
          mark();
          render();
        },
      },
    ],
    { wide: true },
  );
}

function renameDialog(old) {
  const name = el("input", { value: old });
  dialog("Rename worker", [field("New name", name, "Prompts and notes that use the old name need updating.")], [
    { label: "Cancel" },
    {
      label: "Rename",
      kind: "primary",
      run: () => {
        const n = name.value.trim();
        if (n === old) return;
        checkName(n, old);
        // keep the order: rebuild the object with the new key in place
        S.workers.workers = Object.fromEntries(Object.entries(list()).map(([k, v]) => [k === old ? n : k, v]));
        if (S.workers.default === old) S.workers.default = n;
        mark();
        render();
      },
    },
  ]);
}
