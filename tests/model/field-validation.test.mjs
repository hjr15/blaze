// tests/model/field-validation.test.mjs — BLZ-328, spec §4.1's third write-time block.
//
// `field_definition` has carried is_required / enum_values / min_value / max_value since
// BLZ-321 and NOTHING has ever read them. A constraint nobody enforces is worse than no
// constraint: it reads as protection on the schema diagram. This is the reader.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateFieldValues, parseEnumValues } from "../../scripts/model/field-validation.mjs";

const defn = (o) => ({
  project_key: "BLZ", applies_to_kind: "requirement", data_type: "text",
  is_required: false, enum_values: null, min_value: null, max_value: null, ...o,
});
const run = (definitions, values, over = {}) =>
  validateFieldValues({ definitions, values, project_key: "BLZ", kind: "requirement", ...over });

describe("required-field presence", () => {
  test("a missing required field is refused", () => {
    const r = run([defn({ key: "owner", is_required: true })], {});
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].key, "owner");
    assert.match(r.error, /owner/);
  });

  test("EVERY missing required field is named in one refusal, not just the first", () => {
    // §4.2's rule for gates applies here for the same reason: a refusal the person cannot
    // act on in one pass is a defect. Three round-trips to learn three missing fields is
    // exactly that.
    const defs = ["owner", "rationale", "source"].map((key) => defn({ key, is_required: true }));
    const r = run(defs, {});
    assert.equal(r.violations.length, 3);
    for (const k of ["owner", "rationale", "source"]) assert.match(r.error, new RegExp(k));
  });

  test("an empty string and whitespace do not satisfy a required field", () => {
    assert.equal(run([defn({ key: "owner", is_required: true })], { owner: "" }).ok, false);
    assert.equal(run([defn({ key: "owner", is_required: true })], { owner: "   " }).ok, false);
    assert.equal(run([defn({ key: "owner", is_required: true })], { owner: null }).ok, false);
  });

  test("`false` and `0` DO satisfy a required field — they are values, not absence", () => {
    // The classic falsy-check bug. A required boolean that can never be false, and a
    // required number that can never be zero, are both useless fields.
    assert.equal(run([defn({ key: "b", data_type: "boolean", is_required: true })], { b: false }).ok, true);
    assert.equal(run([defn({ key: "n", data_type: "number", is_required: true })], { n: 0 }).ok, true);
  });

  test("a non-required field may be absent", () => {
    assert.equal(run([defn({ key: "owner" })], {}).ok, true);
  });
});

describe("closed-enum validity", () => {
  const ENUM = defn({ key: "sev", data_type: "enum", enum_values: "low,medium,high" });

  test("a declared value passes", () => {
    assert.equal(run([ENUM], { sev: "medium" }).ok, true);
  });

  test("an undeclared value is refused, and the refusal LISTS the legal values", () => {
    const r = run([ENUM], { sev: "catastrophic" });
    assert.equal(r.ok, false);
    for (const v of ["low", "medium", "high"]) assert.match(r.violations[0].why, new RegExp(v));
  });

  test("enum matching is exact — case and surrounding space are not silently forgiven", () => {
    assert.equal(run([ENUM], { sev: "Medium" }).ok, false);
    assert.equal(run([ENUM], { sev: " medium" }).ok, false);
  });

  test("parseEnumValues takes the comma-separated form field-schema.test.mjs already writes", () => {
    assert.deepEqual(parseEnumValues("low,medium,high"), ["low", "medium", "high"]);
    assert.deepEqual(parseEnumValues("low, medium , high"), ["low", "medium", "high"]);
    assert.deepEqual(parseEnumValues(["a", "b"]), ["a", "b"]);
    assert.deepEqual(parseEnumValues(null), []);
  });
});

