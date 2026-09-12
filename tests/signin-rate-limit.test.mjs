// tests/signin-rate-limit.test.mjs — BLZ-571. `POST /signin` gets a cost.
//
// THE GAP, stated by ADR-0034 itself: scrypt's ~50–100 ms was the ONLY friction slowing a
// credential-stuffing run against the single operator account. Nothing counted attempts,
// so an attacker's rate was bounded by the board's CPU and by nothing else.
//
// THE SHAPE IS DECIDED, and the decision is recorded in
// docs/superpowers/plans/2026-08-31-blaze-app-adoption-and-import-standard.md §5 and in
// ADR-0036 (docs/decisions/): the limit lives in the APPLICATION, keyed per source address, with an
// explicit trusted-proxy setting so the real client address is known behind Traefik. Not
// at the edge, because it has to hold however the board is fronted, and because a limit
// nothing in this suite can exercise is a limit nobody can prove.
//
// WHAT THESE TESTS EXIST TO PROVE, in the order the risk runs:
//
//   1. SPOOFABILITY IS THE WHOLE RISK. Per-source limiting keyed on a header anyone can
//      set is WORSE than no limiting: an attacker rotates the header to escape their own
//      bucket, and sets it to the operator's address to fill the operator's. So the
//      address resolution is tested first, and hardest, and the fail-closed direction —
//      no trusted proxy configured, or the peer is not one — is tested by NAME.
//   2. THE MAP IS BOUNDED. A per-source map keyed on anything an attacker can vary is
//      itself a memory-exhaustion vector. Its size is capped, and eviction is proven to
//      be permissive-only: forgetting an entry can drop a penalty, never create one.
//   3. BACKOFF, NOT LOCKOUT. There is ONE account on this board. A hard lockout is a
//      self-inflicted denial of service on the only operator, so the penalty decays and
//      a correct password always works again after a bounded wait.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import {
  AttemptLimiter, clientAddressFor, normaliseAddress, isAddressLike, monotonicNow, bucketKey,
  MAX_TRACKED_SOURCES, FREE_ATTEMPTS, BASE_DELAY_MS, MAX_DELAY_MS, FORGET_MS,
} from "../scripts/model/rate-limit.mjs";

