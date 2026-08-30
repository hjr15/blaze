// tests/identity-schema-upgrade.test.mjs — BLZ-566. The board that already has users.
//
// identity.db has no migration runner and ADR-0006's write seams do not reach it: the
// DDL is applied by `openIdentityDb(create: true)` and nowhere else, which is why every
// table in it is `CREATE TABLE IF NOT EXISTS`. That was enough while the schema never
// grew. A board set up before this change has `app_user`, `membership`, `user_identity`
// and `api_token` and no sign-in tables at all — and it is EXACTLY the board this ticket
// exists for, because it is the one whose operator is locked out.
//
// So the read path applies the additive DDL too, once, on the healthy branch. The two
// things that must not follow from that are both asserted here: a damaged roster must
// still be diagnosed as damaged rather than rebuilt into an empty one, and a read-only
// mount must still serve.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIdentityDb, loadIdentity, identityDbPath } from "../scripts/model/identity-db.mjs";

const roots = [];
function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-identity-upgrade-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const r of roots) {
    try { chmodSync(join(r, ".blaze"), 0o700); } catch { /* already writable */ }
    rmSync(r, { recursive: true, force: true });
  }
});

/** A roster exactly as BLZ-348 left it: users and tokens, no sign-in tables. */
async function legacyBoard() {
  const root = board();
  const opened = openIdentityDb(root, { create: true });
  await opened.store.createUser({ email: "op@example.com", role: "admin" });
  opened.db.exec("DROP TABLE user_session;");
  opened.db.exec("DROP TABLE local_password;");
  assert.throws(() => opened.exec.all("SELECT 1 FROM user_session", []), /no such table/,
    "the fixture must genuinely be a pre-BLZ-566 roster");
  opened.db.close();
  return root;
}

describe("a board that already has users gains the sign-in tables without losing a row", () => {
  test("loadIdentity adds the missing tables to an existing roster", async () => {
    const root = await legacyBoard();
    const id = loadIdentity(root);
    assert.equal(id.state, "healthy");
    try {
      // The proof is that the store can now do the thing the missing tables blocked.
      await id.store.setPassword({ email: "op@example.com", password: "correct horse battery" });
      const r = await id.store.signIn({ email: "op@example.com", password: "correct horse battery" });
      assert.equal(r.ok, true, "the operator of an existing board can sign in after a restart");
    } finally { id.close(); }
  });

  test("the existing users survive it", async () => {
    const root = await legacyBoard();
    const id = loadIdentity(root);
    try {
      assert.deepEqual((await id.store.listUsers()).map((u) => u.email), ["op@example.com"]);
    } finally { id.close(); }
  });

  test("a DAMAGED roster is still diagnosed as damaged, never rebuilt into an empty one",
    async () => {
      const root = await legacyBoard();
      // Truncation is the single most common way this file is destroyed. Applying DDL
      // before knowing the roster reads would turn it into a working, EMPTY database —
      // which identity-db.mjs already says would leave the widest hole of all of them.
      writeFileSync(identityDbPath(root), "");
      assert.equal(loadIdentity(root).state, "broken");
    });

  test("a roster that cannot be upgraded still authenticates what it already could",
    async () => {
      const root = await legacyBoard();
      // A read-only .blaze/ cannot take the new tables. That must cost sign-in and
      // nothing else: the board still comes up, and bearer tokens still work.
      chmodSync(join(root, ".blaze"), 0o500);
      const id = loadIdentity(root);
      try {
        assert.equal(id.state, "healthy", "the board must still serve");
        const r = await id.store.authenticate({ presented: "blz_nope", operation: "read" });
        assert.equal(r.status, 401, "…and the bearer path is untouched");
      } finally {
        id.close();
        chmodSync(join(root, ".blaze"), 0o700);
      }
    });
});
