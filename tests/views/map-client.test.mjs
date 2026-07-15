import { test } from "node:test";
import assert from "node:assert/strict";
import { clientScript } from "../../scripts/views/map.mjs";

// BLZ-35 (v2 drill-nav slice, added under TDD ahead of the rest of the suite
// — see plan Task 4 Step 2). Task 8 EXTENDS this file with the full
// click/drag/zoom/drill-priority regression suite; it does NOT create it and
// must not redefine `makeEl`/`mount` below (it upgrades `mount` in place to
// add the elements its own tests need — see Task 8 Step 1).
//
// This minimal shim is just enough to dispatch a pointerdown/pointerup
// sequence at a standalone `[data-drill]` element (no `[data-node-id]`
// ancestor — deliberately isolated from the node-click path) and observe
// navigation via `location.search`.

function makeEl(tag, { attrs = {}, dataset = {}, parent = null } = {}) {
  const el = {
    tagName: tag,
    attrs: { ...attrs },
    dataset: { ...dataset },
    parentElement: parent,
    classes: new Set(),
    listeners: new Map(),
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    setAttribute(k, v) { el.attrs[k] = String(v); },
    matches(sel) {
      const m = sel.match(/^\[([a-z-]+)\]$/);
      return m ? el.getAttribute(m[1]) !== null : false;
    },
    closest(sel) {
      let cur = el;
      while (cur) { if (cur.matches(sel)) return cur; cur = cur.parentElement; }
      return null;
    },
    addEventListener(type, fn) {
      if (!el.listeners.has(type)) el.listeners.set(type, []);
      el.listeners.get(type).push(fn);
    },
    dispatch(type, props = {}) {
      const e = { type, target: el, preventDefault() {}, ...props };
      for (const fn of el.listeners.get(type) ?? []) fn(e);
      return e;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture() {}, // retargeting is encoded by the test's dispatch sequence
    releasePointerCapture() {},
  };
  el.classList = {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    contains: (c) => el.classes.has(c),
  };
  return el;
}

function mount() {
  const svg = makeEl("svg", { dataset: { w: "800", h: "600" }, attrs: { viewBox: "0 0 800 600" } });
  const drill = makeEl("g", { attrs: { "data-drill": "T-2" }, parent: svg });
  const doc = {
    querySelector: (sel) => (sel === "svg.graph" ? svg : null),
    querySelectorAll: () => [],
  };
  const opened = [];
  const win = { blazePanel: { open: (id) => opened.push(id) } };
  const location = { search: "" };
  new Function("document", "window", "location", clientScript)(doc, win, location);
  return { svg, drill, opened, location };
}

test("v2: a drill-affordance click navigates to ?focus=<id> (params preserved), not the panel", () => {
  const { svg, drill, opened, location } = mount();
  location.search = "?project=BLZ";
  svg.dispatch("pointerdown", { target: drill, clientX: 50, clientY: 50, pointerId: 1 });
  svg.dispatch("pointerup", { target: svg, clientX: 50, clientY: 50, pointerId: 1 });
  assert.equal(location.search, "project=BLZ&focus=T-2");
  assert.deepEqual(opened, []);
});
