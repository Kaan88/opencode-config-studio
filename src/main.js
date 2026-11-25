// App shell: navigation, the save bar, keyboard shortcuts, the close prompt, and start-up.
import { $, act, button, confirmDialog, el, notice } from "./dom.js";
import { advancedPage } from "./pages/advanced.js";
import { agentsPage } from "./pages/agents.js";
import { bridgePage } from "./pages/bridge.js";
import { contextPage } from "./pages/context.js";
import { modelsPage } from "./pages/models.js";
import { workersPage } from "./pages/workers.js";
import { applyRaw, invoke, loadCatalog, loadFile, loadSchema, onDirty, S, saveFile, setRender } from "./state.js";

const PAGES = { models: ["Models", modelsPage], agents: ["Agents", agentsPage], context: ["Context", contextPage], advanced: ["Advanced", advancedPage], workers: ["Workers", workersPage], bridge: ["Bridge", bridgePage] };
// The sidebar says whose settings a page holds: OpenCode's own, or what Claude Code can reach through the bridge.
const GROUPS = [
  ["OpenCode", "Used by OpenCode itself", ["models", "agents", "context", "advanced"]],
  ["Claude bridge", "What Claude Code can hand work to", ["workers", "bridge"]],
];

export function go(id) {
  return act(() => {
    if (S.page === "advanced" && id !== "advanced") applyRaw();
    S.page = id;
    render();
    $("#content").scrollTop = 0;
    $("#content").focus();
  });
}

function nav() {
  $("#nav").replaceChildren(
    ...GROUPS.flatMap(([title, hint, ids]) => [
      el("div", { class: "navgroup", title: hint }, title, el("small", { text: hint })),
      ...ids.map((id) => button(PAGES[id][0], () => go(id), S.page === id ? "navitem on" : "navitem", { "aria-current": S.page === id ? "page" : null })),
    ]),
  );
}

function render() {
  nav();
  const content = $("#content");
  const y = content.scrollTop;
  const page = el("div", { class: "page" });
  content.replaceChildren(page);
  PAGES[S.page][1](page);
  content.scrollTop = y;
  $("#filepath").textContent = S.path + (S.exists ? "" : " (not created yet)");
  $("#schemasource").textContent = { live: "Schema: live from opencode.ai", cached: "Schema: last downloaded copy", bundled: "Schema: built-in snapshot" }[S.schemaSource] || "";
}
setRender(render);

onDirty(() => {
  $("#savebar").hidden = !S.dirty;
  document.title = `${S.dirty ? "• " : ""}OpenCode Config Studio`;
});

const save = () => act(async () => {
  $("#save").disabled = true;
  try {
    const r = await saveFile();
    render();
    const backup = r.backup ? el("span", { class: "muted", text: "Backup written beside the file. " }) : null;
    // worker changes reach Claude by themselves; only opencode.json needs OpenCode to reload
    if (r.revision) notice(el("span", {}, "Saved. ", backup, button("Reload OpenCode", reload, "linkish"), " to apply it now."), "ok");
    else notice(el("span", {}, "Saved. ", backup, r.workers ? "Claude sessions pick up the worker list within seconds." : ""), "ok");
  } finally {
    $("#save").disabled = false;
  }
});
const reload = () => act(async () => {
  if (S.dirty) throw Error("Save your changes first, then reload OpenCode.");
  notice("Reloading OpenCode…");
  notice(await invoke("opencode_reload"), "ok");
  loadCatalog().then(render);
});
const discard = () => confirmDialog("Discard your changes?", "This reloads the file from disk.", "Discard", () => act(async () => {
  await loadFile();
  render();
  notice("Changes discarded.", "ok");
}));

$("#save").onclick = save;
$("#discard").onclick = discard;
$("#reload").onclick = reload;
$("#docs").onclick = (e) => {
  e.preventDefault();
  act(() => invoke("open_url", { url: e.currentTarget.href }));
};
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (S.dirty) save();
  }
});
{
  const win = window.__TAURI__.window.getCurrentWindow();
  win.onCloseRequested((e) => {
    if (!S.dirty) return;
    e.preventDefault();
    confirmDialog("Close without saving?", "Your unsaved changes will be lost.", "Close anyway", () => win.destroy());
  });
}

act(async () => {
  notice("Loading…");
  await Promise.all([loadSchema(), loadFile(), loadCatalog()]);
  render();
  notice(S.catalogError ? `Couldn't read OpenCode's model list (${S.catalogError}); model pickers show only this file's models.` : "", S.catalogError ? "error" : "info");
});
