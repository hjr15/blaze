// scripts/model/rate-limit.mjs — BLZ-571. `POST /signin` costs an attacker something.
//
// WHY THIS EXISTS. ADR-0034 recorded the gap in as many words: scrypt's ~50–100 ms was
// the ONLY friction slowing a credential-stuffing run against the single operator
// account. Nothing counted attempts, so the attacker's rate was bounded by the board's
// CPU and by nothing else.
//
// WHY IN THE APPLICATION AND NOT AT THE EDGE. Decided by the operator and recorded in
// docs/superpowers/plans/2026-08-31-blaze-app-adoption-and-import-standard.md §5 and in
// docs/decisions/0036-signin-is-rate-limited-by-the-board-per-source-not-by-the-edge.md:
// the limit has to hold however the board is fronted — behind Traefik, behind
// nothing, on a laptop — and it has to be exercisable by the test suite. An edge limit may
// be added later as defence in depth; this file may never assume one is there.
//
// THREE THINGS THIS FILE IS ACCOUNTABLE FOR, because each of them is a way a rate limiter
// becomes the vulnerability:
//
//   1. WHOSE ADDRESS. Keying on a value the caller can set is worse than not limiting at
//      all: the attacker rotates it to escape their own bucket and sets it to the
//      operator's address to fill theirs. `clientAddressFor` therefore trusts
//      `X-Forwarded-For` ONLY when the peer is a configured trusted proxy, and reads the
//      LAST element of the chain — the same reasoning, deliberately, that
//      `isSecureRequest` in signin.mjs already settled for `x-forwarded-proto`. Absent or
//      unusable configuration falls back to the peer address. There is no path through
//      this function on which an unverified header wins.
//   2. BOUNDED MEMORY. A map keyed on anything an attacker can vary is a memory-
//      exhaustion vector wearing a defence's clothes. `AttemptLimiter` caps its map and
//      evicts the LEAST RECENTLY FAILED entry.
//
//      THE CLAIM, STATED NARROWLY, because the broad version is false: eviction can never
//      IMPOSE a penalty on a source that has not itself failed, so no amount of flooding
//      by other addresses can throttle the operator. It emphatically CAN discard one — an
//      attacker who holds `maxSources` addresses and keeps them all failing will evict
//      their own oldest bucket and buy back its allowance. That is a deliberate trade
//      (bounded memory over perfect memory) and not a property this file claims to have.
//      It is also poor value for the attacker: they spend 1024 live sources to recover the
//      allowance of one.
//   3. BACKOFF, NOT LOCKOUT. A lockout that needs a human to clear it is a denial of
//      service the attacker triggers and the operator suffers — and the operator is the
//      person who would have to clear it, from the board they can no longer reach. So the
//      penalty is a delay that grows, is capped, decays on its own, and is cleared by a
//      correct password FOR THE ACCOUNT THAT WAS BEING GUESSED.
//   4. THE REFUND IS PER ACCOUNT, NOT PER SOURCE. An earlier draft of this file said
//      "there is ONE account on this board" and cleared the whole source's bucket on any
//      successful sign-in. Both halves were wrong. `blaze user add --email --role` has
//      shipped since BLZ-360, `viewer` is a real role with read-only scopes, and a viewer
//      credential was enough to brute-force the ADMIN password from one address: four
//      wrong guesses at the admin, one correct sign-in as the viewer (which wiped the
//      bucket), repeat. Measured: 40 admin-password guesses reached the KDF in 3.1 s on
//      both servers, bounded only by the loop that ran them — the exact ADR-0034
//      condition this file exists to remove. So the bucket is keyed on the (source,
//      account) PAIR: a correct password for account B refunds B's charges and touches
//      nothing account A's guesses filled, and the block on A's bucket can only ever be
//      lifted by A's own password or by time.
//
// WHAT IT DOES NOT DO, said plainly rather than left to look covered: this is per-source,
// so an attacker distributed across many addresses is slowed only in proportion to how
// few addresses they have. scrypt remains the backstop for that case. Because the key is
// the (source, account) pair, one source gets a fresh allowance per DISTINCT account it
// names — which is what stops account B's success refunding account A's guesses, and is
// also why a run that sprays many account names from one address is bounded by the map's
// cap and eviction rather than by a single per-source counter. Nothing here rate-limits
// `/setup` (its token is one-time and high-entropy) or `GET /signin` (an operator who
// cannot load the page cannot read why they are waiting). Link-local IPv6 addresses drop
// their zone (`fe80::1%eth0`, `%eth1` and `%1` are one bucket): the zone names the
// WRITER's interface, not the peer, so this is the grouping direction, never an escape.

