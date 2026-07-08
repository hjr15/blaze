// scripts/model/boards.mjs — pure workflow→board grouping. No filesystem.
//
// The PRIMARY board is the workflow governing the most types (tie-break: more
// statuses, then name). A non-primary workflow FOLDS into the primary iff every
// one of its non-terminal statuses is already a non-terminal status of the
// primary; otherwise it becomes its own standalone board. Every board's columns
// = the ordered union of its members' non-terminal statuses, plus ONE terminal
// column that folds ALL terminal statuses, labelled by the board workflow's
// first terminal.

const title = (s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function nonTerminals(wf) {
  return wf.statuses.filter((s) => !wf.terminal.includes(s));
}

function makeBoard(name, memberNames, workflows) {
  const seen = new Set();
  const nonTermCols = [];
  for (const m of memberNames) {
    for (const s of nonTerminals(workflows[m])) {
      if (!seen.has(s)) { seen.add(s); nonTermCols.push(s); }
    }
  }
  const allTerminals = [];
  for (const m of memberNames) {
    for (const s of workflows[m].terminal) if (!allTerminals.includes(s)) allTerminals.push(s);
  }
  const columns = nonTermCols.map((s) => ({ key: s, label: title(s), folds: [s] }));
  if (allTerminals.length) {
    const termKey = workflows[name].terminal[0] ?? allTerminals[0];
    columns.push({ key: termKey, label: title(termKey), folds: allTerminals });
  }
  return { name, label: title(name), workflows: memberNames, columns };
}

export function deriveBoards({ types = {}, workflows = {} } = {}) {
  const used = [...new Set(Object.values(types).map((t) => t.workflow))].filter((n) => workflows[n]);
  if (!used.length) return [];
  const typeCount = {};
  for (const t of Object.values(types)) typeCount[t.workflow] = (typeCount[t.workflow] || 0) + 1;

  const primary = [...used].sort((a, b) =>
    (typeCount[b] - typeCount[a]) ||
    (workflows[b].statuses.length - workflows[a].statuses.length) ||
    a.localeCompare(b))[0];

  const primaryNonTerm = new Set(nonTerminals(workflows[primary]));
  const folded = used.filter((n) => n !== primary && nonTerminals(workflows[n]).every((s) => primaryNonTerm.has(s)));
  const standalone = used.filter((n) => n !== primary && !folded.includes(n));

  const boards = [makeBoard(primary, [primary, ...folded], workflows)];
  for (const n of standalone) boards.push(makeBoard(n, [n], workflows));
  return boards;
}

export function columnForStatus(board, status) {
  return board.columns.find((c) => c.folds.includes(status)) || null;
}
