import { button, dialog, el, field, notice } from "../dom.js";
import { invoke } from "../state.js";

export function workerSignIn() {
  const rows = el("div"), refresh = button("Check sign-ins", load);
  const section = el("section", { class: "card" },
    el("div", { class: "split" }, el("div", {}, el("h3", { text: "Worker sign-ins" }),
      el("p", { class: "hint", text: "Workers sign in separately from your own OpenCode. These are the providers used by your saved workers." })), refresh), rows);
  async function load() {
    refresh.disabled = true;
    rows.replaceChildren(el("p", { class: "hint", text: "Checking worker sign-ins…" }));
    try {
      const { providers, personal } = await invoke("worker_auth_status");
      rows.replaceChildren();
      if (personal) rows.append(el("p", { text: "Your Context setting currently sends workers to your own OpenCode. The sign-ins below are for separate worker mode." }));
      if (!providers.length) rows.append(el("p", { text: "No OpenCode workers are configured." }));
      for (const p of providers) {
        const available = p.status !== "No sign-in required";
        rows.append(el("div", { class: "split" }, el("div", {}, el("strong", { text: p.id }), " · ", el("span", { text: p.status })),
          el("div", { class: "actions" },
            available && button("Sign in", () => terminal("login", p.id)),
            p.key && button("Enter API key", () => keyDialog(p.id)),
            p.stored && button("Sign out", () => terminal("logout", p.id)))));
      }
    } catch (e) { rows.replaceChildren(el("p", { class: "hint", text: String(e) })); }
    finally { refresh.disabled = false; }
  }
  async function terminal(action, provider) {
    try {
      await invoke("worker_auth_terminal", { action, provider });
      notice("Finish in the OpenCode terminal, then click Check sign-ins.", "ok");
    } catch (e) { notice(String(e), "error"); }
  }
  function keyDialog(provider) {
    const input = el("input", { type: "password", autocomplete: "off", spellcheck: "false", "aria-label": `${provider} worker API key` });
    dialog(`Enter API key for ${provider} workers`, [field("API key", input, "Sent directly to worker OpenCode. Studio does not save a copy.")], [
      { label: "Cancel", run: () => { input.value = ""; } },
      { label: "Save worker key", kind: "primary", run: async () => {
        await submitWorkerKey(input, provider, invoke);
        notice("Worker key saved.", "ok");
        await load();
      } },
    ]);
    input.closest("dialog")?.addEventListener("close", () => { input.value = ""; }, { once: true });
  }
  return section;
}

export async function submitWorkerKey(input, provider, send) {
  if (!input.value) throw Error("Enter an API key.");
  let pending;
  try { pending = send("worker_auth_key", { provider, key: input.value }); }
  finally { input.value = ""; }
  await pending;
}
