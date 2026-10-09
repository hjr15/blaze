// scripts/model/transitions-db.mjs — where the metrics view's status-move history comes from
// under BLAZE_WRITE_PORT=db (BLZ-680, spec §5.7).
//
// In fs and dual mode the history is git's rename log (transitions.mjs), and once moves stop
// touching files — db mode — that log stops growing. The database records every move as a
// `transition` ticket_event, exposed by the `ticket_transition` view, and `blaze db load`
// imports the git-era history into it once. So under db the history is read from there.
//
// `undefined` means "not mine to answer": the page then derives it from git, lazily, exactly as
// before — fs and dual are untouched, and no view but metrics pays for the query.

/** @returns the `{ id, from, to, ts }` list under db for the metrics view, else `undefined`. */
export async function dbTransitions(readStorage, mode, view, root) {
  if (mode !== "db" || view !== "metrics") return undefined;
  return readStorage.listTransitions(root);
}
