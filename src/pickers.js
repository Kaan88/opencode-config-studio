// Model + effort picker: every model OpenCode knows (live list) plus models only in the unsaved draft.
import { formatRef, parseRef, reasoningOf } from "./core.js";
import { el, select } from "./dom.js";
import { S } from "./state.js";

// { "provider/id": { label, provider, variants[] } }, grouped by provider name
function catalog() {
  const all = new Map();
  for (const m of S.catalog) all.set(`${m.provider}/${m.id}`, { provider: m.provider, label: m.name, variants: m.variants });
  for (const [pid, p] of Object.entries(S.config.providers || {}))
    for (const [mid, m] of Object.entries(p.models || {})) {
      const ref = `${pid}/${mid}`;
      const r = reasoningOf(m);
      const known = all.get(ref);
      all.set(ref, { provider: pid, label: m.name || mid, variants: r.mode === "on" && r.levels.length ? r.levels : known?.variants || [], disabled: m.disabled });
    }
  return all;
}

export function modelPicker(value, onchange, { label = "Model", emptyLabel = "OpenCode default" } = {}) {
  const all = catalog();
  const cur = parseRef(value);
  const curRef = cur.provider ? `${cur.provider}/${cur.model}` : "";
  const groups = new Map();
  for (const [ref, m] of all) {
    if (m.disabled && ref !== curRef) continue;
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push({ value: ref, label: m.label === ref.slice(m.provider.length + 1) ? m.label : `${m.label} · ${ref.slice(m.provider.length + 1)}` });
  }
  const options = [{ value: "", label: emptyLabel }, ...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([g, o]) => ({ group: g, options: o.sort((a, b) => a.label.localeCompare(b.label)) }))];
  if (curRef && !all.has(curRef)) options.push({ value: curRef, label: `${curRef} (not found)` });

  const effortWrap = el("span", { class: "effort" });
  const wrap = el("div", { class: "picker" });
  const emit = (ref, variant) => onchange(formatRef({ ...parseRef(ref), variant }));
  const drawEffort = (ref, variant) => {
    const levels = all.get(ref)?.variants || [];
    effortWrap.replaceChildren();
    if (!ref || !levels.length) return;
    effortWrap.append(select([{ value: "", label: "Default effort" }, ...levels.map((v) => ({ value: v, label: v }))], levels.includes(variant) ? variant : "", (v) => emit(modelSel.value, v), `${label} effort`));
  };
  const modelSel = select(options, curRef, (ref) => {
    drawEffort(ref, "");
    emit(ref, "");
  }, label);
  drawEffort(curRef, cur.variant);
  wrap.append(modelSel, effortWrap);
  return wrap;
}
