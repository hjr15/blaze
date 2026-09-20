// scripts/model/csv.mjs — RFC 4180 reader and canonical writer. Format layer
// ONLY: no board semantics, no schema awareness, no writes to the board.
// Pure, zero-dependency. BLZ-625, implementing design §2.1
// (docs/design/csv-import-and-export.md) and §2.5's quoting rules.
//
// Rows are arrays of strings. There is no per-row arity check here — "every
// row has exactly 31 cells" is a canonical-schema rule (csv-schema.mjs,
// BLZ-626), not a property of CSV in general.
//
// An empty cell parses to "" and writes from "" — never undefined, never
// null. Absence-as-empty-string is the schema layer's decision (design §2.6);
// this layer just never coerces one shape into another.

/**
 * A cell is quoted iff it contains a comma, a double quote, a line feed or a
 * carriage return. Nothing else is quoted — design §2.1's table. `=`/`@`
 * spreadsheet-formula hazards are NOT this layer's concern (design §2.5); the
 * exporter that calls this module decides what to warn about, and does so
 * without asking this function to mutate anything.
 */
function needsQuoting(cell) {
  return /[,"\n\r]/.test(cell);
}

function quoteCell(cell) {
  return `"${cell.replace(/"/g, '""')}"`;
}

/** rows: string[][] -> canonical RFC 4180 text. LF line endings, minimal quoting. */
export function writeCsv(rows) {
  if (rows.length === 0) return "";
  return rows.map((row) =>
    row.map((cell) => (needsQuoting(cell) ? quoteCell(cell) : cell)).join(","),
  ).join("\n") + "\n";
}

/**
 * text -> string[][]. Handles both `\n` and `\r\n` record separators outside
 * quoted cells (design §2.1: "A file containing `\r\n` outside a quoted cell
 * is read"); inside a quoted cell, `\r` and `\n` are ordinary data and are
 * preserved verbatim. A trailing record separator at end of file produces no
 * phantom empty row; an interior blank line produces a one-cell row whose
 * only cell is the empty string, matching ordinary CSV reader behaviour.
 */
export function parseCsv(text) {
  if (text === "") return [];
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function endCell() {
    row.push(cell);
    cell = "";
  }
  function endRow() {
    endCell();
    rows.push(row);
    row = [];
  }

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endCell();
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      endRow();
      i += 2;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    cell += ch;
    i++;
  }

  if (inQuotes) {
    throw new Error(
      `csv: unterminated quoted field — a '"' was opened and never closed before end of input`);
  }
  // A trailing record separator already closed the last row via endRow(); only
  // flush a final partial row when there is genuinely one more cell pending.
  if (cell !== "" || row.length > 0) {
    endRow();
  }
  return rows;
}