const PASSWORD = "correct horse battery staple";
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function board({ config = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blaze-ratelimit-"));
  roots.push(root);
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    ["---", "id: OBA-1", "title: t", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01",
     "---", "", "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  if (config) writeFileSync(join(root, "blaze.config.json"), JSON.stringify(config));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}

const VIEWER_PASSWORD = "viewer viewer viewer viewer";

/** A board with an admin and a read-only viewer, each with a password. `signIns` counts
 *  reaching the KDF. The viewer is here for the refund test: a valid credential of the
 *  LEAST privilege must not buy guesses at the admin. */
async function configured({ config = null } = {}) {
  const { root, projects } = board({ config });
  await addUser(root, { email: "op@example.com", role: "admin" });
  await addUser(root, { email: "eve@example.com", role: "viewer" });
  const id = loadIdentity(root);
  await id.store.setPassword({ email: "op@example.com", password: PASSWORD });
  await id.store.setPassword({ email: "eve@example.com", password: VIEWER_PASSWORD });
  id.close();

  const identity = loadIdentity(root);
  const counted = { signIns: 0 };
  const store = new Proxy(identity.store, {
    get(target, prop, recv) {
      if (prop !== "signIn") return Reflect.get(target, prop, recv);
      return async (...args) => { counted.signIns += 1; return target.signIn(...args); };
    },
  });
  const server = startServer({ port: 0, root, projectsDir: projects,
                               identity: { ...identity, store, close: identity.close } });
  await new Promise((res) => server.once("listening", res));
  return { root, server, counted, base: `http://127.0.0.1:${server.address().port}`,
           close: () => { server.close(); identity.close(); } };
}

const attempt = (base, { email = "op@example.com", password = "wrong wrong wrong wrong",
                         forwardedFor = null } = {}) =>
  fetch(`${base}/signin`, {
    method: "POST", redirect: "manual",
    headers: {
      "content-type": "application/json", "x-blaze-csrf": CSRF,
      ...(forwardedFor === null ? {} : { "x-forwarded-for": forwardedFor }),
    },
    body: JSON.stringify({ email, password }),
  });

/** A request object shaped like the one Node hands the handler. Dummy addresses only. */
const req = (peer, forwardedFor) => ({
  socket: { remoteAddress: peer },
  headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
});

// ---- 1. WHOSE ADDRESS IS IT ----------------------------------------------------------
describe("the client address a limit is keyed on cannot be chosen by the caller", () => {
  test("with NO trusted proxy configured, an X-Forwarded-For is IGNORED — the peer is the client",
    () => {
      // FAIL CLOSED. An unconfigured board is the common case, and it is the one where
      // trusting the header would be worst: nothing sits in front to overwrite it.
      assert.equal(clientAddressFor(req("203.0.113.9", "198.51.100.7"), {}), "203.0.113.9");
      assert.equal(
        clientAddressFor(req("203.0.113.9", "198.51.100.7"), { trustedProxies: [] }),
        "203.0.113.9");
    });

  test("a spoofed X-Forwarded-For can neither ESCAPE the sender's own bucket nor CREATE another's",
    () => {
      // The two halves of the spoofing risk, in one assertion each. Every one of these
      // requests comes from the same peer, so every one must resolve to the same key:
      // rotating the header buys the attacker nothing, and no header value lets them
      // deposit failures into an address that is not theirs.
      const keys = ["198.51.100.7", "203.0.113.9", "", "unknown", "not an address",
                    "1.2.3.4, 5.6.7.8"]
        .map((v) => clientAddressFor(req("192.0.2.50", v), { trustedProxies: [] }));
      assert.deepEqual([...new Set(keys)], ["192.0.2.50"],
        "a caller-set header moved the bucket, so per-source limiting is spoofable — "
        + "which is worse than no limiting at all");
    });

  test("a trusted proxy's chain is read from the LAST element, as isSecureRequest reads its own",
    () => {
      // SAME REASONING, DELIBERATELY. `X-Forwarded-*` is a chain the client writes the
      // left of and each proxy APPENDS to, so the trustworthy element is the one the
      // NEAREST proxy wrote. signin.mjs's isSecureRequest already settled this; a second,
      // disagreeing notion of "the client address" in the same file would be the bug.
      const got = clientAddressFor(req("127.0.0.1", "198.51.100.7, 203.0.113.9"),
                                   { trustedProxies: ["127.0.0.1"] });
      assert.equal(got, "203.0.113.9",
        "reading the leftmost element takes the value the CLIENT wrote, which is the "
        + "spoof itself");
    });

  test("the header is read only when the PEER is a trusted proxy, never merely because it is set",
    () => {
      assert.equal(
        clientAddressFor(req("198.51.100.7", "203.0.113.9"), { trustedProxies: ["127.0.0.1"] }),
        "198.51.100.7",
        "an attacker who connects directly must not be able to speak as the proxy");
    });

  test("a MISCONFIGURED trusted-proxy setting fails closed, it does not fall back to trusting the header",
    () => {
      for (const trustedProxies of [null, undefined, "127.0.0.1", 1, {}, ["nonsense"], [""],
                                    [null]]) {
        assert.equal(clientAddressFor(req("127.0.0.1", "203.0.113.9"), { trustedProxies }),
          "127.0.0.1", `trustedProxies=${JSON.stringify(trustedProxies)} must not trust the header`);
      }
    });

  test("a trusted proxy that writes something unusable falls back to the peer, not to a shared bucket",
    () => {
      for (const bad of ["", "   ", "unknown", "_hidden", "not an address", ",,"]) {
        assert.equal(clientAddressFor(req("127.0.0.1", bad), { trustedProxies: ["127.0.0.1"] }),
          "127.0.0.1", `x-forwarded-for=${JSON.stringify(bad)} must not become a key`);
      }
    });

  test("every spelling of ONE IPv6 address is ONE bucket, not one bucket per spelling", () => {
    // A textual comparison is not an address comparison. These are the same host written
    // five ways, and a trusted proxy writing a non-canonical form is all it takes to reach
    // them — nothing has to be hostile. Each extra spelling that keys its own entry is a
    // whole extra allowance, which is a free multiplication of an attacker's budget.
    const spellings = ["2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001",
                       "2001:db8:0:0:0:0:0:1", "[2001:DB8::1]:4321", "2001:db8::1%eth0"];
    const keys = spellings.map((v) =>
      clientAddressFor(req("127.0.0.1", v), { trustedProxies: ["127.0.0.1"] }));
    assert.deepEqual([...new Set(keys)], ["2001:db8::1"],
      `these spell one address and produced ${new Set(keys).size} buckets: ${keys.join(" | ")}`);
    // …and the IPv4-mapped forms are the IPv4 address, in every notation Node uses.
    assert.deepEqual(
      [...new Set(["::ffff:1.2.3.4", "::ffff:0102:0304", "1.2.3.4", "::FFFF:1.2.3.4"]
        .map(normaliseAddress))],
      ["1.2.3.4"]);
    // …and a link-local zone drops: `%eth0`, `%eth1`, `%1` name the WRITER's interface,
    // not the peer, so they group to one bucket. Grouping is fail-closed, not an escape.
    assert.deepEqual(
      [...new Set(["fe80::1%eth0", "fe80::1%eth1", "fe80::1%1", "fe80::1"].map(normaliseAddress))],
      ["fe80::1"]);
  });

  test("garbage that merely LOOKS address-shaped never opens a bucket of its own", () => {
    // A hand-rolled shape check admitted every one of these, so a proxy having a bad day
    // — or an attacker upstream of one — could mint buckets at will instead of falling
    // back to the peer. `net.isIP` is the parser Node's own socket layer uses.
    for (const junk of [":", "::", "a:b", ".:.", "1.2.3.4.5:1", "0.0.0.0", "1.2.3.256",
                        "12345::", "::1::2", "-1.2.3.4", "1.2.3", "localhost"]) {
      assert.equal(isAddressLike(junk), false, `${JSON.stringify(junk)} is not an address`);
      assert.equal(clientAddressFor(req("127.0.0.1", junk), { trustedProxies: ["127.0.0.1"] }),
        "127.0.0.1", `x-forwarded-for=${JSON.stringify(junk)} must fall back to the peer`);
    }
    // …and the real ones still are, or the check above proves only that it says no.
    for (const good of ["1.2.3.4", "203.0.113.9", "2001:db8::1", "::1", "fe80::1"]) {
      assert.equal(isAddressLike(good), true, `${good} IS an address`);
    }
  });

  test("BEHIND TWO PROXIES the client is the rightmost address NO declared proxy vouched for",
    () => {
      // Taking the rightmost element unconditionally is correct behind ONE proxy only.
      // With two it takes the EDGE, so every client arriving through it shares a single
      // bucket and the limit stops being per-source at all.
      const chain = "203.0.113.9, 10.0.0.8, 10.0.0.9";
      assert.equal(
        clientAddressFor(req("127.0.0.1", chain),
          { trustedProxies: ["127.0.0.1", "10.0.0.8", "10.0.0.9"] }),
        "203.0.113.9",
        "with every hop declared, the client is the one address none of them is");
      // Forgetting a hop GROUPS the clients behind it — it never lets one escape its own
      // bucket, and never lets one fill another's. That is the fail-closed direction.
      assert.equal(
        clientAddressFor(req("127.0.0.1", chain), { trustedProxies: ["127.0.0.1", "10.0.0.9"] }),
        "10.0.0.8",
        "an undeclared hop is treated as the client, which over-limits rather than under-");
      // A chain that is proxies all the way down named no client at all: use the peer.
      assert.equal(
        clientAddressFor(req("127.0.0.1", "10.0.0.8, 10.0.0.9"),
          { trustedProxies: ["127.0.0.1", "10.0.0.8", "10.0.0.9"] }),
        "127.0.0.1");
    });

  test("IPv4-mapped IPv6 and a bracketed host:port are the SAME source, not two buckets", () => {
    // Node reports a loopback peer as `::ffff:127.0.0.1` on a dual-stack socket and as
    // `127.0.0.1` on others. Two spellings of one address must not be two budgets.
    assert.equal(clientAddressFor(req("::ffff:203.0.113.9"), {}), "203.0.113.9");
    assert.equal(
      clientAddressFor(req("127.0.0.1", "[2001:db8::1]:4321"), { trustedProxies: ["::ffff:127.0.0.1"] }),
      "2001:db8::1");
  });
});

// ---- 2. THE MAP IS BOUNDED -----------------------------------------------------------
describe("the per-source map cannot be grown without bound", () => {
  test("it never exceeds its cap, however many distinct sources fail", () => {
    const limiter = new AttemptLimiter();
    const overflow = MAX_TRACKED_SOURCES + 500;
    for (let i = 0; i < overflow; i++) {
      for (let n = 0; n <= FREE_ATTEMPTS; n++) limiter.fail(`198.51.100.${i}`, 1000 + i);
    }
    assert.ok(limiter.size <= MAX_TRACKED_SOURCES,
      `map grew to ${limiter.size}, past its ${MAX_TRACKED_SOURCES} cap — the limiter is `
      + "itself the memory-exhaustion vector it was added to close");
  });

  test("EVICTION CANNOT IMPOSE A PENALTY on a source that never failed, however big the flood",
    () => {
      // The property that makes a bounded map safe, stated NARROWLY because the broad
      // version ("eviction can only forget a penalty, never impose one") oversells it.
      // What matters is this direction: if flooding could ever leave the operator
      // throttled, an attacker with many addresses would have a lockout for free.
      const limiter = new AttemptLimiter();
      for (let i = 0; i < MAX_TRACKED_SOURCES + 500; i++) {
        for (let n = 0; n <= FREE_ATTEMPTS; n++) limiter.fail(`198.51.100.${i}`, 1000 + i);
      }
      const fresh = limiter.check("203.0.113.9", 2000);
      assert.equal(fresh.ok, true,
        "a source that never failed was throttled because OTHER sources filled the map");
    });

  test("…and the converse IS true and is a deliberate trade: a flood can discard the FLOODER's own oldest penalty",
    () => {
      // Pinned rather than denied. Bounded memory is chosen over perfect memory, so an
      // attacker holding maxSources addresses and keeping them all failing will evict
      // their own oldest bucket and buy its allowance back. It is poor value — 1024 live
      // sources to recover the allowance of one — but it is real, and a claim that it
      // cannot happen would be false.
      const limiter = new AttemptLimiter();
      for (let n = 0; n <= FREE_ATTEMPTS; n++) limiter.fail("192.0.2.1", 1000);
      assert.equal(limiter.check("192.0.2.1", 1000).ok, false, "the flooder starts blocked");
      for (let i = 0; i < MAX_TRACKED_SOURCES + 5; i++) {
        for (let n = 0; n <= FREE_ATTEMPTS; n++) limiter.fail(`198.51.100.${i}`, 2000 + i);
      }
      assert.equal(limiter.check("192.0.2.1", 2100).ok, true,
        "if this is ever false, the trade above changed and the docs must change with it");
    });

  test("the source evicted is the LEAST RECENTLY FAILED, so an active attacker keeps their own penalty",
    () => {
      const limiter = new AttemptLimiter();
      // `old` fails first and then goes quiet; `hot` keeps failing. Fill past the cap.
      for (let n = 0; n <= FREE_ATTEMPTS; n++) limiter.fail("192.0.2.1", 1000);
      for (let i = 0; i < MAX_TRACKED_SOURCES; i++) {
        for (let n = 0; n <= FREE_ATTEMPTS; n++) limiter.fail(`198.51.100.${i}`, 2000 + i);
      }
      assert.equal(limiter.check("192.0.2.1", 2100).ok, true, "the quiet source was forgotten");
      assert.equal(limiter.check(`198.51.100.${MAX_TRACKED_SOURCES - 1}`, 2100).ok, false,
        "the most recently failing source must still be carrying its penalty");
    });

  test("a source quiet for longer than the forget window costs no memory at all", () => {
    const limiter = new AttemptLimiter();
    for (let n = 0; n <= FREE_ATTEMPTS; n++) limiter.fail("192.0.2.1", 1000);
    assert.equal(limiter.size, 1);
    limiter.check("192.0.2.1", 1000 + FORGET_MS + 1);
    assert.equal(limiter.size, 0, "an expired entry must be dropped when it is next looked at");
  });
});

// ---- 3. BACKOFF, NOT LOCKOUT ---------------------------------------------------------
describe("the penalty is a delay that decays, never a lockout", () => {
  test("the first few failures cost nothing — a mistyped password is not an attack", () => {
    const limiter = new AttemptLimiter();
    for (let n = 0; n < FREE_ATTEMPTS; n++) {
      assert.equal(limiter.check("192.0.2.1", 1000).ok, true, `attempt ${n + 1} must be free`);
      limiter.fail("192.0.2.1", 1000);
    }
    assert.equal(limiter.check("192.0.2.1", 1000).ok, false,
      "…and the one after the allowance must not be");
  });

  test("the delay grows with each further failure, and is CAPPED", () => {
    const limiter = new AttemptLimiter();
    const delays = [];
    for (let n = 0; n < FREE_ATTEMPTS + 12; n++) {
      limiter.fail("192.0.2.1", 1000);
      const v = limiter.check("192.0.2.1", 1000);
      if (!v.ok) delays.push(v.retryAfterMs);
    }
    assert.ok(delays.length > 0, "no delay was ever imposed — this test observed nothing");
    assert.equal(delays[0], BASE_DELAY_MS);
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1], "backoff must not shrink while failures continue");
    }
    assert.equal(Math.max(...delays), MAX_DELAY_MS,
      "an uncapped backoff IS a lockout — it just takes longer to say so");
  });

  test("waiting out the delay restores the account WITHOUT any operator intervention", () => {
    const limiter = new AttemptLimiter();
    for (let n = 0; n <= FREE_ATTEMPTS; n++) limiter.fail("192.0.2.1", 1000);
    const blocked = limiter.check("192.0.2.1", 1000);
    assert.equal(blocked.ok, false);
    assert.equal(limiter.check("192.0.2.1", 1000 + blocked.retryAfterMs).ok, true,
      "the only account on this board must never need a human to unlock it");
  });

  test("the clock is MONOTONIC, so an ordinary wall-clock step cannot turn a 30 s wait into an hour",
    () => {
      // Both directions of a clock step break this file, and neither is exotic — NTP
      // corrections, a laptop resuming from suspend, a DST boundary. BACKWARD: a one-hour
      // step turns a 30 s penalty into a ~60 minute one, which is exactly the lockout this
      // design exists to refuse, arriving with no attacker involved. FORWARD: a step past
      // the forget window clears every penalty on the board at once, free to the attacker.
      const t = monotonicNow();
      assert.equal(typeof t, "number");
      assert.ok(Math.abs(Date.now() - t) > 365 * 24 * 60 * 60 * 1000,
        "the default clock is the WALL CLOCK — every penalty it computes is hostage to the "
        + "next NTP correction, suspend/resume or DST boundary");
      assert.ok(monotonicNow() >= t, "a monotonic clock never goes backwards");

      // …and the cap holds when the limiter is left to its own clock, which is the thing
      // an operator actually experiences.
      const limiter = new AttemptLimiter();
      for (let n = 0; n < FREE_ATTEMPTS + 20; n++) limiter.fail("192.0.2.1");
      const v = limiter.check("192.0.2.1");
      assert.equal(v.ok, false);
      assert.ok(v.retryAfterMs <= MAX_DELAY_MS,
        `retryAfterMs was ${v.retryAfterMs}, past the ${MAX_DELAY_MS} ms cap`);
    });

  test("a correct password clears the penalty for THAT ACCOUNT, and only that account", () => {
    // RE-CUT. This test used to charge and refund a bare source and assert the whole
    // bucket cleared — which pinned the very defect the re-review found: a success on ANY
    // account wiped the source's guesses at EVERY account. It now uses the (source,
    // account) API and pins the property that closes it.
    const limiter = new AttemptLimiter();
    const src = "192.0.2.1";
    // The attacker fills the admin's bucket from this source, and their own viewer bucket.
    for (let n = 0; n <= FREE_ATTEMPTS; n++) limiter.charge(src, "op@example.com", 1000);
    limiter.charge(src, "eve@example.com", 1000);
    assert.equal(limiter.check(bucketKey(src, "op@example.com"), 1000).ok, false,
      "the admin's bucket is blocked, as it must be after a burst of wrong guesses");

    // A correct viewer password clears the VIEWER'S bucket…
    limiter.succeed(src, "eve@example.com");
    assert.equal(limiter.check(bucketKey(src, "eve@example.com"), 1000).ok, true);
    // …and does NOT touch the admin's. This is the whole fix.
    assert.equal(limiter.check(bucketKey(src, "op@example.com"), 1000).ok, false,
      "a viewer sign-in refunded the admin's guesses — any valid credential would then "
      + "brute-force the admin from one address, which is the re-review's blocking finding");

    // The admin's own correct password is the only thing (besides time) that clears it.
    limiter.succeed(src, "op@example.com");
    assert.equal(limiter.check(bucketKey(src, "op@example.com"), 1000).ok, true);
  });
});

