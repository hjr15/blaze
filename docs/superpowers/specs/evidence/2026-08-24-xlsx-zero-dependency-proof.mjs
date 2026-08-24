// docs/superpowers/specs/evidence/2026-08-24-xlsx-zero-dependency-proof.mjs
//
// EVIDENCE for spec 4 (BLZ-365) §1.3. This is NOT production code and nothing
// imports it — the shipped writer is specified to live at `scripts/model/xlsx.mjs`.
// It is committed so §1.3's claim is reproducible rather than asserted.
//
// The claim: Blaze can write a valid .xlsx with ZERO dependencies. An .xlsx is a
// ZIP of XML; `node:zlib` supplies DEFLATE, and the ZIP container, CRC-32 and the
// six OOXML parts are hand-written. The SHIPPED writer imports nothing else;
// `node:url` below is used only by the --bench harness's run-as-main guard.
//
// Reproduce every figure below with:
//   node <this file> --bench /path/to/board/projects
//
// Measured 2026-08-24 (Node v24.19.0), medians of 7 runs. The 50k row set is
// built by CYCLING real board rows: an earlier run used synthetic repeated rows,
// which compress far better than real ticket titles and flattered the result by
// ~1.8x on size and ~1.2x on time.
//   live board, 2,613 rows x 13 cols, level 6 ->  220.4 KB in   52 ms
//   live board, same rows,            level 9 ->  215.1 KB in  102 ms
//   50,000 real-shaped rows,          level 6 ->  4.09 MB in  948 ms
//   50,000 real-shaped rows,          level 9 ->  3.99 MB in 1825 ms
// ADR-0016 benchmarked the same 50k-row workload at 2,026.2 ms using `exceljs`,
// 76% of it inside the library. Level 6 here is 2.14x faster than that total.
//
// KNOWN AND DELIBERATE BEHAVIOUR, none of it silent in the spec:
//   * NaN / Infinity / -Infinity have no OOXML numeric form and become TEXT cells.
//     Emitting <v>NaN</v> makes openpyxl refuse the whole workbook.
//   * XML 1.0 forbids most C0 control characters outright, so they are STRIPPED,
//     not escaped. A lone CR becomes LF. That is data loss and it is intentional.
//   * A date-shaped string JS can normalise is accepted as the normalised date
//     (2026-02-30 -> 2026-03-02). `sprints.mjs:isIsoDate` rejects those instead;
//     a shipped writer should reuse that predicate rather than this laxer test.
//   * The 1899-12-30 epoch is correct for dates on or after 1900-03-01 only. It
//     does NOT reproduce Excel's phantom 1900-02-29, and dates before 1900-03-01
//     round-trip inconsistently between openpyxl and LibreOffice. Out of scope.
//   * Excel's own ceilings (1,048,576 rows / 16,384 columns) are NOT enforced.
//     200,000 rows write fine here; a 16,385th column emits ref XFE1, one past
//     Excel's last valid column.
//
// Validated three ways, and the second and third each caught a defect the first
// missed (spec 4 §1.4):
//   1. `unzip -t`                       -> no errors
//   2. openpyxl 3.1.5, warnings-as-errors, read_only=True
//                                        -> 2,614 x 13; dates return as datetimes
//   3. LibreOffice Calc --convert-to csv -> exit 0, 2,614 rows, dates as dates
// The two defects: a missing <cellStyles> element (openpyxl warned), and a missing
// <dimension> element (openpyxl's STREAMING reader returned max_row=None — i.e. a
// 50k-row export was unreadable by the only reader anyone would use on one).
// Both shipped green under a naive "does it open" check.

import { deflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";

// --- CRC-32 (ZIP's checksum; not in node:zlib's public API) ------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// --- minimal ZIP writer (store-or-deflate, no ZIP64) --------------------------
function zip(files, level = 6) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const comp = deflateRawSync(raw, { level });
    const useDeflate = comp.length < raw.length;
    const body = useDeflate ? comp : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8); lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0x21, 12); // fixed DOS time/date
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(body.length, 18); lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// --- XML escaping + the six parts an xlsx needs ------------------------------
const xe = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;" }[c]))
  // XML 1.0 forbids these outright. U+FFFE/U+FFFF are non-characters: they survive
  // a naive strip, produce a sheet BOTH openpyxl modes refuse, and LibreOffice drops
  // the row while still exiting 0 — so its exit code alone is not a gate.
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "");
const colName = (n) => { let s = ""; n++; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; } return s; };
// Excel's serial date: days since 1899-12-30. This does NOT reproduce Excel's phantom
// 1900-02-29 — see the header; it is correct for dates from 1900-03-01 onward only.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
// Returns null for anything that is not a real date — a caller that gets null
// must fall back to a string cell rather than emitting <v>NaN</v>, which is the
// defect that made openpyxl refuse the whole workbook.
// Date.UTC maps years 0-99 into 1900-1999, so a year-50 date would emit 1950.
// setUTCFullYear does not. (Out of the epoch's correct range either way, but a
// silent 1900-year shift is not the failure anyone wants to debug.)
function localDayAsUtc(v) {
  if (Number.isNaN(v.getTime())) return NaN;
  const d = new Date(Date.UTC(2000, v.getMonth(), v.getDate()));
  d.setUTCFullYear(v.getFullYear());
  return d.getTime();
}
function serial(v) {
  // A Date is read by its LOCAL calendar day and then treated as UTC midnight.
  // Using getTime() instead loses a day everywhere east of UTC: in Australia/Melbourne
  // new Date(2026,7,11) is 2026-08-10T14:00Z, whose serial renders as 2026-08-10. The
  // date format hides the time, so the workbook simply showed the wrong day — on the
  // machine this module's own figures were measured on.
  const ms = v instanceof Date ? localDayAsUtc(v) : Date.parse(String(v) + "T00:00:00Z");
  if (!Number.isFinite(ms)) return null;
  return (ms - EXCEL_EPOCH) / 86400000;
}
// Excel forbids : \ / ? * [ ] in a sheet name and caps it at 31 chars.
const sheetName = (n) => (String(n ?? "Sheet1").replace(/[:\\/?*[\]]/g, "_").slice(0, 31)) || "Sheet1";

