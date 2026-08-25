// scripts/model/setup-token.mjs — BLZ-358. The one-time credential that gates
// first-run setup.
//
// THE OPERATOR CHOSE THIS MECHANISM ON 2026-08-23, over two alternatives:
//
//   loopback-only setup — the strongest guarantee, and unusable for the case that
//     motivates the ticket: a remote container, where reaching loopback needs
//     `docker exec` or a tunnel. If the operator can already exec into the box they
//     can run `blaze user add` and never see the setup flow at all.
//   a token printed to the container log — what Jira does, and the lowest friction.
//     Rejected because `docker logs` is shipped off-box by any log aggregator, so the
//     credential ends up somewhere nobody chose to put it.
//
// A file under the board reaches only someone with filesystem access — the same
// privilege that could edit identity.db directly — and, decisively, it never enters a
// log stream or a transcript.
//
// WHAT IT DOES NOT PROTECT AGAINST, stated plainly because a security control that
// oversells itself is worse than none:
//
//   * Anyone who can read <board>/.blaze/setup-token can complete setup and become
//     admin. On a correctly-permissioned box that is root and the board's owner. It is
//     0600 in a 0700 directory, but a container running as root, a world-readable bind
//     mount, or a backup that widens modes all defeat it.
//   * It is not transport security. The token crosses the network in the POST body, so
//     on a plain-HTTP LAN bind it is observable in transit. Blaze does not terminate
//     TLS; putting the setup flow behind a proxy that does is the operator's job.
//   * It does not stop a race for an UNCONFIGURED board. Whoever presents the token
//     first becomes the admin. The window is from first start to completed setup, and
//     the mitigation is to complete setup, not to widen this control.
//
// The VALUE is never logged, echoed, or rendered. The PATH is — that is the thing the
// operator needs, and it discloses nothing.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Distinct from an API token's `blz_` on purpose: the two are not interchangeable, and
 *  a leaked one should be identifiable on sight. Still `blz_`-prefixed so the same
 *  secret-scanning rules catch it. */
export const SETUP_TOKEN_PREFIX = "blz_setup_";

export function setupTokenPath(dataRoot) {
  return join(dataRoot, ".blaze", "setup-token");
}

/** Mint a fresh token and write it. Always overwrites: an abandoned setup must not
 *  leave a live credential that a later start silently re-serves. Returns the PATH and
 *  the value; the caller logs the path and nothing else. */
export function issueSetupToken(dataRoot) {
  const path = setupTokenPath(dataRoot);
  const token = SETUP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  mkdirSync(join(dataRoot, ".blaze"), { recursive: true, mode: 0o700 });
  // mkdirSync's mode is a no-op when the directory already exists, and .blaze/ is
  // created by several other paths — so tighten it explicitly, best-effort, the same
  // way identity-db.mjs hardens its own.
  try { chmodSync(join(dataRoot, ".blaze"), 0o700); } catch { /* not ours to tighten */ }
  // mode: on the write, so the file is never briefly world-readable between create and
  // chmod. chmodSync after it as well, because an existing file keeps its old mode.
  writeFileSync(path, token, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* not ours to tighten */ }
  return { path, token };
}

export function readSetupToken(dataRoot) {
  try {
    const v = readFileSync(setupTokenPath(dataRoot), "utf8").trim();
    return v || null;
  } catch { return null; }
}

/** Idempotent: setup completing twice, or a token already cleared by hand, is not an
 *  error worth failing a request over. */
export function clearSetupToken(dataRoot) {
  try { rmSync(setupTokenPath(dataRoot), { force: true }); } catch { /* already gone */ }
}

/** Constant-time. An absent token on either side is never a match — "no token
 *  presented" and "no token on disk" must not authenticate each other. */
export function setupTokenMatches(presented, stored) {
  const a = Buffer.from(String(presented ?? ""), "utf8");
  const b = Buffer.from(String(stored ?? ""), "utf8");
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export { existsSync as _existsSync };