// ---- 4. IT IS ACTUALLY WIRED INTO THE SERVED ROUTE -----------------------------------
describe("POST /signin on the running server carries the limit", () => {
  test("a SEQUENTIAL burst of failures is refused 429, and the KDF stops being asked", async () => {
    const ctx = await configured();
    try {
      let throttled = null;
      for (let n = 0; n < FREE_ATTEMPTS + 3 && !throttled; n++) {
        const r = await attempt(ctx.base);
        if (r.status === 429) throttled = r; else assert.equal(r.status, 401);
      }
      assert.ok(throttled, `no attempt was throttled within ${FREE_ATTEMPTS + 3} tries`);
      assert.match(String(throttled.headers.get("retry-after")), /^\d+$/,
        "a refusal that does not say when to come back is a lockout to the operator");
      const body = await throttled.json();
      assert.doesNotMatch(JSON.stringify(body), /op@example\.com|password is|no such/i,
        "the throttled answer must not say more about the account than the 401 does");

      // THE POINT OF THE WHOLE TICKET: the work stops before scrypt, so the attacker's
      // rate is no longer bounded only by the board's CPU.
      const before = ctx.counted.signIns;
      const again = await attempt(ctx.base);
      assert.equal(again.status, 429);
      assert.equal(ctx.counted.signIns, before,
        "the throttled request still reached the password verifier — the limit is a "
        + "message, not a limit");
    } finally { ctx.close(); }
  });

  test("CONCURRENT attempts are counted too — the KDF is reached FREE_ATTEMPTS times, not once per socket",
    async () => {
      // THE BLOCKING DEFECT THIS TEST EXISTS FOR. `check` read the map and `fail` wrote it,
      // and the two were separated by `await store.signIn(...)` — scrypt, ~50-100 ms — with
      // nothing accounting for the requests already in flight. Every request that arrived
      // inside one KDF window read `failures: 0, blockedUntil: 0` and went straight
      // through. Measured on the code as first written: 40 SEQUENTIAL attempts cost the KDF
      // 5 invocations; 200 CONCURRENT attempts from the same address, no spoofing, cost it
      // 170 — and sustained, three bursts of 150 with the backoff waited out between them
      // reached it 394 times in 67 seconds against an intended 8. ~49x, and the ceiling was
      // the attacker's socket count rather than anything this board controlled.
      //
      // The test above bursts with `await` inside a `for`, so it never reaches the
      // concurrent state and stayed green throughout. Its name — "the KDF stops being
      // asked at all" — was false for any attacker who did not wait their turn.
      const ctx = await configured();
      try {
        const N = FREE_ATTEMPTS + 25;
        const codes = await Promise.all(
          Array.from({ length: N }, () => attempt(ctx.base).then((r) => r.status)));
        assert.equal(ctx.counted.signIns, FREE_ATTEMPTS,
          `${ctx.counted.signIns} of ${N} concurrent attempts reached the password verifier, `
          + `not ${FREE_ATTEMPTS} — the allowance is being spent once per SOCKET rather than `
          + "once per attempt, so scrypt is still the only friction");
        assert.ok(codes.filter((c) => c === 429).length >= N - FREE_ATTEMPTS,
          `only ${codes.filter((c) => c === 429).length} of ${N} were refused`);
      } finally { ctx.close(); }
    });

  test("a burst that is concurrent AND sustained does not buy a fresh allowance per round",
    async () => {
      // The defect was not a cold-start window: once `blockedUntil` lapsed, the next burst
      // passed in full. Three rounds here, with the backoff waited out between them, must
      // cost the KDF exactly one allowance per round and not one per socket.
      const ctx = await configured();
      try {
        for (let round = 0; round < 3; round++) {
          const before = ctx.counted.signIns;
          await Promise.all(Array.from({ length: 40 }, () => attempt(ctx.base)));
          const spent = ctx.counted.signIns - before;
          assert.ok(spent <= FREE_ATTEMPTS,
            `round ${round + 1} reached the KDF ${spent} times, past the ${FREE_ATTEMPTS} `
            + "an allowance is worth");
          if (round < 2) await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 40));
        }
        assert.ok(ctx.counted.signIns <= FREE_ATTEMPTS * 3,
          `${ctx.counted.signIns} KDF invocations across three bursts of 40`);
      } finally { ctx.close(); }
    });

  test("a valid VIEWER credential cannot buy guesses at the ADMIN from the same address",
    async () => {
      // THE RE-REVIEW'S BLOCKING FINDING, end to end. A source-only bucket let any holder
      // of any valid credential refund the source's guesses at every OTHER account:
      // four wrong admin guesses, one correct viewer sign-in (which cleared the bucket),
      // repeat, and 40 admin-password guesses reached the KDF in ~3 s. The 6th admin guess
      // must be 429 no matter how many times the viewer signs in between.
      const ctx = await configured();
      try {
        let adminGuessesAtKdf = 0;
        for (let round = 0; round < 4; round++) {
          for (let g = 0; g < FREE_ATTEMPTS; g++) {
            const before = ctx.counted.signIns;
            const r = await attempt(ctx.base, { email: "op@example.com" });
            if (ctx.counted.signIns > before) adminGuessesAtKdf += 1;
            if (r.status === 429) break;
          }
          // The viewer signs in for real between rounds. This must refund the VIEWER, not
          // the admin — if it clears the admin's bucket, the loop above never stops.
          const v = await attempt(ctx.base, { email: "eve@example.com", password: VIEWER_PASSWORD });
          assert.equal(v.status, 200, "the viewer's own correct password must still work");
        }
        assert.ok(adminGuessesAtKdf <= FREE_ATTEMPTS,
          `${adminGuessesAtKdf} admin-password guesses reached the KDF despite the viewer `
          + `signing in between rounds — a viewer credential is brute-forcing the admin`);
        // …and the admin remains throttled, so the very next guess is still refused.
        assert.equal((await attempt(ctx.base, { email: "op@example.com" })).status, 429);
      } finally { ctx.close(); }
    });

  test("varying the CASE of the account name does not buy a fresh allowance against it", async () => {
    // The store folds email `trim().toLowerCase()`, so `OP@Example.com` IS the admin. If
    // the limiter's key did not fold the same way, each spelling would be its own bucket
    // and an attacker could take FREE_ATTEMPTS guesses per spelling at one account.
    const ctx = await configured();
    try {
      const spellings = ["op@example.com", "OP@EXAMPLE.COM", "Op@Example.com", " op@example.com ",
                         "oP@eXaMpLe.CoM", "OP@example.com", "op@EXAMPLE.com", "op@example.COM"];
      let reachedKdf = 0;
      for (const email of spellings) {
        const before = ctx.counted.signIns;
        await attempt(ctx.base, { email });
        if (ctx.counted.signIns > before) reachedKdf += 1;
      }
      assert.ok(reachedKdf <= FREE_ATTEMPTS,
        `${reachedKdf} guesses at one account reached the KDF across ${spellings.length} `
        + "spellings of its name — each spelling is its own bucket");
      assert.equal(bucketKey("192.0.2.1", "  OP@Example.COM "), bucketKey("192.0.2.1", "op@example.com"));
    } finally { ctx.close(); }
  });

  test("while throttled, even the RIGHT password is refused — the limit is not advisory",
    async () => {
      const ctx = await configured();
      try {
        for (let n = 0; n <= FREE_ATTEMPTS + 2; n++) await attempt(ctx.base);
        const r = await attempt(ctx.base, { password: PASSWORD });
        assert.equal(r.status, 429);
        assert.equal(r.headers.getSetCookie().length, 0, "and no session is minted");
      } finally { ctx.close(); }
    });

  test("BEHIND A TRUSTED PROXY, one source's burst does not lock the operator out of another",
    async () => {
      // AC of BLZ-571, in one test. The attacker arrives through the same Traefik the
      // operator does; only the address the proxy reports differs.
      const ctx = await configured({ config: { trustedProxies: ["127.0.0.1", "::1"] } });
      try {
        for (let n = 0; n <= FREE_ATTEMPTS + 2; n++) {
          await attempt(ctx.base, { forwardedFor: "198.51.100.7" });
        }
        assert.equal((await attempt(ctx.base, { forwardedFor: "198.51.100.7" })).status, 429,
          "the attacking source must be throttled, or this test proves nothing");
        const operator = await attempt(ctx.base,
          { forwardedFor: "203.0.113.9", password: PASSWORD });
        assert.equal(operator.status, 200,
          "the legitimate operator, from a different address, was locked out by someone "
          + "else's burst");
        assert.ok(operator.headers.getSetCookie().length > 0);
      } finally { ctx.close(); }
    });

  test("with NO trusted proxy configured, rotating X-Forwarded-For does NOT escape the limit",
    async () => {
      // The spoofing half, end to end. Every request below is from the same peer, and
      // claims a different client address. A board that read the header would hand the
      // attacker an unlimited budget and let them fill anyone else's.
      const ctx = await configured();
      try {
        let saw429 = false;
        for (let n = 0; n <= FREE_ATTEMPTS + 3; n++) {
          const r = await attempt(ctx.base, { forwardedFor: `198.51.100.${n}` });
          if (r.status === 429) saw429 = true;
        }
        assert.equal(saw429, true,
          "a rotating X-Forwarded-For bought an unlimited number of attempts");
      } finally { ctx.close(); }
    });

  test("GET /signin is never throttled — the door must still be reachable to knock on",
    async () => {
      const ctx = await configured();
      try {
        for (let n = 0; n <= FREE_ATTEMPTS + 2; n++) await attempt(ctx.base);
        assert.equal((await attempt(ctx.base)).status, 429);
        assert.equal((await fetch(`${ctx.base}/signin`)).status, 200,
          "an operator who cannot even load the page cannot read why they are waiting");
      } finally { ctx.close(); }
    });
});
