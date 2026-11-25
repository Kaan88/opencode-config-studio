// Context page: what keeps a long OpenCode session inside the model's window. Either the Magic Context plugin or
// OpenCode's own compaction; one switch turns one on and the other off, because the two interfere when both run.
import { MAGIC_PACKAGE, MAGIC_SKIP, contextState, setContextMode, setSkipMagic, skipsMagic } from "../core.js";
import { el, toggle } from "../dom.js";
import { mark, render, S } from "../state.js";

let lastSpec = ""; // the plugin entry as it was before it was switched off, so switching back restores the same version

// The agents in this file that a worker for Claude runs (built-in agents without an entry here have no instructions to mark).
const workerAgents = () => [...new Set(Object.values(S.workers.workers || {}).filter((w) => w.runs === "opencode" && !w.disabled).map((w) => w.agent))].filter((n) => S.config.agents?.[n]);

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
  const agents = workerAgents();
  if (st.magic && agents.length) {
    const all = agents.every((n) => skipsMagic(S.config.agents[n]));
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
            el("p", { class: "hint", text: `Jobs that Claude hands to a worker are short and start fresh, so the plugin's guidance is dead weight there. This adds the plugin's own opt-out line to the instructions of the agents your workers run: ${agents.join(", ")}.` }),
          ),
          el(
            "label",
            { class: "inline-toggle" },
            toggle(all, (on) => {
              for (const n of agents) setSkipMagic(S.config.agents[n], on);
              mark();
              render();
            }, "Keep Magic Context out of Claude's workers"),
            all ? "On" : "Off",
          ),
        ),
        el("p", { class: "hint" }, "The line is ", el("code", { text: MAGIC_SKIP }), ". It stops the plugin's guidance, project notes and profile from being added to those agents' prompts; your own OpenCode sessions keep them. Save, then Reload OpenCode."),
      ),
    );
  }
}
