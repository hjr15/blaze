// scripts/model/passwords.mjs — BLZ-566. The local password verifier, per ADR-0034.
//
// ADR-0013 §2 said it in the schema's own comment — "One user, many ways to sign in: a
// local password today, a Google or Okta subject tomorrow" — and then no column ever held
// one. `user_identity` has carried a `local` row for every user since BLZ-303 with nothing
// to verify against, which is why a board with users could be reached by `curl` and by
// nothing a human uses.
//
// PURE, and deliberately so. The same split identity.mjs made: the judgement is testable
// without a database, and the I/O half (identity-store.mjs) only stores the string this
// produces.
//
// WHAT IS STORED IS A VERIFIER, NEVER A PASSWORD.
//
//     scrypt$<N>$<r>$<p>$<salt base64url>$<derived key base64url>
//
// Self-describing on purpose: the parameters travel with the hash, so raising the cost
// later re-verifies every existing password without a migration and without a flag day.
// The same reason ADR-0013 §4 gives for hashing API tokens applies here and more sharply —
// a password is reused across services in a way a `blz_` token never is, so a database
// dump must not yield one.
//
// scrypt, not PBKDF2 and not a dependency: it is memory-hard, it is in node:crypto, and
// ADR-0016 keeps this engine on the standard library. N=16384/r=8 costs 16MB per
// derivation, inside node's 32MB scrypt default.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** Cost parameters for a NEW verifier. An existing one is verified with its own. */
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const KEY_LENGTH = 32;
export const SALT_LENGTH = 16;

/** A floor, not a character-class ritual. Length is the only rule that survives contact
 *  with a passphrase manager, and NIST stopped recommending composition rules in 2017. */
export const MIN_PASSWORD_LENGTH = 12;

/** An upper bound so an unauthenticated caller cannot hand the KDF an unbounded string.
 *  scrypt's cost does not scale with input length, but the copy and the request body do. */
export const MAX_PASSWORD_LENGTH = 4096;

const derive = (password, salt, N, r, p, len) => new Promise((resolve, reject) => {
  // maxmem is set explicitly rather than left to the default: 128 * N * r is 16MB at the
  // parameters above, and the default 32MB is close enough that a later N bump would fail
  // with an opaque error instead of a decision.
  scrypt(password, salt, len, { N, r, p, maxmem: 256 * N * r },
    (err, key) => (err ? reject(err) : resolve(key)));
});

/**
 * Is this string allowed to become a password at all?
 *
 * A NON-STRING IS NOT A SHORT PASSWORD. This is reached from the pre-auth `/setup` body
 * and from `blaze user passwd`, and `String(x)` on an object with a poisoned `toString`
 * throws — the exact failure setup-token.mjs already learned the hard way.
 */
export function checkPasswordPolicy(password) {
  if (typeof password !== "string") {
    return { ok: false, error: "a password must be a string" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `a password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `a password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return { ok: true, error: null };
}

/** Derive a fresh verifier. The salt is per-password, so two users who chose the same
 *  password have nothing in common on disk. */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P,
          salt.toString("base64url"), key.toString("base64url")].join("$");
}

/**
 * A verifier that belongs to nobody, derived once at module load.
 *
 * ITS ONLY JOB IS TO COST WHAT A REAL ONE COSTS. `signin` answers an unknown email and a
 * wrong password with the same 401 body — which buys nothing if one of them returns in a
 * microsecond and the other in a hundred milliseconds, because the enumeration the
 * identical body exists to prevent is then done with a stopwatch instead.
 */
const DECOY = ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P,
               randomBytes(SALT_LENGTH).toString("base64url"),
               randomBytes(KEY_LENGTH).toString("base64url")].join("$");

/**
 * Verify a password against a stored verifier.
 *
 * @param verifier  the stored string, or NULL when the account has no password — or does
 *                  not exist. Both are answered by deriving against the decoy.
 * @returns { ok, derived } — `derived` says whether a KDF derivation actually ran, and it
 *   is the only way a test can prove the timing-equalisation above is still in place. A
 *   guard whose absence is invisible is a guard that gets deleted.
 */
export async function verifyAgainst(verifier, password) {
  const raw = typeof verifier === "string" && verifier ? verifier : DECOY;
  const parts = raw.split("$");
  // A verifier that cannot be parsed is not a reason to skip the work: this is reached
  // with attacker-influenced state (a truncated row, a hand-edited database), and
  // returning early would hand back exactly the timing signal the decoy exists to hide.
  const usable = parts.length === 6 && parts[0] === "scrypt"
    && [1, 2, 3].every((i) => /^[1-9][0-9]*$/.test(parts[i]));
  const [, N, r, p, salt, key] = usable ? parts : DECOY.split("$");
  let derived = false;
  try {
    const got = await derive(typeof password === "string" ? password : "",
      Buffer.from(salt, "base64url"), Number(N), Number(r), Number(p),
      Buffer.from(key, "base64url").length || KEY_LENGTH);
    derived = true;
    if (!usable) return { ok: false, derived };
    const want = Buffer.from(key, "base64url");
    // Length first: timingSafeEqual THROWS on a mismatch, so this is a guard, not an
    // optimisation — the same rule setup-token.mjs states.
    if (got.length !== want.length) return { ok: false, derived };
    return { ok: timingSafeEqual(got, want), derived };
  } catch {
    // A KDF that refused (a hostile N, a memory limit) is a failed verification, never a
    // thrown exception on the pre-auth surface.
    return { ok: false, derived };
  }
}