describe("type validity", () => {
  test("a number field refuses a non-numeric string", () => {
    const r = run([defn({ key: "score", data_type: "number" })], { score: "abc" });
    assert.equal(r.ok, false);
    assert.match(r.violations[0].why, /number/);
  });

  test("a number field refuses a BOOLEAN — Number(true) is 1, which would silently pass", () => {
    assert.equal(run([defn({ key: "score", data_type: "number" })], { score: true }).ok, false);
  });

  test("an empty string is ABSENCE, and never reaches the Number('') === 0 coercion", () => {
    // Two ways to get this wrong. Coercing "" to 0 would satisfy a min_value of 1 as
    // though the user had typed a number, and would fail a min_value of 1 as though they
    // had typed zero. Neither is true: they typed nothing. `isAbsent` is checked first,
    // consistently with how is_required already treats "".
    const bounded = defn({ key: "score", data_type: "number", min_value: "1", max_value: "10" });
    assert.equal(run([bounded], { score: "" }).ok, true, "empty must not be range-checked at all");
    assert.equal(run([bounded], { score: 0 }).ok, false, "but a real zero is out of range");
    assert.equal(run([{ ...bounded, is_required: true }], { score: "" }).ok, false,
      "and empty still does not satisfy a required field");
  });

  test("a number field accepts a numeric string and a real number", () => {
    assert.equal(run([defn({ key: "score", data_type: "number" })], { score: "7.5" }).ok, true);
    assert.equal(run([defn({ key: "score", data_type: "number" })], { score: -3 }).ok, true);
  });

  test("a boolean field refuses 'maybe' and accepts true/false", () => {
    assert.equal(run([defn({ key: "b", data_type: "boolean" })], { b: "maybe" }).ok, false);
    assert.equal(run([defn({ key: "b", data_type: "boolean" })], { b: true }).ok, true);
    assert.equal(run([defn({ key: "b", data_type: "boolean" })], { b: false }).ok, true);
  });

  test("a date field refuses 'not-a-date' and a real-looking but impossible date", () => {
    assert.equal(run([defn({ key: "d", data_type: "date" })], { d: "not-a-date" }).ok, false);
    // 2026-02-30 matches /\d{4}-\d{2}-\d{2}/ and is not a day. A shape check alone passes
    // it -- the exact class of bug the spec's own testing rule 1 was written about.
    assert.equal(run([defn({ key: "d", data_type: "date" })], { d: "2026-02-30" }).ok, false);
    assert.equal(run([defn({ key: "d", data_type: "date" })], { d: "2026-02-28" }).ok, true);
  });

  test("a text field accepts a string and refuses an object", () => {
    assert.equal(run([defn({ key: "t" })], { t: "hello" }).ok, true);
    assert.equal(run([defn({ key: "t" })], { t: { a: 1 } }).ok, false);
  });
});

describe("range validity", () => {
  const NUM = defn({ key: "score", data_type: "number", min_value: "1", max_value: "10" });

  test("a value below min is refused, and the refusal states the bound and the value", () => {
    const r = run([NUM], { score: 0 });
    assert.equal(r.ok, false);
    assert.match(r.violations[0].why, /1/);
    assert.match(r.violations[0].why, /0/);
  });

  test("a value above max is refused", () => {
    assert.equal(run([NUM], { score: 11 }).ok, false);
  });

  test("both bounds are INCLUSIVE", () => {
    assert.equal(run([NUM], { score: 1 }).ok, true);
    assert.equal(run([NUM], { score: 10 }).ok, true);
  });

  test("a missing min_value is NOT a floor of zero", () => {
    // The absent-means-zero bug: `min_value ?? 0` makes every unbounded number field
    // silently reject negatives.
    const d = defn({ key: "score", data_type: "number", min_value: null, max_value: null });
    assert.equal(run([d], { score: -100 }).ok, true);
  });

  test("only one bound may be set, and the other stays unbounded", () => {
    const lo = defn({ key: "score", data_type: "number", min_value: "5" });
    assert.equal(run([lo], { score: 1000000 }).ok, true);
    assert.equal(run([lo], { score: 4 }).ok, false);
  });

  test("date ranges compare as dates, inclusive at both ends", () => {
    const d = defn({ key: "due", data_type: "date", min_value: "2026-01-01", max_value: "2026-12-31" });
    assert.equal(run([d], { due: "2025-12-31" }).ok, false);
    assert.equal(run([d], { due: "2026-01-01" }).ok, true);
    assert.equal(run([d], { due: "2026-12-31" }).ok, true);
    assert.equal(run([d], { due: "2027-01-01" }).ok, false);
  });

  test("a range on a text field is ignored — text has no ordering the user declared", () => {
    // The bounds are real strings here, not numeric-looking ones: with "1"/"10" any
    // numeric comparison yields NaN and can never fire, so such a test proves nothing
    // (it passed a `text` comparator injected as a mutation). With "m"/"p" a
    // lexicographic comparison WOULD reject both values below, so this discriminates.
    const t = defn({ key: "t", data_type: "text", min_value: "m", max_value: "p" });
    assert.equal(run([t], { t: "zzz" }).ok, true, "'zzz' > 'p' lexicographically");
    assert.equal(run([t], { t: "abc" }).ok, true, "'abc' < 'm' lexicographically");
  });
});

describe("scoping — a definition constrains only what it was declared for", () => {
  test("a field defined for ANOTHER project does not constrain this one", () => {
    const d = defn({ key: "owner", is_required: true, project_key: "OTHER" });
    assert.equal(run([d], {}).ok, true);
  });

  test("a field defined for ANOTHER applies_to_kind does not constrain this one", () => {
    const d = defn({ key: "owner", is_required: true, applies_to_kind: "architecture" });
    assert.equal(run([d], {}).ok, true);
  });

  test("a value supplied for a field nobody defined is refused, not silently accepted", () => {
    // Default deny (§4.1). A typo'd key that is quietly dropped is a value the user
    // believes they set.
    const r = run([defn({ key: "owner" })], { ownr: "me" });
    assert.equal(r.ok, false);
    assert.match(r.error, /ownr/);
  });

  test("no definitions at all means nothing is constrained, and no value is legal", () => {
    assert.equal(run([], {}).ok, true);
    assert.equal(run([], { anything: 1 }).ok, false);
  });
});
