// Claude workers page: named Claude Code workers that Claude runs in the background through the OpenCode bridge.
import { STARTER_WORKERS, WORKER_EFFORTS, WORKER_MODELS, WORKER_NAME, setPath } from "../core.js";
import { button, confirmDialog, dialog, el, field, notice, select, textInput, toggle } from "../dom.js";
import { mark, render, S } from "../state.js";

const EDITS = [
  { value: "follow", label: "When Claude allows it" },
  { value: "never", label: "Never (read-only)" },
];
const EFFORT_OPTIONS = [{ value: "", label: "Model default" }, ...WORKER_EFFORTS.map((e) => ({ value: e, label: e }))];
const list = () => (S.workers.workers ??= {});

export function workersPage(root) {
  const entries = Object.entries(list());
  root.append(
    el(
      "div",
      { class: "pagehead" },
      el(
        "div",
        {},
        el("h2", { text: "Claude workers" }),
        el("p", {
          class: "lead",
          text: "Claude Code itself, run in the background through the OpenCode bridge. Name one in a prompt, for example \"ask cc-reviewer to check src/\", and Claude starts it, keeps working, and collects the answer.",
        }),
      ),
      button("+ New worker", newWorkerDialog, "primary"),
    ),
  );
  if (!entries.length)
    root.append(
      el(
        "section",
        { class: "card empty" },
        el("h3", { text: "No workers yet" }),
        el("p", { text: "Start with three: cc-haiku (cheap reading and summaries), cc-sonnet (general work) and cc-reviewer (Opus, read-only bug review). You can change or delete them." }),
        el("div", { class: "actions" }, button("Add the starter set", addStarters, "primary"), button("+ New worker", newWorkerDialog)),
      ),
    );
  for (const [name, w] of entries) root.append(workerCard(name, w));
  root.append(
    el(
      "p",
      { class: "hint" },
      `Saved to ${S.workersPath}. Claude sessions see changes within seconds; no restart needed. Each worker runs on your Claude plan with Claude Code's tools and your CLAUDE.md, without MCP servers. Read-only workers can read, search, fetch web pages and run git status/diff/log/show.`,
    ),
  );
}

function workerCard(name, w) {
  const set = (keys, v) => (setPath(w, keys, v), mark());
  const instructions = el("details", { class: "inline" }, el("summary", { text: w.instructions ? "Instructions (custom)" : "Instructions" }));
  instructions.append(
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
      el("div", { class: "title" }, el("h3", { text: name }), el("div", { class: "meta" }, el("span", { class: "status", text: `say "${name}"` }))),
      el(
        "div",
        { class: "actions" },
        el("label", { class: "inline-toggle" }, toggle(!w.disabled, (v) => (set(["disabled"], v ? undefined : true), render()), `${name} enabled`), "Enabled"),
        button("Rename", () => renameDialog(name), "small ghost"),
        button("Delete", () => confirmDialog("Delete this worker?", `Remove the "${name}" worker?`, "Delete", () => (delete list()[name], mark(), render())), "small ghost danger"),
      ),
    ),
    el(
      "div",
      { class: "agentgrid" },
      field("Model", select(WORKER_MODELS, w.model, (v) => set(["model"], v), `Model for ${name}`)),
      field("Effort", select(EFFORT_OPTIONS, w.effort || "", (v) => set(["effort"], v || undefined), `Effort for ${name}`), "Claude can still ask for another level per job."),
      field("File edits", select(EDITS, w.readOnly ? "never" : "follow", (v) => set(["readOnly"], v === "never" || undefined), `File edits for ${name}`), "Read-only workers are refused for edit jobs."),
      field("Description", textInput(w.description, (v) => set(["description"], v || undefined), `Description for ${name}`, { placeholder: "What it's for; Claude reads this" })),
    ),
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

function newWorkerDialog() {
  const name = el("input", { placeholder: "e.g. cc-tests" });
  const w = { model: "sonnet" };
  const desc = el("input", { placeholder: "What it's for; Claude reads this" });
  dialog(
    "New Claude worker",
    [
      field("Name", name, "What you'll call it in prompts."),
      field("Model", select(WORKER_MODELS, w.model, (v) => (w.model = v), "Model")),
      field("Effort", select(EFFORT_OPTIONS, "", (v) => (w.effort = v || undefined), "Effort")),
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
        mark();
        render();
      },
    },
  ]);
}
