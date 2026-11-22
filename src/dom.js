// Small DOM helpers: elements, buttons, switches, token inputs, dialogs and the status line.
import { formatTokens, parseTokens } from "./core.js";

export const $ = (s) => document.querySelector(s);

let ids = 0;
export const uid = (p = "f") => `${p}-${++ids}`;

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked") n[k] = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}

export const button = (label, onclick, cls = "", attrs = {}) => el("button", { type: "button", class: cls, onclick, ...attrs }, label);

// An on/off switch (a checkbox styled as a switch); `label` is its accessible name.
export function toggle(checked, onchange, label, attrs = {}) {
  const input = el("input", { type: "checkbox", role: "switch", checked: !!checked, "aria-label": label, ...attrs, onchange: (e) => onchange(e.target.checked) });
  return el("label", { class: "switch", title: label }, input, el("span", { class: "track", "aria-hidden": "true" }));
}

// A token count field: accepts 32k / 1m / 128,000, shows 32,768; empty = unset.
export function tokenInput(value, onchange, label, placeholder = "unset") {
  const input = el("input", { class: "num", inputmode: "numeric", "aria-label": label, placeholder, value: formatTokens(value) });
  const commit = () => {
    const n = parseTokens(input.value);
    if (Number.isNaN(n) || n < 0) {
      input.setCustomValidity("Use a number such as 32768, 32k or 1m");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    input.value = formatTokens(n);
    onchange(n);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
  return input;
}

export function textInput(value, onchange, label, attrs = {}) {
  return el("input", { value: value ?? "", "aria-label": label, ...attrs, oninput: (e) => onchange(e.target.value) });
}

export function select(options, value, onchange, label, attrs = {}) {
  const s = el("select", { "aria-label": label, ...attrs, onchange: (e) => onchange(e.target.value) });
  for (const o of options) {
    if (o.group) s.append(el("optgroup", { label: o.group }, ...o.options.map((x) => el("option", { value: x.value, text: x.label }))));
    else s.append(el("option", { value: o.value, text: o.label }));
  }
  s.value = value ?? "";
  return s;
}

// A labelled field: label above, control, optional hint below.
export function field(label, control, hint) {
  const id = control.id || uid();
  if (["INPUT", "SELECT", "TEXTAREA"].includes(control.tagName)) control.id = id;
  return el("div", { class: "field" }, el("label", { for: id, text: label }), control, hint ? el("small", { class: "hint", text: hint }) : null);
}

// ---- status line ----
let timer;
export function notice(message, kind = "info") {
  const n = $("#notice");
  clearTimeout(timer);
  n.className = `notice ${kind}`;
  n.replaceChildren();
  if (!message) return;
  n.append(typeof message === "string" ? message : message, button("×", () => notice(""), "ghost close", { "aria-label": "Dismiss" }));
  if (kind === "ok") timer = setTimeout(() => notice(""), 6000);
}
export async function act(fn) {
  try {
    return await fn();
  } catch (e) {
    notice(e?.message || String(e), "error");
  }
}

// ---- dialogs ----
export function dialog(title, body, actions, { wide = false } = {}) {
  const d = $("#modal");
  d.classList.toggle("wide", wide);
  $("#dialogtitle").textContent = title;
  $("#dialogbody").replaceChildren(...[body].flat());
  const close = () => d.close();
  $("#dialogactions").replaceChildren(
    ...actions.map((a) =>
      button(
        a.label,
        () =>
          act(async () => {
            if (a.run && (await a.run()) === false) return;
            close();
          }),
        a.kind || "",
      ),
    ),
  );
  d.showModal();
  d.querySelector("input:not([type=checkbox]),select")?.focus();
  return close;
}
export const confirmDialog = (title, message, label, run, kind = "danger") =>
  dialog(title, el("p", { text: message }), [{ label: "Cancel" }, { label, kind, run }]);
