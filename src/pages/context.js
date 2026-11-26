// Context page: what keeps a long OpenCode session inside the model's window. Either the Magic Context plugin or
// OpenCode's own compaction; one switch turns one on and the other off, because the two interfere when both run.
import { MAGIC_PACKAGE, contextState, setContextMode } from "../core.js";
import { el, toggle } from "../dom.js";
import { mark, render, S } from "../state.js";

let lastSpec = ""; // the plugin entry as it was before it was switched off, so switching back restores the same version


export function contextPage(root) {
  const st = contextState(S.config);
  if (st.spec) lastSpec = st.spec;
  const setMode = (magic) => {
    setContextMode(S.config, magic ? "magic" : "native", lastSpec || MAGIC_PACKAGE);
    mark();
    render();
  };
  const fact = (label, on, text) => [el("span", { class: "muted", text: label }), el("span", { class: `status ${on ? "up" : ""}`, text })];
  const wrong =
    st.mode === "both"
      ? "Both are on. They work against each other: the history is compressed twice and the plugin's cache-safe timing is lost. Flip the switch to settle it."
      : st.mode === "none"
        ? "Neither is on, so nothing keeps a long session inside the model's window. Flip the switch to settle it."
        : "";
  root.append(
    el(
      "div",
      { class: "pagehead" },
      el(
        "div",
        {},
        el("h2", { text: "Context" }),
        el("p", { class: "lead", text: "What keeps a long OpenCode session inside the model's window: the Magic Context plugin, or OpenCode's own compaction. One of the two should be on, never both, so one switch sets both." }),
      ),
    ),
    el(
      "section",
      { class: "card" },
      el(
        "div",
        { class: "split" },
        el(
          "div",
          {},
          el("h3", { text: "Magic Context" }),
          el("p", {
            class: "hint",
            text: st.magic
              ? "On: the plugin manages the window in the background and keeps a project memory. OpenCode's own compaction is switched off with it."
              : "Off: the plugin is not loaded and OpenCode compacts a session itself when the window fills. The plugin's memory stays on disk and is used again when you switch it back on.",
          }),
        ),
        el("label", { class: "inline-toggle" }, toggle(st.mode === "magic" || st.mode === "both", setMode, "Magic Context"), st.magic ? "On" : "Off"),
      ),
      wrong ? el("p", { class: "hint", style: "color:var(--danger)", text: wrong }) : null,
      el(
        "div",
        { class: "facts" },
        ...fact("Magic Context plugin", st.magic, st.magic ? `loaded (${st.spec})` : "not loaded"),
        ...fact("OpenCode's own compaction", st.native, st.native ? "on" : "off"),
      ),
      el("p", { class: "hint", text: "Save, then restart OpenCode: a plugin is loaded or dropped only when OpenCode starts. Worth knowing when you choose: the plugin pays off in long sessions on expensive models, where it keeps the window small; in short jobs and on models with very cheap cached input it changes little." }),
    ),
  );
  if (st.magic) {
    const out = S.workers.magicContextInJobs !== true; // the bridge's default: jobs run without the plugin
    root.append(
      el(
        "section",
        { class: "card" },
        el(
          "div",
          { class: "split" },
          el(
            "div",
            {},
            el("h3", { text: "Keep it out of Claude's workers" }),
            el("p", {
              class: "hint",
              text: "Jobs that Claude hands to an OpenCode worker are short and start fresh, so the plugin only gets in the way there: it trims the job's context and runs its own summaries. When this is on, the bridge runs every OpenCode job on a private server with a copy of this config that leaves the plugin out and turns OpenCode's own compaction on. It covers every worker and agent, including ones added later. Your own OpenCode sessions keep the plugin.",
            }),
          ),
          el(
            "label",
            { class: "inline-toggle" },
            toggle(out, (on) => {
              if (on) delete S.workers.magicContextInJobs;
              else S.workers.magicContextInJobs = true;
              mark();
              render();
            }, "Keep Magic Context out of Claude's workers"),
            out ? "On" : "Off",
          ),
        ),
        el("p", { class: "hint", text: "Saved in the bridge's workers file; the next job follows it, with no restart." }),
      ),
    );
  }
}
