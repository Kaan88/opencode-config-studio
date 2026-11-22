// The generic schema-driven editor (every field OpenCode's schema knows). Used only on the Advanced page and
// for "all fields" views; the everyday screens use plain forms instead.
import { button, dialog, el, field } from "./dom.js";
import { mark, S } from "./state.js";

const clone = (x) => structuredClone(x);
export const resolve = (s) =>
  s?.$ref ? (s.$ref.startsWith("#/") ? resolve(s.$ref.split("/").slice(1).reduce((x, k) => x?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], S.schema)) : {}) : s || {};
const typeOf = (s) => {
  s = resolve(s);
  return s.type || (s.properties ? "object" : s.items ? "array" : undefined);
};
function branch(s, value) {
  s = resolve(s);
  const options = s.anyOf || s.oneOf;
  if (!options) return s;
  return resolve(
    options.find((x) => {
      x = resolve(x);
      const t = typeOf(x);
      if (x.enum) return x.enum.some((v) => JSON.stringify(v) === JSON.stringify(value));
      if (t === "object") {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        return Object.entries(x.properties || {}).every(([key, prop]) => {
          prop = resolve(prop);
          if (!(key in value)) return true;
          if (prop.enum) return prop.enum.includes(value[key]);
          if ("const" in prop) return prop.const === value[key];
          return true;
        });
      }
      if (t === "array") return Array.isArray(value);
      return t === typeof value || (t === "integer" && typeof value === "number") || (t === "null" && value === null);
    }) || options[0],
  );
}
function initial(s) {
  s = resolve(s);
  if (s.default !== undefined) return clone(s.default);
  if (s.enum) return clone(s.enum[0]);
  if (s.const !== undefined) return clone(s.const);
  if (s.anyOf || s.oneOf) return initial((s.anyOf || s.oneOf)[0]);
  const t = typeOf(s);
  if (t === "object") {
    const o = {};
    for (const k of s.required || []) o[k] = initial(s.properties?.[k] || {});
    return o;
  }
  if (t === "array") return [];
  if (t === "boolean") return false;
  if (t === "number" || t === "integer") return 0;
  if (t === "null") return null;
  return "";
}
const input = (value, onchange, type = "text") => el("input", { type, value: value ?? "", oninput: (e) => (onchange(e.target.value), mark()) });

function askKey(title, run) {
  const name = el("input", { "aria-label": "Field name" });
  dialog(title, field("Field name", name), [{ label: "Cancel" }, { label: "Add", kind: "primary", run: () => run(name.value.trim()) }]);
}

