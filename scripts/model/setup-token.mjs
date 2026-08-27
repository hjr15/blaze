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
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  // TYPE-CHECKED BEFORE ANYTHING ELSE, and an adversarial review is why. This used to
  // call `String(presented ?? "")`, and JSON can carry an object whose stringification
  // THROWS — `{"token":{"toString":null}}` raises "Cannot convert object to primitive
  // value". The setup branch is reached before any credential is checked and was the one
  // place in the request handler without a try, so a single unauthenticated request took
  // the whole board down for every connected session. A token is a string; anything else
  // is not a wrong token, it is not a token.
  if (typeof presented !== "string" || typeof stored !== "string") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(stored, "utf8");
  if (a.length === 0 || b.length === 0) return false;
  // Length first: `timingSafeEqual` THROWS on a length mismatch, so this is a guard, not
  // an optimisation. A prefix and a superstring are both rejected here.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Make sure the token file is git-ignored, asking git about the TOKEN rather than
 *  assuming a rule written for something else covers it.
 *
 *  `ensureIdentityIgnored` asks whether `.blaze/identity.db` is ignored, and a board
 *  whose `.gitignore` says exactly that path answers yes — so `.blaze/` was never added
 *  and `.blaze/setup-token`, a LIVE credential, was left committable by `git add -A`.
 *  "The rule that hides one hides the other" was an assumption, and it was wrong. */