function sheetXml(rows) {
  // reduce(), never Math.max(...spread) — spreading 130k rows overflows the stack.
  const widest = rows.reduce((m, r) => (r.length > m ? r.length : m), 0);
  const lastRef = rows.length && widest ? colName(widest - 1) + rows.length : "A1";
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${lastRef}"/><sheetData>`];
  rows.forEach((row, ri) => {
    const cells = row.map((v, ci) => {
      const ref = colName(ci) + (ri + 1);
      if (v == null || v === "") return "";
      // NaN / Infinity have no OOXML numeric representation. Emitting them
      // produces <v>NaN</v>, which openpyxl refuses outright — so they become text.
      if (typeof v === "number") {
        return Number.isFinite(v)
          ? `<c r="${ref}"><v>${v}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t>${xe(String(v))}</t></is></c>`;
      }
      if (v instanceof Date || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const sv = serial(v);
        if (sv !== null) return `<c r="${ref}" s="1"><v>${sv}</v></c>`;
        // date-shaped but not a date (e.g. 9999-99-99) — keep it as text
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xe(String(v))}</t></is></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xe(v)}</t></is></c>`;
    }).join("");
    out.push(`<row r="${ri + 1}">${cells}</row>`);
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}

export function writeXlsx(rows, name = "Sheet1", { level = 6 } = {}) {
  const sn = sheetName(name);
  return zip([
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xe(sn)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: "xl/styles.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml(rows) },
  ], level);
}

// --- reproducing §1.3's table -------------------------------------------------
// `node <this file> --bench [projectsDir]` prints every figure §1.3 quotes.
// With a projects dir it uses the live corpus; the 50k row set is built by
// CYCLING those real rows, because synthetic repeated rows compress far better
// than real ticket titles and would flatter the result.
// Run-as-main only. An earlier version required the filename to be unchanged
// (renaming silently disabled the claim); the version after that guarded on the
// flag alone, so ANY importer invoked with --bench ran the harness and was killed
// by its process.exit(). This is the standard idiom and avoids both. Known limit:
// invoked through a SYMLINK it does not fire — argv[1] is the link, import.meta.url
// the realpath. Rename works; symlink does not.
const RUN_AS_MAIN = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (RUN_AS_MAIN && process.argv.includes("--bench")) {
  const dir = process.argv[process.argv.indexOf("--bench") + 1];
  const HEAD = ["id","project","type","status","priority","parent","assignee",
                "estimate","worklog_minutes","sprint","start","due","title"];
  let live = [HEAD];
  if (dir && !dir.startsWith("--")) {
    const { buildIndex } = await import(new URL("../../../../scripts/model/index.mjs", import.meta.url));
    for (const r of buildIndex(dir).rows) {
      live.push(HEAD.map((h) => (h === "estimate" || h === "worklog_minutes")
        ? (r[h] == null ? "" : Number(r[h])) : r[h]));
    }
  }
  const med = (fn, runs = 7) => {
    const t = [];
    let out;
    for (let i = 0; i < runs; i++) {
      const a = process.hrtime.bigint(); out = fn(); const b = process.hrtime.bigint();
      t.push(Number(b - a) / 1e6);
    }
    t.sort((x, y) => x - y);
    return { ms: t[Math.floor(runs / 2)], lo: t[0], hi: t[runs - 1], bytes: out.length };
  };
  const show = (label, r) =>
    console.log(`${label.padEnd(34)} ${r.ms.toFixed(0).padStart(5)} ms  (${r.lo.toFixed(0)}-${r.hi.toFixed(0)})  ${(r.bytes / 1024).toFixed(1).padStart(8)} KB`);
  if (live.length > 1) {
    for (const level of [6, 9]) show(`live ${live.length - 1} rows, level ${level}`, med(() => writeXlsx(live, "tickets", { level })));
  }
  if (live.length <= 1) {
    console.error("Refusing to print a table without a projects dir. Run:");
    console.error("  node <this file> --bench /path/to/board/projects");
    console.error("Synthetic rows compress far better than real ticket titles and would");
    console.error("reproduce the flattered figures this module's header disowns.");
    process.exitCode = 2;
    process.exit();
  }
  const body = live.slice(1);
  const big = [HEAD];
  for (let i = 0; i < 50000; i++) big.push(body[i % body.length]);
  for (const level of [6, 9]) show(`50,000 real-shaped rows, level ${level}`, med(() => writeXlsx(big, "tickets", { level })));
  for (const n of [10000, 20000, 30000]) {
    const r = [HEAD]; for (let i = 0; i < n; i++) r.push(body[i % body.length]);
    show(`${n} real-shaped rows, level 6`, med(() => writeXlsx(r, "tickets", { level: 6 })));
  }
}
