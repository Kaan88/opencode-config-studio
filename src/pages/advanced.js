// Advanced page: every other OpenCode setting through the schema editor, and the raw JSON.
import { button, el } from "../dom.js";
import { editor } from "../schemaEditor.js";
import { applyRaw, mark, render, S } from "../state.js";

const OWN_PAGES = ["providers", "agents", "$schema", "model", "default_agent"];
let tab = "settings";

export function advancedPage(root) {
  const tabs = el("div", { class: "tabs", role: "tablist" });
  for (const [id, label] of [["settings", "All settings"], ["raw", "Raw JSON"]])
    tabs.append(button(label, () => {
      if (tab === "raw" && id !== "raw") applyRaw();
      tab = id;
      render();
    }, tab === id ? "tab on" : "tab", { role: "tab", "aria-selected": String(tab === id) }));
  root.append(el("div", { class: "pagehead" }, el("div", {}, el("h2", { text: "Advanced" }), el("p", { class: "lead", text: "Everything else in opencode.json. Servers, models and agents have their own pages." }))), tabs);

  if (tab === "raw") {
    const ta = el("textarea", { class: "raw", spellcheck: "false", "aria-label": "Full configuration JSON" });
    ta.value = S.rawDraft ?? JSON.stringify(S.config, null, 2);
    ta.addEventListener("input", () => {
      S.rawDraft = ta.value;
      mark();
    });
    root.append(el("p", { class: "hint", text: "Edit any field directly. Saving validates it against OpenCode's schema; comments in the file are kept where fields didn't change." }), ta);
    return;
  }
  const props = Object.fromEntries(Object.entries(S.schema.properties).filter(([k]) => !OWN_PAGES.includes(k)));
  const globals = Object.fromEntries(Object.entries(S.config).filter(([k]) => !OWN_PAGES.includes(k)));
  root.append(
    el("p", { class: "hint", text: "Add a field from the list at the bottom; expand a section to edit it. Unset fields keep OpenCode's defaults." }),
    el("section", { class: "card" }, editor({ ...S.schema, properties: props, additionalProperties: false, anyOf: undefined, oneOf: undefined }, globals, (v) => {
      for (const k of Object.keys(S.config)) if (!OWN_PAGES.includes(k)) delete S.config[k];
      Object.assign(S.config, v);
    }, "Configuration")),
  );
}
