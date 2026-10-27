// scripts/model/ticket-json.mjs — a ticket record as the remote read routes answer it (BLZ-709).
//
// A record from any read storage carries `file`, the ticket's path on the SERVER, and the fs
// walk adds more keys besides. None of that is the board's content, and a server path is not
// the caller's business, so the answer is built from an allowlist rather than by deleting what
// is known to be private: a key a storage adds later is dropped by default, never leaked.

/**
 * @param rec  a ticket record ({ frontmatter, status, project?, body?, file?, ... })
 * @param opts.body  include the markdown body (the list route leaves it out)
 * @returns { id, project, status, frontmatter, body? }
 */
export function ticketJson(rec, { body = true } = {}) {
  const out = {
    id: rec?.frontmatter?.id ?? null,
    project: rec?.project ?? rec?.frontmatter?.project ?? null,
    status: rec?.status ?? null,
    frontmatter: { ...rec?.frontmatter },
  };
  if (body) out.body = rec?.body ?? "";
  return out;
}
