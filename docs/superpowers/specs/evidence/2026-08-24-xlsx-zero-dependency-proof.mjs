// docs/superpowers/specs/evidence/2026-08-24-xlsx-zero-dependency-proof.mjs
//
// EVIDENCE for spec 4 (BLZ-365) §1.3. This is NOT production code and nothing
// imports it — the shipped writer is specified to live at `scripts/model/xlsx.mjs`.
// It is committed so §1.3's claim is reproducible rather than asserted.
//
// The claim: Blaze can write a valid .xlsx with ZERO dependencies. An .xlsx is a
// ZIP of XML; `node:zlib` supplies DEFLATE, and the ZIP container, CRC-32 and the
// six OOXML parts are hand-written. Nothing else is imported.
//
// Measured 2026-08-24 (Node v24.19.0), medians not single runs:
//   live board, 2,613 rows x 13 cols, level 6 ->  220.4 KB in   55 ms
//   live board, same rows,            level 9 ->  215.1 KB in   97 ms
//   50,000 rows x 13 cols,            level 6 ->  2.36 MB in  775 ms
//   50,000 rows x 13 cols,            level 9 ->  2.16 MB in 1876 ms
// ADR-0016 benchmarked the same 50k-row workload at 2,026.2 ms using `exceljs`,
// 76% of it inside the library. Level 6 here is 2.61x faster than that total.
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
function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const comp = deflateRawSync(raw, { level: 6 });
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
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");                    // XML 1.0 forbids these outright
const colName = (n) => { let s = ""; n++; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; } return s; };
// Excel's serial date: days since 1899-12-30 (its 1900 leap-year bug included).
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const serial = (iso) => (Date.parse(iso + "T00:00:00Z") - EXCEL_EPOCH) / 86400000;

function sheetXml(rows) {
  const lastRef = rows.length ? colName(Math.max(...rows.map(r => r.length)) - 1) + rows.length : "A1";
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${lastRef}"/><sheetData>`];
  rows.forEach((row, ri) => {
    const cells = row.map((v, ci) => {
      const ref = colName(ci) + (ri + 1);
      if (v == null || v === "") return "";
      if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
      if (v instanceof Date || /^\d{4}-\d{2}-\d{2}$/.test(v)) return `<c r="${ref}" s="1"><v>${serial(v)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xe(v)}</t></is></c>`;
    }).join("");
    out.push(`<row r="${ri + 1}">${cells}</row>`);
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}

export function writeXlsx(rows, sheetName = "Sheet1") {
  return zip([
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xe(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: "xl/styles.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml(rows) },
  ]);
}