/** How many sources may be remembered at once. See `#room` for what happens at the cap. */
export const MAX_TRACKED_SOURCES = 1024;
/** Failures a source gets before any delay. A mistyped password is not an attack. */
export const FREE_ATTEMPTS = 5;
/** The first penalty, and the unit the backoff doubles from. */
export const BASE_DELAY_MS = 1_000;
/** The longest any source ever waits. An uncapped backoff is a lockout that stalls. */
export const MAX_DELAY_MS = 30_000;
/** No failure for this long and the source is forgotten entirely. */
export const FORGET_MS = 15 * 60_000;
/** The bucket for a request whose socket has no address left to read (already destroyed). */
export const UNKNOWN_SOURCE = "unknown-peer";

import { isIP } from "node:net";

/**
 * THE CLOCK IS MONOTONIC, NOT THE WALL CLOCK.
 *
 * `Date.now()` moves when NTP steps it, when a laptop suspends and resumes, and twice a
 * year in a lot of the world. Both directions break this file, and neither is exotic:
 *
 *   BACKWARD — a one-hour step turns a 30 s penalty into a ~60 minute one, because
 *     `blockedUntil` was computed against the old clock and every later `check` compares
 *     against the new one. That is precisely the LOCKOUT this design exists to refuse,
 *     arriving without an attacker.
 *   FORWARD — a step past `forgetMs` clears every penalty on the board at once, which is
 *     a free reset an attacker gets for nothing.
 *
 * `performance.now()` is monotonic since process start and immune to both. Nothing here
 * ever compares a stored value to a wall-clock time, so the epoch is irrelevant — only
 * differences are, and this is the only clock in the file that produces them.
 */
export const monotonicNow = () => performance.now();

// The addresses that name no host. `::` and `0.0.0.0` are syntactically valid and are
// what a proxy writes when it has nothing to write, so they are refused BY VALUE rather
// than left to open a shared bucket every unidentifiable client would land in.
const UNSPECIFIED = new Set(["::", "0.0.0.0"]);

/**
 * One spelling for one address.
 *
 * Node reports a loopback peer as `::ffff:127.0.0.1` on a dual-stack socket and
 * `127.0.0.1` on others, and RFC 7239 permits `"[2001:db8::1]:4321"` in a chain. Two
 * spellings of one address must not become two budgets — that is a free doubling of an
 * attacker's allowance.
 */
export function normaliseAddress(raw) {
  let a = String(raw ?? "").trim();
  if (a.startsWith('"') && a.endsWith('"')) a = a.slice(1, -1).trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1].trim();
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(":"));
  a = a.toLowerCase();
  const zone = a.indexOf("%");                       // fe80::1%eth0 — the zone is local
  if (zone !== -1) a = a.slice(0, zone);             // to the writer and names no peer
  return a.includes(":") ? (canonicaliseIpv6(a) ?? a) : a;
}

/**
 * ONE IPv6 ADDRESS, ONE SPELLING (RFC 5952), or null if it is not one at all.
 *
 * A textual comparison is not an address comparison. `2001:db8::1`,
 * `2001:0db8:0000:0000:0000:0000:0000:0001` and `2001:db8:0:0:0:0:0:1` are the SAME host
 * written three ways, and `::ffff:0102:0304` is `1.2.3.4` written a fourth — every extra
 * spelling a source can reach is another full allowance, which is a free multiplication of
 * an attacker's budget and is exactly what the doc comment above promises does not happen.
 * A trusted proxy writing a non-canonical form is all it takes; nothing has to be hostile.
 *
 * So the address is parsed to its eight 16-bit groups and re-emitted canonically:
 * IPv4-mapped forms become the dotted quad they are, and everything else is lowercase,
 * leading zeros dropped, with `::` over the LONGEST run of zero groups (leftmost on a
 * tie, and never over a run of one).
 */