export function editor(s, value, set, label = "Settings", depth = 0) {
  s = resolve(s);
  const original = s;
  s = branch(s, value);
  const wrap = el("div");
  const alternatives = original.anyOf || original.oneOf;
  if (alternatives && alternatives.length > 1) {
    const sel = el("select", {
      "aria-label": `${label} value type`,
      onchange: (e) => {
        const next = initial(resolve(alternatives[Number(e.target.value)]));
        set(next);
        mark();
        wrap.replaceWith(editor(original, next, set, label, depth));
      },
    });
    alternatives.forEach((x, i) => {
      x = resolve(x);
      sel.append(el("option", { value: i, text: x.enum ? JSON.stringify(x.enum) : x.properties?.supported?.enum ? `Reasoning ${x.properties.supported.enum[0] ? "supported" : "unsupported"}` : typeOf(x) || "JSON" }));
    });
    sel.value = String(Math.max(0, alternatives.findIndex((x) => resolve(x) === s)));
    wrap.append(field("Value type", sel));
  }
  const t = typeOf(s);
  if (s.enum) {
    const sel = el("select", { "aria-label": label, onchange: (e) => (set(clone(s.enum[Number(e.target.value)])), mark()) });
    s.enum.forEach((v, i) => sel.append(el("option", { value: i, text: String(v) })));
    sel.value = String(Math.max(0, s.enum.findIndex((v) => JSON.stringify(v) === JSON.stringify(value))));
    wrap.append(sel);
    return wrap;
  }
  if (t === "object" || (value && typeof value === "object" && !Array.isArray(value))) {
    const obj = value || {};
    const properties = s.properties || {};
    const body = el("div", { class: "objectbody" });
    const draw = () => {
      body.replaceChildren();
      for (const key of Object.keys(obj)) {
        const sub = properties[key] || s.additionalProperties || {};
        const row = el("div", { class: "row" });
        const grow = el("div", { class: "grow" });
        const subType = typeOf(branch(sub, obj[key]));
        const child = editor(sub, obj[key], (v) => ((obj[key] = v), set(obj)), key, depth + 1);
        if (subType === "object" || subType === "array" || (obj[key] && typeof obj[key] === "object")) grow.append(el("details", {}, el("summary", { text: key }), child));
        else grow.append(field(key, child.querySelector("input,select,textarea") && child.children.length === 1 ? child.firstChild : child, resolve(sub).description));
        row.append(grow, button("×", () => (delete obj[key], set(obj), mark(), draw()), "icon danger", { "aria-label": `Remove ${key}` }));
        body.append(row);
      }
      const known = Object.keys(properties).filter((k) => !(k in obj));
      const add = el("div", { class: "addrow" });
      const allowCustom = s.additionalProperties !== false || s.allOf?.some((x) => resolve(x).additionalProperties);
      if (known.length) {
        const sel = el("select", { "aria-label": "Field to add" }, ...known.map((k) => el("option", { value: k, text: k })));
        add.append(sel, button("Add field", () => ((obj[sel.value] = initial(properties[sel.value])), set(obj), mark(), draw())));
      }
      if (allowCustom)
        add.append(
          button("Custom field…", () =>
            askKey("Add a custom field", (key) => {
              if (!key || ["__proto__", "prototype", "constructor"].includes(key) || key in obj) throw Error("Choose a unique field name");
              obj[key] = null;
              set(obj);
              mark();
              draw();
            }),
          ),
        );
      if (add.children.length) body.append(add);
    };
    draw();
    wrap.append(body);
    return wrap;
  }
  if (t === "array" || Array.isArray(value)) {
    const arr = value || [];
    const draw = () => {
      wrap.replaceChildren();
      arr.forEach((v, i) => {
        const row = el("div", { class: "row" });
        row.append(
          el("div", { class: "grow" }, editor(s.items || {}, v, (next) => ((arr[i] = next), set(arr)), `${label} ${i + 1}`, depth + 1)),
          button("↑", () => i && (([arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]), set(arr), mark(), draw()), "icon", { "aria-label": "Move up" }),
          button("×", () => (arr.splice(i, 1), set(arr), mark(), draw()), "icon danger", { "aria-label": "Remove item" }),
        );
        wrap.append(row);
      });
      wrap.append(button("+ Add item", () => (arr.push(initial(s.items || {})), set(arr), mark(), draw()), "small"));
    };
    draw();
    return wrap;
  }
  if (t === "boolean") {
    const sel = el("select", { "aria-label": label, onchange: (e) => (set(e.target.value === "true"), mark()) }, el("option", { value: "true", text: "true" }), el("option", { value: "false", text: "false" }));
    sel.value = String(value);
    wrap.append(sel);
    return wrap;
  }
  if (t === "string" || t === "number" || t === "integer") {
    const i = input(value, (v) => (t === "string" ? set(v) : v !== "" && Number.isFinite(Number(v)) && set(Number(v))), t === "string" ? (/apikey|token|secret|password/i.test(label) ? "password" : "text") : "number");
    i.setAttribute("aria-label", label);
    wrap.append(i);
    return wrap;
  }
  const ta = el("textarea", { "aria-label": label, rows: "3" });
  ta.value = JSON.stringify(value ?? null, null, 2);
  ta.addEventListener("input", () => {
    try {
      set(JSON.parse(ta.value));
      ta.setCustomValidity("");
    } catch {
      ta.setCustomValidity("Invalid JSON");
    }
    mark();
  });
  wrap.append(ta, el("small", { class: "hint", text: "JSON value: string, number, boolean, object, array or null." }));
  return wrap;
}

// Edits obj[key] through the schema editor; only changed fields are written back.
function applyDelta(before, after, current) {
  if (JSON.stringify(before) === JSON.stringify(after)) return current;
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const result = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const v = applyDelta(before[key], after[key], result[key]);
      if (v === undefined) delete result[key];
      else result[key] = v;
    }
    return result;
  }
  return after === undefined ? undefined : clone(after);
}
export function boundEditor(s, obj, key, fallback = {}) {
  let baseline = clone(obj[key] ?? fallback);
  return editor(s, clone(baseline), (v) => {
    obj[key] = applyDelta(baseline, v, obj[key]);
    baseline = clone(v);
  }, key);
}
