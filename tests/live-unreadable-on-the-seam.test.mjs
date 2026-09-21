// tests/live-unreadable-on-the-seam.test.mjs — BLZ-513.
//
// BLZ-493 made `liveModel` REPORT an activity feed it could not read instead of rendering
// the false `No recent activity.` (ADR-0031 §5). The report was right; the ROUTE was not.
// `liveModel` opened the file itself, with its own `readRegularFileSync` and its own
// `try/catch`, and handed the view a bespoke `unreadable` field — while `views/data.mjs`
// was already importing `fsReadStorage` two lines above for `contentHash`. So the one read
// on that page that can fail reached past the seam ADR-0009 exists to put reads behind.
//
// This file pins that it goes THROUGH the seam now, and it does it the only way that can
// actually tell: by INJECTING a driver. A test that just checks the returned shape passes
// identically whether `liveModel` asked the driver or opened the file behind its back.
//
// TEST CAUTION THIS FILE IS WRITTEN AGAINST (ADR-0031 §6 records it). The first version of
// the sibling Live-view test asserted `/unreadable/` against the WHOLE of `live.mjs`, which
// the destructuring `const {groups,unreadable}=…` satisfies on its own — so deleting the
// entire render branch left it green. Nothing here matches a bare name against a whole
// file: every assertion names the branch, the ORDER, or a value only the seam could have
// produced.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fsReadStorage, memReadStorage } from "../scripts/model/read-storage.mjs";
import { liveModel } from "../scripts/views/data.mjs";

const fifo = (p) => execFileSync("mkfifo", [p]);

function board() {
  const root = mkdtempSync(join(tmpdir(), "blz513-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "BLZ", "defined"), { recursive: true });
  writeFileSync(join(projects, "BLZ", "defined", "BLZ-1-t.md"),
    "---\nid: BLZ-1\ntype: task\nproject: BLZ\ntitle: t\n---\n\nbody\n");
  writeFileSync(join(projects, "BLZ", "project.json"), JSON.stringify({ key: "BLZ", codeRepos: [] }));
  mkdirSync(join(root, ".blaze"), { recursive: true });
  return { root, projects };
}

/** A driver that answers `activityFeed` however the case needs, and nothing else — so a
 *  `liveModel` that reached past the seam would be reaching past THIS. */
const driver = (answer) => ({ ...fsReadStorage, name: "stub", activityFeed: () => answer });

describe("BLZ-513: the activity feed is a NAMED question on the read seam", () => {
  test("`activityFeed` is an operation the driver answers, carrying its own unreadable", () => {
    const b = board();
    try {
      const feed = join(b.root, ".blaze", "activity.jsonl");
      fifo(feed);
      const answer = fsReadStorage.activityFeed(b.root);
      assert.equal(answer.text, "", "there is nothing to parse — but that is not the report");
      assert.ok(answer.unreadable, "the DRIVER must carry what it could not read, not the caller");
      assert.equal(answer.unreadable.path, feed);
      assert.match(answer.unreadable.detail, /FIFO/);
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("a MISSING feed is not an unreadable one, on the seam as it was off it", () => {
    // ADR-0031 §5, unchanged by this move: nearly every board has no feed, and a banner
    // that is permanent furniture is the gate people learn to skip.
    const b = board();
    try {
      const answer = fsReadStorage.activityFeed(b.root);
      assert.equal(answer.text, "");
      assert.equal(answer.unreadable, null);
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("liveModel's `unreadable` comes FROM the driver — an injected one is not ignored", () => {
    // THE DISCRIMINATING CASE. There is no feed on disk at all, so a `liveModel` that still
    // opened the file itself would report `unreadable: null` and this goes red. The value
    // is one only the injected driver could have produced.
    const b = board();
    try {
      const m = liveModel(b.root, b.projects, {
        readStorage: driver({ text: "", unreadable: { path: "/injected/feed", detail: "INJECTED" } }),
      });
      assert.ok(m.unreadable,
        "liveModel reported no unreadable condition while the driver reported one — which "
        + "means it never asked the driver. That is the bespoke route this ticket closes.");
      assert.equal(m.unreadable.path, "/injected/feed");
      assert.equal(m.unreadable.detail, "INJECTED");
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("liveModel's EVENTS come from the driver too, not from a second read behind it", () => {
    // The mirror of the case above, and it is here because reporting through the seam while
    // still READING around it would satisfy that one. The file on disk is a FIFO: any read
    // `liveModel` performs itself would refuse and show up as an `unreadable`. The driver
    // says the feed is fine and has one event in it, and that must be what comes back.
    const b = board();
    try {
      fifo(join(b.root, ".blaze", "activity.jsonl"));
      const ts = new Date().toISOString();
      const m = liveModel(b.root, b.projects, {
        readStorage: driver({
          text: JSON.stringify({ ts, key: "BLZ-1", tool: "Edit", branch: "b" }) + "\n",
          unreadable: null,
        }),
      });
      assert.equal(m.unreadable, null,
        "a second read behind the driver refused, and its refusal leaked into the model");
      assert.equal(m.groups.length, 1,
        `the events must be the DRIVER's. Got: ${JSON.stringify(m.groups)}`);
      assert.equal(m.groups[0].key, "BLZ-1");
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("every in-tree driver answers it, so the operation is a contract and not an fs detail", () => {
    for (const [name, s] of [["fs", fsReadStorage], ["mem", memReadStorage([])]]) {
      assert.equal(typeof s.activityFeed, "function", `${name} does not answer activityFeed`);
      const a = s.activityFeed(mkdtempSync(join(tmpdir(), "blz513-empty-")));
      assert.equal(typeof a.text, "string", `${name}: text must always be a string`);
      assert.ok(a.unreadable === null || typeof a.unreadable === "object",
        `${name}: unreadable is a record or null, never undefined — a consumer branches on it`);
    }
  });

  test("the view branches on the SAME field name the seam emits, and BEFORE the empty state", () => {
    // Not `/unreadable/` against the whole file — that is satisfied by the destructuring
    // alone, which is exactly how the first version of this assertion passed over a deleted
    // render branch. Each of these names a branch, a sentence, or an order.
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "views", "live.mjs"), "utf8");
    assert.match(src, /if\(unreadable\)\{/,
      "views/live.mjs must BRANCH on `unreadable`, or the seam reports to nobody");
    assert.match(src, /ACTIVITY FEED UNREADABLE/,
      "and the branch must say what happened, in the words an operator reads");
    assert.match(src, /if\(unreadable\)[\s\S]*?No recent activity/,
      "the unreadable branch must come BEFORE the empty-state branch, or it never runs");
    assert.match(src, /esc\(unreadable\.path\)/,
      "and it must render the driver's `path` field — if the seam renamed it, this is the "
      + "one assertion that notices, because the branch would otherwise print `undefined`");
  });
});