export function ensureSetupTokenIgnored(dataRoot) {
  const rel = ".blaze/setup-token";
  const git = (...args) => spawnSync("git", ["-C", dataRoot, ...args], { encoding: "utf8" });
  const inside = git("rev-parse", "--is-inside-work-tree");
  if (inside.error) return { state: "unavailable", path: rel };
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return { state: "not-a-repo", path: rel };

  // APPEND, THEN RE-ASK. `docs/architecture.md` says the server ENSURES the path is
  // ignored; the first cut appended a rule and reported `added` without checking the rule
  // took. A deeper `.gitignore` outranks the root one, so on a board whose
  // `.blaze/.gitignore` contains `!setup-token` three consecutive boots gave rules=2, 3, 4
  // with the token committable throughout: the state said `added`, the claim was false,
  // and a duplicate line accreted every boot.
  //
  // The re-ask is the whole fix. "I wrote a rule" and "the path is ignored" are different
  // statements, and only the second is worth reporting.
  const isIgnored = () => git("check-ignore", "--no-index", "-q", rel).status === 0;
  let state;
  if (isIgnored()) {
    state = "already";
  } else {
    // RAW BYTES, NOT A utf8 STRING. This file belongs to the operator and a decode/encode
    // round-trip is not byte-preserving: any sequence that is not valid UTF-8 — a latin-1
    // filename in a rule, say — comes back as U+FFFD, silently rewriting a rule they wrote
    // and taking whatever it covered from ignored to committable. In the one function whose
    // entire job is to stop a file being committable. Buffers in, buffers out, no decode.
    //
    // `lstatSync`, not `existsSync`: the latter FOLLOWS a symlink, so a dangling
    // `.gitignore` symlink read as "absent" had `appendFileSync` create the link's target
    // and the undo then delete the LINK, leaving an orphan file behind.
    const gitignore = join(dataRoot, ".gitignore");
    // `blocked` SKIPS THE APPEND — IT DOES NOT LEAVE THE FUNCTION. Review found the
    // difference the hard way: the first cut `return`ed from here, which jumped over the
    // `git rm --cached` untrack step below that base and every earlier cut always reached,
    // and hardcoded `wasTracked: false`. On a board whose token was ALREADY TRACKED, the
    // live credential stayed staged for the next commit and `serve.mjs` — which gates BOTH
    // of its operator warnings on `wasTracked` — said nothing at all. Skipping the part
    // that cannot work must not skip the part that still can.
    let blocked = null;
    let before = null;              // Buffer when a regular file is there, else null
    // lstat and read are SEPARATE questions. Wrapping both in one bare catch conflated
    // "absent" with "present but unreadable", and an unreadable file left `before` null,
    // so the undo took the `rmSync` branch and DELETED the operator's .gitignore — every
    // rule in it, not just the one blaze added.
    let st = null;
    try { st = lstatSync(gitignore); } catch { /* genuinely absent */ }
    if (st?.isSymbolicLink()) {
      // Writing through an operator's symlink, and undoing it, is not something a
      // boot-time hygiene check should attempt — and git does not read a symlinked
      // .gitignore anyway, so appending through it could never have helped.
      blocked = "symlink";
      console.error("blaze: WARNING — this board's root .gitignore is a symlink, so blaze "
        + `did not modify it. git does not read a symlinked .gitignore, so ${rel} is NOT ignored; `
        + "add the rule to a real .gitignore by hand. (The token's VALUE is not shown here "
        + "or in any log.)");
    } else if (st?.isFile()) {
      try { before = readFileSync(gitignore); } catch (e) {
        blocked = "unreadable";
        console.error(`blaze: WARNING — blaze could not read .gitignore `
          + `(${e && e.code ? e.code : "read failed"}), so it did not modify it. ${rel} is `
          + "NOT ignored; add the rule by hand. (The token's VALUE is not shown here or in "
          + "any log.)");
      }
    }
    const existedBefore = before !== null;
    const existing = before ?? Buffer.alloc(0);
    // APPEND UNCONDITIONALLY, THEN RE-ASK, THEN UNDO IF IT DID NOT HELP.
    //
    // The first cut skipped the append whenever a rule for the path was already in the
    // file, reasoning that a second copy of a losing rule cannot help. That is true only
    // when the rule loses to a DEEPER .gitignore. Git resolves within one file by
    // LAST MATCHING RULE, so when the rule loses to a later line in the SAME file —
    // `!.blaze/setup-token`, or a broad `!.blaze/*` re-include written for some other
    // file — appending at the end IS the fix, and the pre-fix code did exactly that.
    // Review measured four such board shapes where the live token was ignored before this
    // change and committable after it: a regression, in the one direction this function
    // exists to protect.
    //
    // So: append, ask git, and if the answer is still no, put the file back exactly as it
    // was. The boards where appending works are fixed; the boards where it cannot work
    // accrete nothing, which is the whole of BLZ-397. The re-ask is what makes both
    // possible at once — "I wrote a rule" and "the path is ignored" are different
    // statements and only the second decides what to do next.
    // Newline probe on BYTES: 0x0a, not `String.endsWith`.
    if (blocked) {
      // Diagnosed above. No rule can be added here, but control MUST still reach the
      // untrack step below: the token may already be tracked, and un-staging a live
      // credential is worth doing even when no rule can be written.
      state = blocked;
    } else {
      // Newline probe on BYTES: 0x0a, not `String.endsWith`.
      const needsNl = existing.length > 0 && existing.at(-1) !== 0x0a;
      try {
        appendFileSync(gitignore,
          `${needsNl ? "\n" : ""}\n# Blaze first-run setup token — a live credential. Never commit it.\n${rel}\n`);
      } catch (e) {
        // A write refusal must not throw out of a boot-time hygiene check — `serve.mjs`
        // catches it bare, and the operator would lose the one warning that says a live
        // credential is still committable.
        state = "unwritable";
        // A write can fail PART WAY — ENOSPC mid-append — leaving the operator's file half
        // extended. The same restore the ineffective branch uses puts it back; there is
        // nothing to keep, since the append by definition did not complete.
        try {
          if (existedBefore) writeFileSync(gitignore, existing);
          else rmSync(gitignore, { force: true });
        } catch { /* the restore itself failed; the warning below is all that is left */ }
        console.error(`blaze: WARNING — ${rel} is not ignored by git and blaze could not add `
          + `a rule for it (${e && e.code ? e.code : "write failed"}). This live credential `
          + "stays committable. Add the rule by hand, then restart. (The token's VALUE is "
          + "not shown here or in any log.)");
      }
      if (state) { /* the append failed and said so */ }
      else if (isIgnored()) {
        state = "added";
      } else {
        // Undo, so a board that cannot be fixed this way does not grow a line every boot.
        if (existedBefore) writeFileSync(gitignore, existing);
        else rmSync(gitignore, { force: true });
        state = "ineffective";
        console.error(`blaze: WARNING — ${rel} is still not ignored by git, and adding a rule `
          + "for it did not change that: a deeper .gitignore is overriding the root one. This "
          + "live credential stays committable. Fix the negating rule, then restart. (The "
          + "token's VALUE is not shown here or in any log.)");
      }
    }
  }

  // `--no-index` above answers a PATTERN question — does a rule match this path — never
  // an INDEX question. A path `git add`ed before the rule existed (by the pre-fix code
  // this ticket replaces, or by hand) matches the rule just fine and stays exactly as
  // tracked and exactly as committable as it always was. Ask git directly whether the
  // path is tracked, and if so untrack it — `rm --cached` removes it from the INDEX only,
  // so the file on disk (the live token this process just wrote) is untouched, and it
  // stops being staged by the next `git add -A` an operator runs.
  //
  // This cannot un-leak a value already sitting in a PRIOR commit — that needs history
  // rewriting, which is out of scope for a boot-time check — so a token that was ever
  // committed must still be treated as compromised and rotated. What this closes is the
  // path staying committable going forward.
  const tracked = git("ls-files", "--error-unmatch", rel).status === 0;
  if (!tracked) return { state, path: rel, wasTracked: false, untrackOk: null, untrackError: null };
  // `-f`, AND AN ADVERSARIAL REVIEW IS WHY. `git rm --cached` REFUSES with exit 1 when the
  // index entry differs from BOTH the working file and HEAD —
  //
  //   error: the following file has staged content different from both the file and the HEAD
  //
  // — and that is precisely the board this whole function exists for. An operator running
  // the pre-fix code did the `git add -A` the comment above names, staging token T1
  // without committing it; blaze restarted, `issueSetupToken` overwrote the file with T2
  // because it ALWAYS overwrites, and now index, working file and HEAD all differ. The
  // removal was refused, the return value said `-untracked` anyway, and the operator's
  // next `git add -A && git commit` committed the live token.
  //
  // `-f` forces the INDEX removal only. `--cached` still means the file on disk — the
  // live token this process just wrote — is never touched.
  const rm = git("rm", "--cached", "-f", "-q", "--", rel);
  const untrackOk = rm.status === 0;
  // THE STATE SAYS WHAT HAPPENED, not what was attempted. It used to read `-untracked`
  // unconditionally, including on every board where the removal failed. And git's own
  // stderr is RETURNED rather than discarded: it names why (a held `.git/index.lock`, a
  // read-only `.git`), it names paths only, and the caller has nowhere else to learn it.
  return {
    state: untrackOk ? `${state}-untracked` : `${state}-untrack-failed`,
    path: rel,
    wasTracked: true,
    untrackOk,
    // The FIRST line of git's stderr: that is the fatal message itself. The rest is
    // git's own multi-paragraph advice, which belongs in a terminal and not in a boot log.
    untrackError: untrackOk ? null
      : ((rm.stderr || "").trim().split("\n")[0].trim() || `git rm exited ${rm.status}`),
  };
}

export { existsSync as _existsSync };
