// scripts/model/safe-json.mjs — the one reader of `extra_json` (BLZ-679).
//
// A leaf: no imports. The write port and both db readers (pg-storage, sqlite-storage) parse
// the stored unknown-key object with it, so the three cannot disagree on what a stored value
// reads back as.

/** A corrupt extra_json must not take the whole read down — report empty, never throw. */
export function safeJson(text) {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