export function canonicaliseIpv6(input) {
  let s = String(input);
  // A trailing dotted quad is two groups written in IPv4 notation (`::ffff:1.2.3.4`).
  const tail = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(s);
  if (tail) {
    const o = tail[2].split(".").map(Number);
    if (o.some((n) => !Number.isInteger(n) || n > 255)) return null;
    s = `${tail[1]}${(((o[0] << 8) | o[1]) >>> 0).toString(16)}:${(((o[2] << 8) | o[3]) >>> 0).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = rest === null
    ? head
    : (8 - head.length - rest.length < 0
        ? null
        : [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest]);
  if (!groups || groups.length !== 8) return null;
  const n = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (n.some(Number.isNaN)) return null;
  // `::ffff:a.b.c.d` IS the IPv4 address, and Node hands it to us for every v4 peer on a
  // dual-stack socket. It must key the same bucket as the dotted quad, or one host has two.
  if (n[0] === 0 && n[1] === 0 && n[2] === 0 && n[3] === 0 && n[4] === 0 && n[5] === 0xffff) {
    return [n[6] >> 8, n[6] & 0xff, n[7] >> 8, n[7] & 0xff].join(".");
  }
  let runAt = -1, runLen = 0, bestAt = -1, bestLen = 0;
  for (let i = 0; i < 8; i++) {
    if (n[i] === 0) { if (runAt < 0) runAt = i; runLen += 1; if (runLen > bestLen) { bestLen = runLen; bestAt = runAt; } }
    else { runAt = -1; runLen = 0; }
  }
  const hex = n.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  return `${hex.slice(0, bestAt).join(":")}::${hex.slice(bestAt + bestLen).join(":")}`;
}

/**
 * Is this something that could be an address at all?
 *
 * Deliberately a SHAPE check, and deliberately the gate on every value that could become
 * a map key. `X-Forwarded-For` legitimately carries `unknown` and obfuscated identifiers
 * (RFC 7239 §6.3), and a proxy that is having a bad day carries worse. None of those is
 * an address, and none of them may open a bucket.
 */
export function isAddressLike(value) {
  const a = String(value ?? "");
  // `net.isIP` is the parser Node itself uses, so this asks the same question the socket
  // layer would rather than a regex's approximation of it. A hand-rolled shape check
  // admitted ":", "::", "a:b", ".:." and "1.2.3.4.5:1" — every one of which would have
  // opened a bucket of its own instead of falling back to the peer.
  if (isIP(a) === 0) return false;
  return !UNSPECIFIED.has(a);
}

/**
 * The address a limit is keyed on.
 *
 * FAIL CLOSED MEANS: THE PEER. Every branch that cannot establish a trustworthy forwarded
 * address returns `req.socket.remoteAddress` — no configuration, configuration of the
 * wrong type, a peer that is not a configured proxy, an empty chain, a chain whose last
 * element is not address-shaped. An unconfigured board is the common case AND the one
 * where trusting the header would be worst, since nothing sits in front to overwrite it.
 *
 * FROM THE RIGHT, NOT THE LEFT. `X-Forwarded-For` is a chain: the client's own value sits
 * leftmost and each proxy APPENDS the address it received from, so the trustworthy end is
 * the RIGHT one. Reading the leftmost reads the spoof itself. `isSecureRequest` in
 * signin.mjs reaches for the rightmost element for exactly this reason, and a second,
 * disagreeing notion of "the client address" in the same request would be the defect, not
 * the fix.
 *
 * MULTI-HOP: WALK RIGHTWARD PAST EVERY PROXY YOU HAVE DECLARED. Taking the rightmost
 * element unconditionally is only correct behind ONE proxy. With two —
 * `client, edge, inner` — the rightmost is the EDGE, so every client arriving through it
 * shares one bucket and the limit stops being per-source at all. So the walk starts at the
 * right and skips each element that is itself a configured trusted proxy; the first
 * element that is not one is the nearest address nobody in `trustedProxies` vouched for,
 * and that is the client.
 *
 * WHICH MEANS EVERY HOP MUST BE LISTED, and the failure mode of forgetting one is stated
 * here rather than left to be discovered: an undeclared inner proxy is treated as the
 * client, so the clients behind it are GROUPED into one bucket. That over-limits a shared
 * source; it never lets a source escape its own, and it never lets one client fill
 * another's. Grouping is the fail-closed direction, which is why it is the default outcome
 * rather than an error.
 *
 * @param {object} req                        the incoming request
 * @param {string[]} [opts.trustedProxies]    peer addresses whose forwarded chain is read
 */
export function clientAddressFor(req, { trustedProxies } = {}) {
  const peer = normaliseAddress(req?.socket?.remoteAddress);
  const fallback = isAddressLike(peer) ? peer : (peer || UNKNOWN_SOURCE);
  if (!Array.isArray(trustedProxies)) return fallback;
  const trusted = new Set(
    trustedProxies.map(normaliseAddress).filter((a) => isAddressLike(a)));
  if (!trusted.size || !isAddressLike(peer) || !trusted.has(peer)) return fallback;
  const chain = String(req?.headers?.["x-forwarded-for"] ?? "").split(",").map(normaliseAddress);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isAddressLike(chain[i])) return fallback;   // garbage ends the walk, fail closed
    if (!trusted.has(chain[i])) return chain[i];
  }
  return fallback;      // every hop was a declared proxy: no client was ever named
}

/** The longest an email address can be (RFC 5321); anything past it is not one. */
const MAX_ACCOUNT_KEY = 254;

/**
 * One bucket per (source, account). The separator cannot occur in an address or a folded
 * email, so no two pairs can collide into one key. The account is folded the way the
 * identity store folds it, and truncated so a caller-supplied string cannot grow a key
 * without bound — a truncated impossibility still names no real account, and the map's
 * cap bounds how many of them are remembered at all.
 */
export function bucketKey(source, account) {
  const folded = String(account ?? "").trim().toLowerCase().slice(0, MAX_ACCOUNT_KEY);
  return `${source}\u001f${folded}`;
}

/**
 * Failed sign-in attempts, per (source, account), with decaying backoff and a hard memory
 * cap. `check` and `fail` take the bucket KEY (which the unit tests pass as a bare source
 * to exercise the mechanism); `charge` and `succeed` take the pair and build it.
 *
 * The clock is a PARAMETER on every method rather than a field, so the decay and the cap
 * are testable without waiting and without a fake timer: production passes nothing and
 * gets `monotonicNow()`, and a test passes whatever it needs to observe. It is NEVER
 * `Date.now()` — see `monotonicNow` above for the two ordinary clock steps that would
 * otherwise turn a 30 s backoff into an hour's lockout or clear the whole map at once.
 */
export class AttemptLimiter {
  #entries = new Map();   // source -> { failures, blockedUntil, lastFailureAt }

  constructor({ maxSources = MAX_TRACKED_SOURCES, freeAttempts = FREE_ATTEMPTS,
                baseDelayMs = BASE_DELAY_MS, maxDelayMs = MAX_DELAY_MS,
                forgetMs = FORGET_MS } = {}) {
    this.maxSources = maxSources;
    this.freeAttempts = freeAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.forgetMs = forgetMs;
  }

  /** How many sources are being remembered. Asserted against `maxSources` by test. */
  get size() { return this.#entries.size; }

  /**
   * May this source attempt now?
   *
   * @returns {{ok: true}|{ok: false, retryAfterMs: number}}
   */
  check(source, now = monotonicNow()) {
    const entry = this.#entries.get(source);
    if (!entry) return { ok: true };
    if (now - entry.lastFailureAt >= this.forgetMs) {
      // Dropped HERE, on the read, not only by a sweep: an entry nobody ever looks at
      // again is exactly the entry a sweep is least likely to reach.
      this.#entries.delete(source);
      return { ok: true };
    }
    if (now < entry.blockedUntil) return { ok: false, retryAfterMs: entry.blockedUntil - now };
    return { ok: true };
  }

  /** Record a failed credential check. */
  fail(source, now = monotonicNow()) {
    const entry = this.#entries.get(source) ?? { failures: 0, blockedUntil: 0, lastFailureAt: now };
    entry.failures += 1;
    entry.lastFailureAt = now;
    // `+ 1`: the allowance is spent BY the nth failure, so the (n+1)th attempt is the
    // first one that waits. Off by one in the other direction gives a free extra attempt
    // to every source, forever.
    const over = entry.failures - this.freeAttempts + 1;
    entry.blockedUntil = over > 0
      ? now + Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (over - 1))
      : 0;
    // Delete-then-set so the Map's insertion order IS least-recently-failed order, which
    // is what `#room` evicts from. A source that keeps failing keeps moving to the back.
    this.#entries.delete(source);
    this.#room(now);
    this.#entries.set(source, entry);
  }

  /**
   * MAY THIS ATTEMPT PROCEED, AND IF SO IT IS COUNTED NOW — one synchronous, indivisible
   * step. This is the method the request path must use; `check` and `fail` are its two
   * halves, kept separate only for the unit tests that exercise them.
   *
   * WHY IT HAS TO BE ONE STEP. `check` reading and `fail` writing were separated by
   * `await store.signIn(...)` — scrypt, ~50-100 ms — and nothing in between accounted for
   * requests already in flight. Every request that arrived inside one scrypt window
   * therefore read `failures: 0, blockedUntil: 0` and sailed through. Measured against the
   * code as first written: 40 SEQUENTIAL attempts cost the KDF 5 invocations, while 200
   * CONCURRENT attempts from the same address cost it 170 on `blaze board` and 200 on
   * `blaze start`. It was sustained, not a cold-start window — three bursts of 150,
   * waiting out the backoff between them, reached the KDF 394 and 419 times in 67 seconds
   * against an intended 8. The limit counted only the attackers polite enough to wait
   * their turn, and ADR-0034's "scrypt is the only friction" was still true for everyone
   * else.
   *
   * Counting at ADMISSION rather than at failure is what closes it. JavaScript runs this
   * body to completion before any other request can enter it, so N concurrent callers pass
   * through one at a time and the (freeAttempts + 1)th is refused while the first ones are
   * still inside the KDF. A correct password refunds the charge via `succeed`.
   *
   * THE KEY IS THE (SOURCE, ACCOUNT) PAIR — see point 4 in the file header for the
   * attack that a source-only key permitted. `account` is folded exactly as the identity
   * store folds it (`trim().toLowerCase()`), so `Op@Example.com` and `op@example.com`
   * are the one account they are to the store and not two allowances.
   *
   * @param {string} source   from `clientAddressFor`
   * @param {string} account  the email the credential names, as the request spelled it
   * @returns {{ok: true}|{ok: false, retryAfterMs: number}}
   */
  charge(source, account, now = monotonicNow()) {
    const key = bucketKey(source, account);
    const verdict = this.check(key, now);
    if (!verdict.ok) return verdict;
    this.fail(key, now);
    return { ok: true };
  }

  /**
   * A correct password FOR THIS ACCOUNT. Only its own bucket is refunded: the charges
   * account A's guesses put in (source, A) are not this account's to give back.
   */
  succeed(source, account) { this.#entries.delete(bucketKey(source, account)); }

  /**
   * Make room for one more entry, without ever letting the map exceed its cap.
   *
   * EVICTION IS PERMISSIVE-ONLY, and that is the property that makes a bounded map safe
   * here. Dropping an entry can only DISCARD a penalty; it can never impose one. So an
   * attacker who floods the map from many addresses cannot use eviction to throttle the
   * operator — the worst they achieve is buying back their own oldest allowance, at the
   * cost of holding `maxSources` addresses actively failing.
   */
  #room(now) {
    if (this.#entries.size < this.maxSources) return;
    for (const [source, entry] of this.#entries) {
      if (now - entry.lastFailureAt >= this.forgetMs) this.#entries.delete(source);
    }
    // Still full: evict from the FRONT, which insertion order makes the least recently
    // failed — the quiet source, never the one currently attacking.
    while (this.#entries.size >= this.maxSources) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      this.#entries.delete(oldest.value);
    }
  }
}
