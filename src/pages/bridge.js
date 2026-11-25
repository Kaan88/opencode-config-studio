// Bridge page: what the bridge is, whether it is installed and registered, and a button that installs or updates it.
import { act, button, el, notice } from "../dom.js";
import { invoke, render, S } from "../state.js";

let loading = false;
async function check() {
  if (loading) return;
  loading = true;
  try {
    S.bridge = await invoke("bridge_status");
    S.bridgeError = "";
  } catch (e) {
    S.bridgeError = e?.message || String(e);
  } finally {
    loading = false;
  }
  if (S.page === "bridge") render();
}

const fact = (label, ok, text) => [el("span", { class: "muted", text: label }), el("span", { class: `status ${ok ? "up" : "down"}`, text })];

export function bridgePage(root) {
  root.append(
    el(
      "div",
      { class: "pagehead" },
      el(
        "div",
        {},
        el("h2", { text: "Bridge" }),
        el("p", { class: "lead", text: "The bridge is a small server that Claude Code and Claude Desktop start by themselves. It carries a job from Claude to one of your workers and brings the answer back." }),
      ),
      button("Check again", () => act(check)),
    ),
    el(
      "section",
      { class: "card" },
      el("h3", { text: "What does what" }),
      el(
        "div",
        { class: "facts" },
        el("strong", { text: "OpenCode" }),
        el("span", { text: "The Models, Agents and Advanced pages. This is OpenCode's own configuration, used when you work in OpenCode." }),
        el("strong", { text: "Workers" }),
        el("span", { text: "The list of what Claude may run. Each worker runs one OpenCode agent, or Claude Code itself on your Claude plan." }),
        el("strong", { text: "Bridge" }),
        el("span", { text: "Installed once on this PC. Claude asks it for a worker by name; anything not on the Workers page is refused." }),
      ),
    ),
  );
  const b = S.bridge;
  if (!b) {
    root.append(el("section", { class: "card" }, el("p", { class: "muted", text: S.bridgeError ? `Couldn't check the bridge: ${S.bridgeError}` : "Checking…" })));
    if (!S.bridgeError) check();
    return;
  }
  const update = b.installed && b.latest && b.version && b.latest !== b.version;
  const run = () =>
    act(async () => {
      notice(await invoke("bridge_install"), "ok");
    });
  root.append(
    el(
      "section",
      { class: "card" },
      el(
        "div",
        { class: "backendhead" },
        el("h3", { text: b.installed ? "Installed" : "Not installed" }),
        el("div", { class: "actions" }, button(b.installed ? (update ? `Update to ${b.latest}` : "Run setup again") : "Install the bridge", run, !b.installed || update ? "primary" : "")),
      ),
      el(
        "div",
        { class: "facts" },
        ...fact("Bridge", b.installed, b.installed ? `version ${b.version || "unknown"} in ${b.dir}` : `not found in ${b.dir}`),
        ...fact("Latest version", !update, b.latest ? (update ? `${b.latest} is available` : `${b.latest}, up to date`) : "could not be read from GitHub"),
        ...fact("Claude Code", b.claude_code, b.claude_code ? "registered" : "not registered"),
        ...fact("Claude Desktop", b.claude_desktop, b.claude_desktop ? "registered" : "not registered"),
        ...fact("Node.js", b.node, b.node ? "found" : "not found (the setup installs it)"),
        ...fact("Claude Code CLI", b.claude, b.claude ? "found" : "not found (the setup installs it)"),
        ...fact("OpenCode", b.opencode, b.opencode ? "found" : "not found (the setup installs it)"),
      ),
      el(
        "p",
        { class: "hint" },
        "The button opens a terminal that runs the bridge's own setup script: it installs what is missing, updates the bridge, asks for a DeepSeek key only when OpenCode has none, and registers the bridge in Claude Code and Claude Desktop. The same by hand: ",
        el("code", { text: b.command }),
      ),
      el("p", { class: "hint", text: "After it finishes, restart Claude Desktop and start a new Claude Code session; sessions already open keep the version they started with." }),
    ),
  );
}
