import { test } from "node:test";
import assert from "node:assert/strict";
import { clientScript } from "../../scripts/views/map.mjs";

// BLZ-35: regression lock for the map's client interactions, zero-dep by the
// BLZ-31 prime directive. The clientScript IIFE runs against a hand-rolled DOM
// shim; pointer-capture retargeting (the shipped Critical: pointerup retargets
// to the <svg>, so resolving e.target.closest("[data-node-id]") at pointerup
// yields null) is ENCODED by dispatching pointerdown with target=node and
// pointerup with target=svg — exactly the sequence a real browser produces.
// LIMITATION: this asserts the seam's logic, not real browser semantics; a DOM
// API the shim doesn't model is not covered. jsdom would not model pointer
// capture either. Final verification stays a real-browser check on the board.

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
  const node = makeEl("g", { attrs: { "data-node-id": "T-1" }, parent: svg });
  const drillNode = makeEl("g", { attrs: { "data-node-id": "T-2" }, parent: svg });
  const drill = makeEl("g", { attrs: { "data-drill": "T-2" }, parent: drillNode });
  const zoomIn = makeEl("button", { dataset: { zoom: "in" } });
  const zoomOut = makeEl("button", { dataset: { zoom: "out" } });
  const zoomReset = makeEl("button", { dataset: { zoom: "reset" } });
  const doc = {
    querySelector: (sel) => (sel === "svg.graph" ? svg : null),
    querySelectorAll: (sel) => (sel === ".mzoom" ? [zoomIn, zoomOut, zoomReset] : []),
  };
  const opened = [];
  const win = { blazePanel: { open: (id) => opened.push(id) } };
  const location = { search: "" };
  new Function("document", "window", "location", clientScript)(doc, win, location);
  return { svg, node, drill, zoomIn, zoomOut, zoomReset, opened, location };
}

test("v2: a drill-affordance click navigates to ?focus=<id> (params preserved), not the panel", () => {
  const { svg, drill, opened, location } = mount();
  location.search = "?project=BLZ";
  svg.dispatch("pointerdown", { target: drill, clientX: 50, clientY: 50, pointerId: 1 });
  svg.dispatch("pointerup", { target: svg, clientX: 50, clientY: 50, pointerId: 1 });
  assert.equal(location.search, "project=BLZ&focus=T-2");
  assert.deepEqual(opened, []);
});

test("BLZ-35 regression: node pointerdown + capture-retargeted pointerup (target=svg) opens the panel", () => {
  const { svg, node, opened } = mount();
  svg.dispatch("pointerdown", { target: node, clientX: 100, clientY: 100, pointerId: 1 });
  svg.dispatch("pointerup", { target: svg, clientX: 100, clientY: 100, pointerId: 1 });
  assert.deepEqual(opened, ["T-1"]);
});

test("a drag past the 4px threshold pans and does NOT open the panel", () => {
  const { svg, node, opened } = mount();
  svg.dispatch("pointerdown", { target: node, clientX: 100, clientY: 100, pointerId: 1 });
  svg.dispatch("pointermove", { target: svg, clientX: 120, clientY: 130, pointerId: 1 });
  svg.dispatch("pointerup", { target: svg, clientX: 120, clientY: 130, pointerId: 1 });
  assert.deepEqual(opened, []);
  assert.equal(svg.getAttribute("viewBox"), "-20 -30 800 600"); // panned by the drag delta
});

test("zoom buttons mutate the viewBox; reset restores the base", () => {
  const { svg, zoomIn, zoomReset } = mount();
  zoomIn.dispatch("click");
  assert.equal(svg.getAttribute("viewBox"), "80 60 640 480"); // 0.8x about the center
  zoomReset.dispatch("click");
  assert.equal(svg.getAttribute("viewBox"), "0 0 800 600");
});

test("wheel zoom respects the 0.2–8 scale clamp (stops changing at max zoom)", () => {
  const { svg } = mount();
  for (let i = 0; i < 40; i++) svg.dispatch("wheel", { deltaY: -1, clientX: 400, clientY: 300 });
  const atClamp = svg.getAttribute("viewBox");
  svg.dispatch("wheel", { deltaY: -1, clientX: 400, clientY: 300 });
  assert.equal(svg.getAttribute("viewBox"), atClamp);
});

test("Enter on a focused node opens the panel (keyboard path)", () => {
  const { svg, node, opened } = mount();
  svg.dispatch("keydown", { key: "Enter", target: node });
  assert.deepEqual(opened, ["T-1"]);
});

test("Enter on a focused drill navigates to ?focus=<id> (drill wins over the node, keyboard path)", () => {
  const { svg, drill, opened, location } = mount();
  svg.dispatch("keydown", { key: "Enter", target: drill });
  assert.equal(location.search, "focus=T-2");
  assert.deepEqual(opened, []);
});

test("Space on a focused drill also navigates to ?focus=<id>", () => {
  const { svg, drill, opened, location } = mount();
  svg.dispatch("keydown", { key: " ", target: drill });
  assert.equal(location.search, "focus=T-2");
  assert.deepEqual(opened, []);
});
