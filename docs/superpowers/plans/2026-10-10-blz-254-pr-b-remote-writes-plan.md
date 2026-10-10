# BLZ-254 PR B — remote writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a second machine write to the live board over HTTP once it is on Postgres: `POST /api/new` and `POST /api/link` on `blaze board`, a bearer-only request exempt from the CSRF header, `blaze` remote mode (`BLAZE_REMOTE_URL` + `BLAZE_TOKEN`), and the two-machine concurrency proof.

**Architecture:** One predicate, `csrfRequired({ headers, store })` in `serve-auth.mjs`, decides the CSRF exemption: exempt only for a bearer token the gate judged, with no session cookie beside it. `serve.mjs`'s POST handler gains `/api/new` (`applyNew` through the resolved port, so under db the id comes from `project_counter`) and `/api/link` (`applyLink`), both recording the caller as the event's actor. `scripts/remote-client.mjs` (built-in `fetch`) turns the six verbs' argv into requests to one origin; `cli.mjs` routes to it when both variables are set and refuses everything else. `scripts/ops/concurrency-proof.mjs` is the operator's create/verify harness on the same client.

**Tech Stack:** Node 24 ESM, `node:test`, built-in `fetch`, `node:sqlite`, `pg` 8 against Postgres 17.

**Spec:** `docs/superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md` — §5.4, §6 ("Remote writes"), §7 step 3, and §8 row B. Read it first; this plan argues from it. ADR-0013 §7 is the decision Task 1 amends.

**Prototype provenance.** Every code and test block below was run, task by task, in a scratch worktree of `385d2aa` (PR A's squash on `main`) against `postgres:17-alpine`. This Markdown was then GENERATED from that prototype's per-task trees: each "replace" block was checked to occur exactly once in its file at that point, and applying all of them in order reproduces the prototype byte for byte (29 edits, 17 files). Each task's tests were run on the tree with only that task's tests applied — the failures named in each Step 2 are that run's — and then on the finished task. On the final tree, `npm run test:coverage` with `BLAZE_TEST_PG_URL` set and a private `TMPDIR` → `tests 5442, pass 5441, fail 0, skipped 1`; c8 statements 98.04 %, branches 88.28 %, functions 97.68 %, lines 98.04 % (thresholds 91/77/93/91); 0 pg deprecation lines; `hygiene-check` clean; no attributable scratch directory left.

## Global Constraints

- **`fs` and `dual` behaviour stay unchanged** except where this PR exists to change it: the CSRF rule (Task 1, the spec's decision) and the two new endpoints. Mode comes only from `resolveWriteMode(env)` (or the `mode` the resolvers return); nothing sniffs `writePort.name` or `database.driver`.
- **SECURITY-SENSITIVE (auth). Tests must pin, on a real server:** a cookie-only POST without the CSRF header is `403`; an unauthenticated POST is `401` (the CSRF header is never a credential); a `read`-scope token gets `403` on every write; cookie + bearer without the header is `403`; a loopback board with no users still requires the header; and remote mode never sends the token to any host but `BLAZE_REMOTE_URL`'s origin (no redirect followed, no plain `http` off loopback, no path, no `user:pass@`, and no message prints it).
- **`tests/model/seam-closure.test.mjs`: changes are additive or exact name swaps, each with a `// BLZ-684:` comment; never weaken an assertion.** Any module that names `fsReadStorage` must be on `FS_READER_ALLOWED` (this plan adds none).
- **One existing assertion is reversed, on purpose, and only one:** `tests/serve-identity.test.mjs`'s "a valid token without [the CSRF header] is still refused" becomes "…is accepted" — spec §5.4's decision, recorded in ADR-0013's addendum (Task 1). Every other existing test is untouched.
- **Postgres tests use `tests/helpers/pg-scratch.mjs`** (`PG`, `PG_SKIP`, `scratchPgDb`, `pgClient`), one scratch database per test, gated `PG_SKIP`; a host is derived with `new URL(PG).hostname`, never hard-coded.
- **Hand-rolled `applyNew` calls pass `today`, and a `task` passes `extra: { estimate }`.**
- **Reuse, don't re-derive:** `gate`, `bearerFrom`, `cookieFrom`, `SESSION_COOKIE`, `isLoopback` (`serve-auth.mjs`); `applyNew`, `applyLink`; `resolvePorts` (already resolved per request in the POST handler); `stageFor`; `actorFor`; `addUser`; `runDb` (`init`/`load`).
- **Test hygiene the suite enforces:** scratch dirs via `scratch(mkdtempSync(join(tmpdir(), "<literal-prefix>-")))` and `scratchRegistry()`; no `rmSync` in a test body; a spawned process gets an env with `BLAZE_WRITE_PORT`/`BLAZE_READONLY` (and, for remote tests, `BLAZE_REMOTE_URL`/`BLAZE_TOKEN`) DELETED, never set to `""`; a test that runs a server in-process spawns its client with `spawn` (async) — `spawnSync` would block the event loop the server answers on.
- **Commits:** one per task, subject `BLZ-684: …`; staged and committed with an explicit pathspec; **no `Co-Authored-By` or `Signed-off-by` trailer**; no `/home/` path or `*.howman.link` hostname in an added non-Markdown line (and none in shipped `AGENTS.md` either).
- **Every task ends:** `git diff --cached | grep -c '^+```'` prints 0 before the commit; commit with the explicit pathspec; then `git status --short` prints nothing and the task's tests pass on the committed tree.
- **Environment for every command** (`npm ci` once if `node_modules/` is absent):
  ```bash
  cd /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-684-remote-writes
  export PATH=/home/rnamwoh/.local/node24/bin:$PATH
  docker run -d --rm --name blz-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=blaze_test -p 127.0.0.1:55432:5432 postgres:17-alpine
  until docker exec blz-pg pg_isready -U postgres -d blaze_test; do sleep 1; done
  export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test
  ```
  Run Postgres tests with `--test-concurrency=1`.

## Findings that refine the spec (decided here, from the code)

1. **`POST /api/link` did not reach anything.** It has been classified `write` in `ROUTE_SCOPES` since BLZ-323, but `serve.mjs`'s POST handler had no branch for it, so a POST fell through to `404 not found` after the CSRF check. Task 2 adds the branch, calling `applyLink` (the verb `blaze link` runs) through the resolved port, and `docs/architecture.md`'s HTTP table stops listing it as a v4 artifact route.
2. **Only `blaze board` (`serve.mjs`) gets the endpoints and the exemption.** `blaze start` (`supervisor.mjs`) serves no `POST /api/*` write route at all — its writes are `/control/*` loop controls — so there is no twin to add. Its `/control/*` CSRF rule is deliberately unchanged (bearer callers still need the header there; no remote verb uses them, and `tests/supervisor-identity.test.mjs` keeps pinning it). The deployed board runs `serve.mjs`.
3. **The exemption needs a board with users.** `csrfRequired` exempts a bearer request only when `store` is set: on a loopback board with no users the gate judges nothing, so the header is the only control left (a browser would preflight a cross-origin `Authorization` header anyway, but the rule does not lean on that alone). Consequence: remote mode needs a board with users; against a no-user loopback board every remote write is `403 bad csrf token`. Documented in `commands.md`.
4. **"Cookie" means the `blaze_session` cookie.** An unrelated cookie (`theme=dark`) beside a bearer token does not make it a cookie request — only the ambient credential does. A session credential pasted into `Authorization` is not a bearer token (`bearerFrom` already refuses it), so it is never exempt.
5. **No `blaze ac` exists to forward.** Spec §5.4 lists `ac` among the remote verbs, but the CLI has no `ac` command (the AC toggle is a browser action on `POST /api/ac`). Remote mode forwards the six that exist — `new`, `move`, `edit`, `resolve`, `log`, `link`. Adding a CLI `ac` verb is out of this PR's scope.
6. **`POST /api/log` gains `date`.** The browser never sent one; `blaze log --date` does, so the remote verb would silently log today's date without it.
7. **The event log records the remote caller.** `applyNew` and `applyLink` passed no `actor`/`source` to the port (`move`/`log` already did), so a ticket created over HTTP would be logged `unknown`/`cli`. Both now take `actor` and `source` (defaults unchanged for the CLI), and the db-mode test pins `create`/`edit` events as `m@example.com (m@example.com initial token)` / `api`.
8. **Where the token may go, decided here:** `BLAZE_REMOTE_URL` must be the board's origin — `https://`, or `http://` for a loopback host only (a token in clear over the network is refused); no path, query, fragment or `user:pass@`. Every request is built as `new URL("/api/…", origin)` and re-checked against the origin; `fetch` runs with `redirect: "error"`. One function, `requestRemote`, sends the token, shared by the CLI and the proof harness.
9. **Half-set is an error for EVERY command**, including ones that would not use the network, and is decided before the schema preflight (there is no local board to judge in remote mode). `BLAZE_READONLY` is checked first and still refuses a write in remote mode.
10. **`/api/new` validates types at the boundary, everything else in `applyNew`.** Strings and string lists are taken only if they are strings (anything else is dropped, never coerced); `estimate` is `Number(...)`; an `InvalidProjectKeyError` (a malformed `project`) is a `422`, not a `500`. `start`/`due` are not accepted (the CLI refuses them as derived; the server ignores them).
11. **The proof harness creates real tickets** and never deletes; its doc says to run it against the rehearsal database. `verify` treats an empty set as a FAIL (a proof that created nothing proves nothing) and asks the server about every distinct id through `GET /api/panel?id=` (`read` scope).
12. **Postgres connection budget.** There is no pool (PR A's ADR-0038 addendum: measure first), and each request opens one connection; the CI proof runs 2 processes × `--parallel 5`, well inside `max_connections` 100. The harness defaults to `--parallel 8`.

## Review Focus

1. **A browser session that also carries a bearer token** (a developer's own browser with an extension adding `Authorization`) → treated as a cookie request: no CSRF header, `403`, nothing written. Pinned: Task 1 (`cookie + bearer, no CSRF header → 403…`).
2. **A token for a `viewer`, or a revoked/garbage token, used in remote mode** → `403` / `401` from the server, printed as the server's refusal, exit `1`, nothing created. Pinned: Task 1 (server), Task 3 (`an unauthenticated or read-scope caller is refused…`), Task 4 (`a refused create is counted as a failure…`).
3. **A misconfigured or hostile `BLAZE_REMOTE_URL`** (plain http to a LAN host, a path, credentials in the URL, a server that redirects) → refused before any request, or after one request to the configured origin only; the token never printed. Pinned: Task 3 (`a URL that could send the token anywhere else…`, `…a redirect elsewhere is refused, not followed`), Task 4 (`requestRemote never builds a URL off the configured origin`).
4. **An operator with only one variable exported in a shell** → every command refuses with both names, nothing written locally. Pinned: Task 3 (`…half-set refuses everything`).
5. **Two machines creating at the same instant against Postgres** → distinct ids, every row present, no gap the counter did not skip. Pinned: Task 4 (`spec §6: 2 processes × 50…`).

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `scripts/model/serve-auth.mjs` | 1, 2 | `csrfRequired`; `POST /api/new` classified `write` |
| `scripts/serve.mjs` | 1, 2 | the CSRF rule; `/api/new`, `/api/link`; `/api/log` `date` |
| `scripts/new.mjs`, `scripts/link.mjs` | 2 | `actor`/`source` reach the event |
| `scripts/remote-client.mjs` (new) | 3, 4 | `remoteFrom`, `requestFor`, `runRemote`, `requestRemote` |
| `scripts/cli.mjs` | 3 | remote-mode dispatch and refusals |
| `scripts/ops/concurrency-proof.mjs` (new) | 4 | the two-machine create/verify harness |
| `tests/serve-csrf-bearer.test.mjs`, `tests/serve-api-new.test.mjs`, `tests/remote-mode.test.mjs`, `tests/concurrency-proof.test.mjs` (new) | 1–4 | |
| `tests/serve-identity.test.mjs`, `tests/model/seam-closure.test.mjs` | 1, 2 | one reversed expectation (Task 1); one pinned name (Task 2) |
| `docs/decisions/0013-…md`, `docs/guide/commands.md`, `docs/architecture.md`, `AGENTS.md` | 1–4 | docs, in each task's own commit |

---

### Task 1: a bearer request skips the CSRF header; a cookie request never does

**Files:**
- Create: `tests/serve-csrf-bearer.test.mjs`
- Modify: `tests/serve-identity.test.mjs`
- Modify: `scripts/model/serve-auth.mjs`
- Modify: `scripts/serve.mjs`
- Modify: `docs/decisions/0013-identity-access-and-tokens.md`
- Modify: `docs/guide/commands.md`

**Interfaces:**
- Consumes: `bearerFrom(headers)`, `cookieFrom(headers, name)`, `SESSION_COOKIE` (`serve-auth.mjs`).
- Produces: `csrfRequired({ headers, store }) → boolean` (`serve-auth.mjs`) — `false` only when `store` is set, `bearerFrom(headers)` is non-empty, and there is no `blaze_session` cookie.

- [ ] **Step 1: Write the failing tests.**

Create `tests/serve-csrf-bearer.test.mjs`:

```js
// tests/serve-csrf-bearer.test.mjs — BLZ-684 (spec §5.4, ADR-0013's addendum).
//
// The CSRF header is forgery protection for an AMBIENT credential. A bearer token is not
// ambient, so a request the gate authenticated by bearer alone skips the header — that is what
// lets a CLI on another machine write over HTTP. Everything else keeps it, and this file pins
// every side of that line on a real server: cookie alone, cookie + bearer, no credential, a
// read-only token, and a loopback board with no users.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import { csrfRequired, SESSION_COOKIE } from "../scripts/model/serve-auth.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const PASSWORD = "correct horse battery staple";
const TICKET = join("projects", "OBA", "defined", "OBA-1.md");

/** A git-backed board (fs mode commits per op) holding OBA-1. */
function board() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz684-csrf-")));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  mkdirSync(join(root, "projects", "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  writeFileSync(join(root, TICKET),
    ["---", "id: OBA-1", "title: t", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

async function boot(root) {
  const server = startServer({ port: 0, root, projectsDir: join(root, "projects") });
  await new Promise((res) => server.once("listening", res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** A board with an admin who has a password (for a session cookie) and a bearer token. */
async function configured() {
  const root = board();
  const { token } = await addUser(root, { email: "op@example.com", role: "admin" });
  const id = loadIdentity(root);
  await id.store.setPassword({ email: "op@example.com", password: PASSWORD });
  id.close();
  const { server, base } = await boot(root);
  const signin = await fetch(`${base}/signin`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
    body: JSON.stringify({ email: "op@example.com", password: PASSWORD }),
  });
  assert.equal(signin.status, 200);
  const cookie = signin.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)).split(";")[0];
  return { root, server, base, bearer: token.token, cookie };
}

/** POST /api/edit setting OBA-1's priority, with exactly the headers given. */
const edit = (base, headers, priority = "high") => fetch(`${base}/api/edit`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ id: "OBA-1", patch: { priority } }),
});
const priorityOf = (root) => /priority: (\w+)/.exec(readFileSync(join(root, TICKET), "utf8"))[1];

describe("csrfRequired — the rule, as a function", () => {
  const store = {};
  test("a bearer token alone, on a board with users, is exempt", () => {
    assert.equal(csrfRequired({ headers: { authorization: "Bearer blz_x" }, store }), false);
  });
  test("a session cookie — alone or beside a bearer token — is not", () => {
    assert.equal(csrfRequired({ headers: { cookie: `${SESSION_COOKIE}=blz_sess.x` }, store }), true);
    assert.equal(csrfRequired({ headers: { authorization: "Bearer blz_x",
                                           cookie: `${SESSION_COOKIE}=blz_sess.x` }, store }), true);
  });
  test("no credential, a session pasted as a bearer, or a board with no users: required", () => {
    assert.equal(csrfRequired({ headers: {}, store }), true);
    assert.equal(csrfRequired({ headers: { authorization: "Bearer blz_sess.x" }, store }), true);
    assert.equal(csrfRequired({ headers: { authorization: "Bearer blz_x" }, store: null }), true);
  });
  test("an unrelated cookie does not make a bearer request a cookie request", () => {
    assert.equal(csrfRequired({ headers: { authorization: "Bearer blz_x", cookie: "theme=dark" }, store }), false);
  });
});

describe("on a real server", () => {
  test("bearer alone, no CSRF header → 200, and the write happened", async () => {
    const { root, server, base, bearer } = await configured();
    try {
      const r = await edit(base, { authorization: `Bearer ${bearer}` });
      assert.equal(r.status, 200, await r.text());
      assert.equal(priorityOf(root), "high");
    } finally { server.close(); }
  });

  test("a session cookie alone, no CSRF header → 403 and nothing written; WITH it → 200", async () => {
    const { root, server, base, cookie } = await configured();
    try {
      const r = await edit(base, { cookie });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /csrf/i);
      assert.equal(priorityOf(root), "medium");
      assert.equal((await edit(base, { cookie, "x-blaze-csrf": CSRF })).status, 200, "the check discriminates");
      assert.equal(priorityOf(root), "high");
    } finally { server.close(); }
  });

  test("cookie + bearer, no CSRF header → 403: a request carrying the cookie is a cookie request", async () => {
    const { root, server, base, bearer, cookie } = await configured();
    try {
      const r = await edit(base, { cookie, authorization: `Bearer ${bearer}` });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /csrf/i);
      assert.equal(priorityOf(root), "medium");
    } finally { server.close(); }
  });

  test("no credential → 401, with or without the CSRF header — the header is never a credential", async () => {
    const { root, server, base } = await configured();
    try {
      assert.equal((await edit(base, {})).status, 401);
      assert.equal((await edit(base, { "x-blaze-csrf": CSRF })).status, 401);
      assert.equal((await edit(base, { authorization: "Bearer blz_not-a-token" })).status, 401);
      assert.equal(priorityOf(root), "medium");
    } finally { server.close(); }
  });

  test("a read-scope token → 403 on a write, CSRF header or not", async () => {
    const root = board();
    const { token } = await addUser(root, { email: "v@example.com", role: "viewer" });
    const { server, base } = await boot(root);
    try {
      for (const headers of [{}, { "x-blaze-csrf": CSRF }]) {
        const r = await edit(base, { authorization: `Bearer ${token.token}`, ...headers });
        assert.equal(r.status, 403);
        assert.match((await r.json()).errors[0], /does not carry the 'write' scope/);
      }
      assert.equal(priorityOf(root), "medium");
    } finally { server.close(); }
  });

  test("a loopback board with NO users still requires the header, bearer or not", async () => {
    const root = board();
    const { server, base } = await boot(root);
    try {
      const r = await edit(base, { authorization: "Bearer blz_anything" });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /csrf/i);
      assert.equal(priorityOf(root), "medium");
    } finally { server.close(); }
  });
});
```

In `tests/serve-identity.test.mjs`, replace (1/2):

```js

  test("the CSRF header is retained as defence-in-depth: a valid token without it is still refused",
    async () => {
```

with:

```js

  // BLZ-684 (spec §5.4, ADR-0013's addendum) REVERSES this test's old expectation, on purpose:
  // a valid bearer token with no session cookie no longer needs the CSRF header — that is what
  // lets a CLI on another machine write. The cookie flow keeps the header; the cases that pin
  // it (cookie alone, cookie + bearer) live in tests/serve-csrf-bearer.test.mjs.
  test("a valid bearer token without the CSRF header — and no cookie — is accepted (BLZ-684)",
    async () => {
```

In `tests/serve-identity.test.mjs`, replace (2/2):

```js
        });
        assert.equal(r.status, 403);
        assert.match((await r.json()).errors[0], /csrf/i);
      } finally { server.close(); }
```

with:

```js
        });
        assert.equal(r.status, 200, await r.text());
      } finally { server.close(); }
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/serve-csrf-bearer.test.mjs tests/serve-identity.test.mjs
```

Expected: `tests 20, pass 18, fail 2` — `tests/serve-csrf-bearer.test.mjs` fails to load (`does not provide an export named 'csrfRequired'`), and `serve-identity`'s reversed test (`a valid bearer token without the CSRF header — and no cookie — is accepted (BLZ-684)`) fails with `403`.

- [ ] **Step 3: Implement.**

In `scripts/model/serve-auth.mjs`, replace:

```js
/**
 * Decide one request.
```

with:

```js
/**
 * BLZ-684 (spec §5.4, ADR-0013 §7 and its addendum): does this request have to carry the
 * `x-blaze-csrf` header?
 *
 * CSRF is forgery of an AMBIENT credential — one the browser attaches by itself. A bearer
 * token in `Authorization` is not ambient: a foreign page cannot attach it, and attaching any
 * custom header makes a cross-origin request preflighted, which this server never approves.
 * So a request is exempt only when ALL of these hold:
 *   - the board has users (`store`), so the gate actually judged the bearer token — on a
 *     loopback board with no users the gate asks for nothing, and the header is all there is;
 *   - a bearer token was presented (`bearerFrom` — a session pasted into it does not count);
 *   - NO session cookie rides along. A request carrying both is treated as a cookie request:
 *     the cookie is the browser's ambient credential, and its presence means a browser may be
 *     the one asking.
 */
export function csrfRequired({ headers, store }) {
  if (!store) return true;
  if (!bearerFrom(headers)) return true;
  return cookieFrom(headers, SESSION_COOKIE) !== "";
}

/**
 * Decide one request.
```

In `scripts/serve.mjs`, replace (1/2):

```js
import { dbTransitions } from "./model/transitions-db.mjs";
import { checkBindSafety, gate, pageScopeFor } from "./model/serve-auth.mjs";
import { loadIdentity } from "./model/identity-db.mjs";
```

with:

```js
import { dbTransitions } from "./model/transitions-db.mjs";
import { checkBindSafety, gate, pageScopeFor, csrfRequired } from "./model/serve-auth.mjs";
import { loadIdentity } from "./model/identity-db.mjs";
```

In `scripts/serve.mjs`, replace (2/2):

```js
      // that asks for a credential. It is removed with the last cookie, not before.
      if (req.headers["x-blaze-csrf"] !== CSRF) return json(403, { errors: ["bad csrf token"] });
      // BLZ-121 defence-in-depth, checked here (before any apply* call below,
```

with:

```js
      // that asks for a credential. It is removed with the last cookie, not before.
      // BLZ-684: a request the gate authenticated by bearer token alone — no session cookie
      // beside it — is exempt (`csrfRequired`, ADR-0013's addendum): the token is not
      // ambient, and that is what lets a CLI on another machine write over HTTP.
      if (csrfRequired({ headers: req.headers, store }) && req.headers["x-blaze-csrf"] !== CSRF) {
        return json(403, { errors: ["bad csrf token"] });
      }
      // BLZ-121 defence-in-depth, checked here (before any apply* call below,
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/serve-csrf-bearer.test.mjs tests/serve-identity.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/serve*.test.mjs tests/supervisor*.test.mjs tests/signin*.test.mjs tests/setup*.test.mjs tests/event-actor.test.mjs tests/model/serve-auth*.test.mjs tests/model/seam-closure.test.mjs
```

Expected: `tests 29, suites 7, pass 29`, and every neighbour green — `tests/supervisor-identity.test.mjs` still requires the header on `/control/*` from a bearer caller (Finding 2). Discrimination: with Step 3's `serve.mjs` change reverted, `bearer alone, no CSRF header → 200…` and the reversed `serve-identity` test fail.

- [ ] **Step 5: Docs, in the same commit.**

In `docs/decisions/0013-identity-access-and-tokens.md`, replace:

```markdown
and per-project roles. The schema anticipates them; none is built.
```

with:

```markdown
and per-project roles. The schema anticipates them; none is built.

## Addendum (2026-10-10, BLZ-684) — a bearer request skips the CSRF header; a cookie request never does

§7 says the CSRF check is "retained only while any part of the browser flow uses a cookie".
That stays true for the cookie, and BLZ-684 (the live-board cutover's remote writes, spec
§5.4) draws the line per REQUEST instead of per server: `blaze board`'s `POST /api/*` handler
skips the `x-blaze-csrf` check when, and only when, `csrfRequired` (`serve-auth.mjs`) says so:

- the board has users, so the gate actually judged the token — on a loopback board with no
  users the gate asks for nothing and the header is the only control left, so it stays;
- an `Authorization: Bearer` token was presented (a session credential pasted there is not one);
- and **no** `blaze_session` cookie rides along. A request carrying both is a cookie request,
  CSRF required: the cookie is the ambient credential, and its presence means a browser may be
  the one asking.

Why this is safe: a foreign page cannot attach an `Authorization` header to a cross-site
request, and any custom header makes the request preflighted, which this server never
approves. Why it is needed: a CLI on another machine (`BLAZE_REMOTE_URL` + `BLAZE_TOKEN`) has
no page to read the per-process CSRF value from. `tests/serve-csrf-bearer.test.mjs` pins every
side of the line: cookie alone without the header → 403, cookie + bearer → 403, no credential →
401 (the header is never a credential), a read-scope token → 403, a no-user loopback board →
403. `blaze start`'s `/control/*` routes are unchanged — they still require the header from
every caller; no remote verb uses them.
```

In `docs/guide/commands.md`, replace:

```markdown
forgery protection for the browser flow, retained as defence-in-depth alongside the token
check, never as a substitute for it. `blaze start` also requires it on `/control/*`,
where it is the only control that covers a loopback board with no users at all: the gate
```

with:

```markdown
forgery protection for the browser flow, retained as defence-in-depth alongside the token
check, never as a substitute for it. On `blaze board`'s `POST /api/*` a request authenticated
by an `Authorization: Bearer` token with **no** session cookie skips it (BLZ-684, ADR-0013's
addendum) — the token is not ambient, and that is how a CLI on another machine writes; a
request that carries the `blaze_session` cookie, with or without a bearer token, still needs
it, and so does every request on a board with no users. `blaze start` also requires it on `/control/*`,
where it is the only control that covers a loopback board with no users at all: the gate
```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/serve-csrf-bearer.test.mjs tests/serve-identity.test.mjs scripts/model/serve-auth.mjs scripts/serve.mjs docs/decisions/0013-identity-access-and-tokens.md docs/guide/commands.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-684: a bearer-authenticated request skips the CSRF header; a cookie request never does" -m "serve-auth.mjs gains csrfRequired (exempt only for a judged bearer token with no session cookie); serve.mjs's POST handler uses it. New tests/serve-csrf-bearer.test.mjs pins cookie-only 403, cookie+bearer 403, no credential 401, read token 403, no-user board 403; serve-identity's bearer-without-CSRF expectation is reversed per spec 5.4. ADR-0013 addendum; commands.md." -- tests/serve-csrf-bearer.test.mjs tests/serve-identity.test.mjs scripts/model/serve-auth.mjs scripts/serve.mjs docs/decisions/0013-identity-access-and-tokens.md docs/guide/commands.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/serve-csrf-bearer.test.mjs tests/serve-identity.test.mjs   # green on the COMMITTED tree
```


---

### Task 2: `POST /api/new` and `POST /api/link` on `blaze board`

**Files:**
- Create: `tests/serve-api-new.test.mjs`
- Modify: `tests/model/seam-closure.test.mjs`
- Modify: `scripts/link.mjs`
- Modify: `scripts/model/serve-auth.mjs`
- Modify: `scripts/new.mjs`
- Modify: `scripts/serve.mjs`
- Modify: `docs/architecture.md`
- Modify: `docs/guide/commands.md`

**Interfaces:**
- Consumes: Task 1's CSRF rule (a bearer caller needs no header); `applyNew`, `applyLink`; the POST handler's per-request `resolvePorts`, `stageFor`, `actor`.
- Produces: `POST /api/new` (`write`) — body `{ project, type, title, estimate?, priority?, labels?: string[], components?: string[], parent?, assignee?, likelihood?, impact?, sprint?, not_before?, deadline?, reason? }` → `200 { ok: true, id, warnings, committed, queued, db }` or `422 { errors }`. `POST /api/link` (`write`) — `{ id, type, target, remove? }` → `200 { ok: true, committed, queued, db }` or `422`. `POST /api/log` also takes `date`. `applyNew(…, { actor, source })` and `applyLink(…, { actor, source })` pass both to the write port (defaults `"unknown"`, `"cli"`).

- [ ] **Step 1: Write the failing tests.**

In `tests/model/seam-closure.test.mjs`, replace:

```js
    "ensureIdentityIgnored", "addUser", "stageFor", "loadIdentity", "reconcile",
    "resolvePorts", "pageHtml", "viewEnvelope"]],
  ["user-runner.mjs", ["ensureIdentityIgnored", "addUser", "setUserPassword"]],
```

with:

```js
    "ensureIdentityIgnored", "addUser", "stageFor", "loadIdentity", "reconcile",
    "resolvePorts", "pageHtml", "viewEnvelope",
    // BLZ-684: `POST /api/new` runs `blaze new`'s own verb, on exactly new-runner.mjs's footing.
    "applyNew"]],
  ["user-runner.mjs", ["ensureIdentityIgnored", "addUser", "setUserPassword"]],
```

Create `tests/serve-api-new.test.mjs`:

```js
// tests/serve-api-new.test.mjs — BLZ-684 (spec §5.4): `POST /api/new` creates a ticket through
// the resolved write port, and `POST /api/link` — classified `write` since BLZ-323 but answered
// by no handler — reaches the ticket-link verb. Both record WHO in the event log (ADR-0013 §6).
// fs mode runs on a git board (per-op commits); db mode on the SQLite shadow.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { openSqliteRead } from "../scripts/model/sqlite-storage.mjs";
import { shadowDbPath } from "../scripts/model/write-port-resolve.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";

const scratch = scratchRegistry();

function gitBoard() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz684-new-")));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  mkdirSync(join(root, "projects", "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  writeFileSync(join(root, "projects", "OBA", "defined", "OBA-1-one.md"),
    ["---", "id: OBA-1", "title: one", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { dataRoot: root, projectsDir: join(root, "projects") };
}

async function serve(roots) {
  const server = startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir });
  await new Promise((res) => server.once("listening", res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, path, body, token) => fetch(`${base}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

describe("fs mode", () => {
  test("POST /api/new creates the ticket, commits it, and answers { ok, id }", async () => {
    const roots = gitBoard();
    const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    const { server, base } = await serve(roots);
    try {
      const r = await post(base, "/api/new", { project: "OBA", type: "task", title: "made remotely",
        estimate: 30, labels: ["x"], priority: "high" }, token.token);
      const body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.id, "OBA-2");
      assert.equal(body.committed, true);
      const file = join(roots.projectsDir, "OBA", "defined", "OBA-2-made-remotely.md");
      assert.ok(existsSync(file));
      const text = readFileSync(file, "utf8");
      assert.match(text, /priority: high/);
      assert.match(text, /labels: \[x\]/);
      assert.match(execFileSync("git", ["-C", roots.dataRoot, "log", "-1", "--format=%s"], { encoding: "utf8" }),
                   /OBA-2: create task/);
    } finally { server.close(); }
  });

  test("POST /api/new refuses what `blaze new` refuses, as a 422 naming why", async () => {
    const roots = gitBoard();
    const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    const { server, base } = await serve(roots);
    try {
      for (const [body, why] of [
        [{ project: "OBA", type: "task", title: "no estimate" }, /estimate/],
        [{ project: "OBA", type: "nonsense", title: "t" }, /unknown or missing type/],
        [{ project: "OBA", type: "task", estimate: 30 }, /missing title/],
        [{ project: "o(", type: "task", title: "t", estimate: 30 }, /o\(/],
      ]) {
        const r = await post(base, "/api/new", body, token.token);
        assert.equal(r.status, 422, JSON.stringify(body));
        assert.match((await r.json()).errors.join(" "), why);
      }
      assert.equal(existsSync(join(roots.projectsDir, "OBA", "defined", "OBA-2-t.md")), false);
    } finally { server.close(); }
  });

  test("POST /api/new with no credential → 401; with a read-scope token → 403; nothing created", async () => {
    const roots = gitBoard();
    const { token } = await addUser(roots.dataRoot, { email: "v@example.com", role: "viewer" });
    const { server, base } = await serve(roots);
    try {
      const body = { project: "OBA", type: "task", title: "nope", estimate: 30 };
      assert.equal((await post(base, "/api/new", body)).status, 401);
      const viewer = await post(base, "/api/new", body, token.token);
      assert.equal(viewer.status, 403);
      assert.match((await viewer.json()).errors[0], /does not carry the 'write' scope/);
      assert.equal(existsSync(join(roots.projectsDir, "OBA", "defined", "OBA-2-nope.md")), false);
    } finally { server.close(); }
  });

  test("POST /api/link reaches the ticket-link verb: add, refuse an unknown type, remove", async () => {
    const roots = gitBoard();
    const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    const { server, base } = await serve(roots);
    try {
      assert.equal((await post(base, "/api/new", { project: "OBA", type: "task", title: "two", estimate: 30 },
                                token.token)).status, 200);
      const add = await post(base, "/api/link", { id: "OBA-1", type: "Relates", target: "OBA-2" }, token.token);
      assert.equal(add.status, 200, await add.text());
      const file = join(roots.projectsDir, "OBA", "defined", "OBA-1-one.md");
      assert.match(readFileSync(file, "utf8"), /type: Relates, target: OBA-2/);
      const bad = await post(base, "/api/link", { id: "OBA-1", type: "Nonsense", target: "OBA-2" }, token.token);
      assert.equal(bad.status, 422);
      assert.match((await bad.json()).errors[0], /unknown link type/);
      const rm = await post(base, "/api/link", { id: "OBA-1", type: "Relates", target: "OBA-2", remove: true }, token.token);
      assert.equal(rm.status, 200);
      assert.doesNotMatch(readFileSync(file, "utf8"), /target: OBA-2/);
    } finally { server.close(); }
  });

  test("POST /api/log honours `date`, so the remote `blaze log --date` is the local one", async () => {
    const roots = gitBoard();
    const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    const { server, base } = await serve(roots);
    try {
      const r = await post(base, "/api/log", { id: "OBA-1", minutes: 20, date: "2026-02-03", note: "n" }, token.token);
      assert.equal(r.status, 200, await r.text());
      assert.match(readFileSync(join(roots.projectsDir, "OBA", "defined", "OBA-1-one.md"), "utf8"),
                   /date: 2026-02-03, minutes: 20, note: n/);
    } finally { server.close(); }
  });
});

test("db mode: /api/new takes its id from the counter and /api/link writes the row; the events say who",
  async () => {
    const roots = dbBoard();
    assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
    const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    const before = process.env.BLAZE_WRITE_PORT;
    process.env.BLAZE_WRITE_PORT = "db";
    const { server, base } = await serve(roots);
    try {
      const r = await post(base, "/api/new", { project: "ENG", type: "task", title: "from afar", estimate: 15 }, token.token);
      const body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.deepEqual([body.id, body.db, body.committed], ["ENG-2", true, false]);
      assert.equal(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-2-from-afar.md")), false,
                   "under db a ticket is a row, never a file");
      const l = await post(base, "/api/link", { id: "ENG-2", type: "Blocks", target: "ENG-1" }, token.token);
      assert.equal(l.status, 200, await l.text());
      const rs = openSqliteRead(shadowDbPath(roots.dataRoot));
      try {
        assert.deepEqual(rs.getTicket(null, "ENG-2").found.frontmatter.links, [{ type: "Blocks", target: "ENG-1" }]);
        const actors = rs.listEvents(null, "ENG-2").map((e) => [e.kind, e.actor, e.source]);
        assert.deepEqual(actors, [["create", "m@example.com (m@example.com initial token)", "api"],
                                  ["edit", "m@example.com (m@example.com initial token)", "api"]]);
      } finally { rs.close(); }
    } finally {
      server.close();
      if (before === undefined) delete process.env.BLAZE_WRITE_PORT; else process.env.BLAZE_WRITE_PORT = before;
    }
  });
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/serve-api-new.test.mjs tests/model/seam-closure.test.mjs
```

Expected: `tests 27, pass 20, fail 7` — all six `serve-api-new` tests (`/api/new` is an unknown endpoint → `404`; `/api/link` answers `404 not found`; the log ignores `date`), and `seam-closure`'s "the write-seam scan OBSERVED the corpus, and its allowlist is all load-bearing" (`serve.mjs :: applyNew` is named but not yet reached).

- [ ] **Step 3: Implement.**

In `scripts/link.mjs`, replace:

```js
  if (today) fm.updated = today;
  const { file } = await writePort.write({
    project: found.project, status: found.status,
    frontmatter: fm, body: found.body, currentFile: found.file,
  });
  return { ok: true, id, file };
```

with:

```js
  if (today) fm.updated = today;
  // BLZ-684: the event records who, as move/log already do (ADR-0013 §6).
  const { file } = await writePort.write({
    project: found.project, status: found.status,
    frontmatter: fm, body: found.body, currentFile: found.file,
  }, { actor: opts.actor ?? "unknown", source: opts.source ?? "cli" });
  return { ok: true, id, file };
```

In `scripts/model/serve-auth.mjs`, replace:

```js
  "POST /api/ac": "write",

```

with:

```js
  "POST /api/ac": "write",
  // BLZ-684: creating a ticket over HTTP — the remote CLI's `blaze new`.
  "POST /api/new": "write",

```

In `scripts/new.mjs`, replace:

```js
  // never overwritten (the db port's rule; the fs port ignores the context).
  const { file } = await writePort.write(target, { create: true });
  const warnings = warnMissingRequired(frontmatter, project_cfg, { reason: extra.reason ?? null });
```

with:

```js
  // never overwritten (the db port's rule; the fs port ignores the context).
  // BLZ-684: `actor`/`source` reach the event log as every other verb's do, so a ticket created
  // over `POST /api/new` records WHO (ADR-0013 §6); a CLI create keeps "unknown" and "cli".
  const { file } = await writePort.write(target,
    { create: true, actor: opts.actor ?? "unknown", source: opts.source ?? "cli" });
  const warnings = warnMissingRequired(frontmatter, project_cfg, { reason: extra.reason ?? null });
```

In `scripts/serve.mjs`, replace (1/3):

```js
import { applyEdit, applyToggleAc } from "./edit.mjs";
import { stageFor } from "./commit-or-queue.mjs";
```

with:

```js
import { applyEdit, applyToggleAc } from "./edit.mjs";
import { applyNew } from "./new.mjs";
import { applyLink } from "./link.mjs";
import { stageFor } from "./commit-or-queue.mjs";
```

In `scripts/serve.mjs`, replace (2/3):

```js
      if (u.pathname === "/api/log") {
        const r = await applyLog(projectsDir, payload.id, payload.minutes, { note: payload.note ?? null, today, writePort, readStorage, actor, source: "api" });
        return done(r, `${payload.id}: log ${payload.minutes}m`, "log");
```

with:

```js
      if (u.pathname === "/api/log") {
        // BLZ-684: `date` too, so the remote `blaze log --date` means what the local one does.
        const r = await applyLog(projectsDir, payload.id, payload.minutes, { note: payload.note ?? null, date: payload.date ?? null, today, writePort, readStorage, actor, source: "api" });
        return done(r, `${payload.id}: log ${payload.minutes}m`, "log");
```

In `scripts/serve.mjs`, replace (3/3):

```js
        return done(r, `${payload.id}: ac[${payload.index}]=${payload.checked ? "x" : " "}`, "ac");
      }
```

with:

```js
        return done(r, `${payload.id}: ac[${payload.index}]=${payload.checked ? "x" : " "}`, "ac");
      }
      if (u.pathname === "/api/new") {
        // BLZ-684 (spec §5.4): `blaze new` over HTTP. The same `applyNew` the CLI runs, through
        // the RESOLVED port — so under db the id comes from project_counter's transactional
        // allocate, and two machines creating at once can never be handed the same number.
        // Only the fields `blaze new` takes; strings and string lists are checked here, the
        // rest (types, taxonomy, required fields, the parent rule) is applyNew's to refuse.
        const p = payload && typeof payload === "object" ? payload : {};
        const str = (v) => (typeof v === "string" ? v : undefined);
        const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
        const extra = {};
        for (const k of ["parent", "assignee", "likelihood", "impact", "reason", "sprint", "not_before", "deadline"]) {
          if (str(p[k]) !== undefined) extra[k] = p[k];
        }
        if (p.components !== undefined) extra.components = list(p.components);
        if (p.estimate !== undefined) extra.estimate = Number(p.estimate);
        let r;
        try {
          r = await applyNew(projectsDir, { project: str(p.project), type: str(p.type), title: str(p.title),
            priority: str(p.priority) ?? "medium", labels: list(p.labels), extra, today,
            writePort, readStorage, actor, source: "api" });
        } catch (e) {
          // A malformed project key throws (InvalidProjectKeyError, BLZ-402): the caller's input
          // was refused, so it is a 422 like any other refusal — never a 500.
          if (e?.name === "InvalidProjectKeyError") return json(422, { errors: [e.message] });
          throw e;
        }
        if (!r.ok) return json(422, { errors: r.errors });
        const c = stageFor(mode)({ root, mode: cfgFor(root).commitMode, op: "new", id: r.id,
          message: `${r.id}: create ${r.type}`, files: [r.file, r.claimFile].filter(Boolean), lockOpts: LOCK_OPTS });
        if (commitFailed(c)) return;
        return json(200, { ok: true, id: r.id, warnings: r.warnings, ...gitOutcome(c) });
      }
      if (u.pathname === "/api/link") {
        // BLZ-684: classified `write` in ROUTE_SCOPES since BLZ-323, and answered by NO handler
        // here — a POST reached the 404 below. The ticket-link verb, through the resolved port.
        const r = await applyLink(projectsDir, payload.id,
          { type: payload.type, target: payload.target, remove: payload.remove === true },
          { today, writePort, readStorage, actor, source: "api" });
        return done(r, `${payload.id}: ${payload.remove === true ? "unlink" : "link"} ${payload.type} ${payload.target}`, "link");
      }
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/serve-api-new.test.mjs tests/model/seam-closure.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/serve*.test.mjs tests/supervisor*.test.mjs tests/event-actor.test.mjs tests/model/serve-auth*.test.mjs tests/model/artifact-api.test.mjs tests/new*.test.mjs tests/link*.test.mjs tests/verbs-*.test.mjs tests/reserve-window.test.mjs
```

Expected: `tests 27, suites 1, pass 27`, and every neighbour green (`serve-auth.test.mjs`'s "no mutating route is free" sees `POST /api/new` at `write`).

- [ ] **Step 5: Docs, in the same commit.**

In `docs/architecture.md`, replace:

```markdown
| GET | `/api/matrix` · `/api/coverage` | `read` | v4 traceability matrix and coverage (BLZ-323) |
| POST | `/api/move` · `/api/edit` · `/api/resolve` · `/api/log` · `/api/ac` | `write` | Mutations — each validates through the model core, writes one file, commits it locally (never `git add -A`, never auto-push). The response carries `committed` and `queued` alongside `ok`: an idempotent re-write (editing a field to the value it already holds, re-checking a checked box) is a benign no-op that creates no commit, and `ok: true` alone never meant one existed (BLZ-422). It also carries `db`: `true` under `BLAZE_WRITE_PORT=db`, where the database is the store, no commit is made, and the page therefore does not read `committed: false` as "already matched HEAD" (BLZ-670) |
| POST | `/api/artifact` · `/api/link` · `/api/baseline` | `write` | v4 artifact model mutations (BLZ-323) |
| POST | `/api/field` | `admin` | Defining a filterable field emits `ALTER TABLE` and spends the install-wide field budget ADR-0018 shares across every project — an administrative act, not an ordinary write |
```

with:

```markdown
| GET | `/api/matrix` · `/api/coverage` | `read` | v4 traceability matrix and coverage (BLZ-323) |
| POST | `/api/move` · `/api/edit` · `/api/resolve` · `/api/log` · `/api/ac` | `write` | Mutations (`/api/log` takes an optional `date`, BLZ-684) — each validates through the model core, writes one file, commits it locally (never `git add -A`, never auto-push). The response carries `committed` and `queued` alongside `ok`: an idempotent re-write (editing a field to the value it already holds, re-checking a checked box) is a benign no-op that creates no commit, and `ok: true` alone never meant one existed (BLZ-422). It also carries `db`: `true` under `BLAZE_WRITE_PORT=db`, where the database is the store, no commit is made, and the page therefore does not read `committed: false` as "already matched HEAD" (BLZ-670) |
| POST | `/api/new` | `write` | Create a ticket (BLZ-684): `{ project, type, title, estimate?, priority?, labels?, components?, parent?, assignee?, likelihood?, impact?, sprint?, not_before?, deadline?, reason? }` → `{ ok, id, warnings, committed, queued, db }`. The same `applyNew` `blaze new` runs, through the resolved port — under `db` the id comes from `project_counter`'s transactional allocate. A refusal is a `422` naming why |
| POST | `/api/link` | `write` | Add or (`remove: true`) remove a typed link between two tickets — `{ id, type, target, remove? }`, the ticket-link verb `blaze link` runs (BLZ-684; classified since BLZ-323, answered by no handler until then) |
| POST | `/api/artifact` · `/api/baseline` | `write` | v4 artifact model mutations (BLZ-323) |
| POST | `/api/field` | `admin` | Defining a filterable field emits `ALTER TABLE` and spends the install-wide field budget ADR-0018 shares across every project — an administrative act, not an ordinary write |
```

In `docs/guide/commands.md`, replace:

```markdown
Serves the read/write dashboard at `/` plus the `/api/*` endpoints (move,
edit, resolve, log, acceptance-criteria toggle). Parses no CLI args.

```

with:

```markdown
Serves the read/write dashboard at `/` plus the `/api/*` endpoints (move,
edit, resolve, log, acceptance-criteria toggle, and — for the remote CLI, BLZ-684 — new and
link). Parses no CLI args.

```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/model/seam-closure.test.mjs tests/serve-api-new.test.mjs scripts/link.mjs scripts/model/serve-auth.mjs scripts/new.mjs scripts/serve.mjs docs/architecture.md docs/guide/commands.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-684: POST /api/new and POST /api/link on blaze board" -m "serve.mjs's POST handler gains /api/new (applyNew through the resolved port; under db the id comes from project_counter) and /api/link (applyLink — classified since BLZ-323, never answered), and /api/log takes date; ROUTE_SCOPES classifies /api/new write; applyNew and applyLink pass actor/source to the port; seam-closure pins serve.mjs taking applyNew. New tests/serve-api-new.test.mjs; architecture.md HTTP table, commands.md." -- tests/model/seam-closure.test.mjs tests/serve-api-new.test.mjs scripts/link.mjs scripts/model/serve-auth.mjs scripts/new.mjs scripts/serve.mjs docs/architecture.md docs/guide/commands.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/serve-api-new.test.mjs tests/model/seam-closure.test.mjs   # green on the COMMITTED tree
```


---

### Task 3: `blaze` remote mode — `BLAZE_REMOTE_URL` + `BLAZE_TOKEN`

**Files:**
- Create: `tests/remote-mode.test.mjs`
- Create: `scripts/remote-client.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `AGENTS.md`
- Modify: `docs/guide/commands.md`

**Interfaces:**
- Consumes: Task 2's endpoints; `isLoopback` (`serve-auth.mjs`).
- Produces (`scripts/remote-client.mjs`): `REMOTE_URL_ENV`, `REMOTE_TOKEN_ENV`; `REMOTE_VERBS = { new, move, edit, resolve, log, link }` (verb → path); `remoteFrom(env) → { remote: false } | { remote: true, origin, token } | { error }`; `requestFor(verb, argv) → { path, body } | { error }`; `successLine(verb, body, answer, origin) → string`; `runRemote(verb, argv, { env, fetch, out, err }) → Promise<exit code>`. `cli.mjs` routes the six verbs to `runRemote` when both variables are set, refuses every other command, and refuses everything when only one is set.

- [ ] **Step 1: Write the failing tests.**

Create `tests/remote-mode.test.mjs`:

```js
// tests/remote-mode.test.mjs — BLZ-684 (spec §5.4): `blaze` in remote mode.
//
// With BLAZE_REMOTE_URL + BLAZE_TOKEN set, the six ticket verbs go to the board server over
// HTTP; every other command is refused; half-set is an error. The security half is pinned as
// carefully as the happy path: the token is only ever sent to BLAZE_REMOTE_URL's origin — not
// over plain http to a non-loopback host, not to a URL with a path, and not after a redirect.
// The CLI test is end to end: a real `blaze` process against a real server on an ephemeral port.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startServer } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { remoteFrom, requestFor, runRemote, REMOTE_VERBS } from "../scripts/remote-client.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");

describe("remoteFrom — when remote mode is on, and when it refuses", () => {
  const env = (url, token) => ({ BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token });
  test("neither set: local; both set: remote, to the origin only", () => {
    assert.deepEqual(remoteFrom({}), { remote: false });
    assert.deepEqual(remoteFrom(env("", "")), { remote: false });
    assert.deepEqual(remoteFrom(env("https://blaze.example.com", "blz_t")),
                     { remote: true, origin: "https://blaze.example.com", token: "blz_t" });
    assert.deepEqual(remoteFrom(env("https://blaze.example.com/", "blz_t")).origin, "https://blaze.example.com");
    assert.deepEqual(remoteFrom(env("http://127.0.0.1:4321", "blz_t")).origin, "http://127.0.0.1:4321");
    assert.deepEqual(remoteFrom(env("http://localhost:4321", "blz_t")).origin, "http://localhost:4321");
  });
  test("half-set is an error naming both variables — never a fallback to local", () => {
    for (const e of [env("https://blaze.example.com", ""), env("", "blz_t"), { BLAZE_TOKEN: "blz_t" }]) {
      assert.match(remoteFrom(e).error, /needs both BLAZE_REMOTE_URL and BLAZE_TOKEN.*Refusing rather than writing to a local board/);
    }
  });
  test("a URL that could send the token anywhere else is refused", () => {
    for (const [url, why] of [
      ["http://blaze.example.com", /plain http to blaze\.example\.com/],
      ["ftp://blaze.example.com", /must be an https:\/\/ URL/],
      ["https://user:pw@blaze.example.com", /must not carry a user:password@/],
      ["https://blaze.example.com/board", /origin only/],
      ["https://blaze.example.com/?x=1", /origin only/],
      ["not a url", /is not a URL/],
    ]) {
      const r = remoteFrom(env(url, "blz_secret"));
      assert.match(r.error, why, url);
      assert.doesNotMatch(r.error, /blz_secret/, "a refusal never prints the token");
    }
    assert.match(remoteFrom(env("https://blaze.example.com", "blz a")).error, /whitespace/);
  });
});

describe("requestFor — argv parsed as the local runner parses it", () => {
  test("each verb maps to its endpoint and body", () => {
    assert.deepEqual(requestFor("new", ["--project", "ENG", "--type", "task", "Do", "it", "--estimate", "30",
                                        "--labels", "a,b", "--parent", "ENG-1", "--not-before", "2026-11-01"]),
      { path: "/api/new", body: { project: "ENG", type: "task", estimate: 30, labels: ["a", "b"],
                                  parent: "ENG-1", not_before: "2026-11-01", title: "Do it" } });
    assert.deepEqual(requestFor("move", ["ENG-1", "done"]), { path: "/api/move", body: { id: "ENG-1", to: "done" } });
    assert.deepEqual(requestFor("edit", ["ENG-1", "title", "a", "--b"]),
                     { path: "/api/edit", body: { id: "ENG-1", patch: { title: "a --b" } } });
    assert.deepEqual(requestFor("resolve", ["ENG-1", "wont-do"]),
                     { path: "/api/resolve", body: { id: "ENG-1", resolution: "wont-do" } });
    assert.deepEqual(requestFor("log", ["ENG-1", "25", "--date", "2026-10-01", "--note", "n"]),
                     { path: "/api/log", body: { id: "ENG-1", minutes: 25, date: "2026-10-01", note: "n" } });
    assert.deepEqual(requestFor("link", ["--rm", "ENG-1", "Blocks", "ENG-2"]),
                     { path: "/api/link", body: { id: "ENG-1", type: "Blocks", target: "ENG-2", remove: true } });
    assert.deepEqual(Object.keys(REMOTE_VERBS), ["new", "move", "edit", "resolve", "log", "link"]);
  });
  test("a missing argument, an unknown flag, or a derived field is refused before any request", () => {
    for (const [verb, argv, why] of [
      ["new", ["--project", "ENG", "x"], /usage: blaze new/],
      ["new", ["--project", "ENG", "--type", "task", "x", "--start", "2026-01-01"], /--start is derived by the scheduler; pass --not-before/],
      ["new", ["--bogus"], /unknown flag: --bogus/],
      ["move", ["ENG-1"], /usage: blaze move/],
      ["move", ["ENG-1", "--x"], /unknown flag/],
      ["edit", ["ENG-1", "title"], /usage: blaze edit/],
      ["log", ["ENG-1"], /usage: blaze log/],
      ["link", ["--rm", "ENG-1", "Blocks"], /usage: blaze link/],
      ["audit", [], /not available in remote mode/],
      ["constructor", [], /not available in remote mode/],
    ]) {
      assert.match(requestFor(verb, argv).error, why, `${verb} ${argv.join(" ")}`);
    }
  });
});

// --- against a real server -------------------------------------------------------------------
function gitBoard() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz684-remote-")));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  mkdirSync(join(root, "projects", "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  writeFileSync(join(root, "projects", "OBA", "defined", "OBA-1-one.md"),
    ["---", "id: OBA-1", "title: one", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}
async function board(role = "member") {
  const root = gitBoard();
  const { token } = await addUser(root, { email: "r@example.com", role });
  const server = startServer({ port: 0, root, projectsDir: join(root, "projects") });
  await new Promise((res) => server.once("listening", res));
  return { root, server, url: `http://127.0.0.1:${server.address().port}`, token: token.token };
}
const capture = () => {
  const out = [], err = [];
  return { out, err, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } };
};
/** `blaze <args>` as a real process — async, so the in-process server can answer it. */
function blaze(args, env, cwd) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    for (const k of ["BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_PROJECTS_DIR"]) delete base[k];
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("runRemote drives all six verbs against the server, and the board changes", async () => {
  const { root, server, url, token } = await board();
  try {
    const env = { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token };
    const run = async (verb, argv) => {
      const c = capture();
      const code = await runRemote(verb, argv, { env, ...c.io });
      return { code, out: c.out.join("\n"), err: c.err.join("\n") };
    };
    const made = await run("new", ["--project", "OBA", "--type", "task", "--estimate", "30", "Remote", "two"]);
    assert.equal(made.code, 0, made.err);
    assert.equal(made.out, `created OBA-2 (remote: ${url})`);
    assert.equal((await run("move", ["OBA-2", "in-progress"])).code, 0);
    assert.equal((await run("edit", ["OBA-2", "priority", "high"])).code, 0);
    assert.equal((await run("log", ["OBA-2", "15", "--note", "n"])).code, 0);
    assert.equal((await run("link", ["OBA-2", "Relates", "OBA-1"])).code, 0);
    assert.equal((await run("resolve", ["OBA-2", "wont-do"])).code, 0);
    const text = readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-2-remote-two.md"), "utf8");
    for (const want of [/priority: high/, /minutes: 15, note: n/, /type: Relates, target: OBA-1/, /resolution: wont-do/]) {
      assert.match(text, want);
    }
    const refused = await run("move", ["OBA-2", "nowhere"]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /blaze move failed \(http:\/\/127\.0\.0\.1:\d+ answered 422\)/);
  } finally { server.close(); }
});

test("end to end: `blaze new` in remote mode, a real process against a real server", async () => {
  const { server, url, token } = await board();
  const elsewhere = scratch(mkdtempSync(join(tmpdir(), "blz684-cwd-")));   // no board here at all
  try {
    const r = await blaze(["new", "--project", "OBA", "--type", "task", "--estimate", "30", "From", "another", "machine"],
                          { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token }, elsewhere);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `created OBA-2 (remote: ${url})`);
  } finally { server.close(); }
});

test("in remote mode every other command is refused, and half-set refuses everything", async () => {
  const elsewhere = scratch(mkdtempSync(join(tmpdir(), "blz684-cwd-")));
  const remote = { BLAZE_REMOTE_URL: "https://blaze.example.com", BLAZE_TOKEN: "blz_t" };
  for (const args of [["audit"], ["reconcile"], ["db", "status"], [], ["board"]]) {
    const r = await blaze(args, remote, elsewhere);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /is not available in remote mode — BLAZE_REMOTE_URL is set/);
  }
  for (const args of [["new", "--project", "X", "--type", "task", "t"], ["audit"]]) {
    const r = await blaze(args, { BLAZE_TOKEN: "blz_t" }, elsewhere);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /remote mode needs both BLAZE_REMOTE_URL and BLAZE_TOKEN/);
  }
  const ro = await blaze(["move", "OBA-1", "done"], { ...remote, BLAZE_READONLY: "1" }, elsewhere);
  assert.equal(ro.status, 1);
  assert.match(ro.stderr, /read-only mode/, "a refused write is refused in remote mode too");
});

test("the token goes to BLAZE_REMOTE_URL's origin only — a redirect elsewhere is refused, not followed", async () => {
  // `seen` records every request either server receives, Authorization header included.
  const seen = [];
  const listen = (handler) => new Promise((res) => {
    const s = createServer(handler).listen(0, "127.0.0.1", () => res(s));
  });
  const other = await listen((req, res) => {
    seen.push({ server: "other", auth: req.headers.authorization ?? null });
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true,"id":"X-1"}');
  });
  const first = await listen((req, res) => {
    seen.push({ server: "first", path: req.url, auth: req.headers.authorization ?? null });
    res.writeHead(307, { location: `http://127.0.0.1:${other.address().port}/api/new` }); res.end();
  });
  try {
    const c = capture();
    const code = await runRemote("new", ["--project", "OBA", "--type", "task", "t"],
      { env: { BLAZE_REMOTE_URL: `http://127.0.0.1:${first.address().port}`, BLAZE_TOKEN: "blz_secret" }, ...c.io });
    assert.equal(code, 1);
    assert.deepEqual(seen, [{ server: "first", path: "/api/new", auth: "Bearer blz_secret" }],
      "the configured origin got exactly one request; the redirect target got none");
    assert.doesNotMatch(c.err.join("\n"), /blz_secret/);
  } finally { first.close(); other.close(); }
});

test("an unauthenticated or read-scope caller is refused by the server, and nothing is written", async () => {
  const { root, server, url } = await board("viewer");
  try {
    const bad = capture();
    assert.equal(await runRemote("new", ["--project", "OBA", "--type", "task", "--estimate", "30", "x"],
      { env: { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: "blz_not-a-real-token" }, ...bad.io }), 1);
    assert.match(bad.err.join("\n"), /answered 401/);
    const { token } = await addUser(root, { email: "v2@example.com", role: "viewer" });
    const c = capture();
    assert.equal(await runRemote("new", ["--project", "OBA", "--type", "task", "--estimate", "30", "x"],
      { env: { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token }, ...c.io }), 1);
    assert.match(c.err.join("\n"), /answered 403[\s\S]*does not carry the 'write' scope/);
    assert.equal(existsSync(join(root, "projects", "OBA", "defined", "OBA-2-x.md")), false);
  } finally { server.close(); }
});
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/remote-mode.test.mjs
```

Expected: the file fails to load — `Cannot find module '…/scripts/remote-client.mjs'` (`tests 1, fail 1`).

- [ ] **Step 3: Implement.**

In `scripts/cli.mjs`, replace:

```js
  process.exit(1);
}
```

with:

```js
  process.exit(1);
}

// BLZ-684 (spec §5.4): REMOTE MODE. With BLAZE_REMOTE_URL and BLAZE_TOKEN both set, the six
// ticket verbs go to the board server over HTTP and nothing else runs here: every other command
// needs the board's data on this machine, so it is refused rather than run against whatever
// local tree happens to be in the working directory. Half-set is an error for EVERY command —
// never a silent fallback to writing locally. Decided after the read-only gate (a refused write
// is refused in both modes) and before the schema preflight (there is no local board to judge).
// Imported only when either variable is set, so a local invocation loads nothing new.
if (process.env.BLAZE_REMOTE_URL || process.env.BLAZE_TOKEN) {
  const { remoteFrom, runRemote, REMOTE_VERBS } = await import("./remote-client.mjs");
  const remote = remoteFrom(process.env);
  if (remote.error) { console.error(remote.error); process.exit(1); }
  if (remote.remote) {
    if (!Object.hasOwn(REMOTE_VERBS, key)) {
      console.error(`blaze: ${key} is not available in remote mode — BLAZE_REMOTE_URL is set, and `
        + `${key} needs the board's data on this machine. Remote mode runs: `
        + `${Object.keys(REMOTE_VERBS).join(", ")}.`);
      process.exit(1);
    }
    process.exitCode = await runRemote(key, rest);
    // Not process.exit(): stdout to a pipe is asynchronous, and the reply is the whole output.
    await new Promise((res) => process.stdout.write("", res));
    process.exit(process.exitCode);
  }
}
```

Create `scripts/remote-client.mjs`:

```js
// scripts/remote-client.mjs — `blaze` in remote mode (BLZ-684, spec §5.4).
//
// When BLAZE_REMOTE_URL and BLAZE_TOKEN are BOTH set, cli.mjs sends `new`, `move`, `edit`,
// `resolve`, `log` and `link` to the board server's matching `POST /api/*` endpoint and prints
// what it answered. The verb's logic and its validation run ONCE, on the server, against the
// store the server owns — this module only turns argv into a request and a response into a
// line. Every other command is refused in remote mode (cli.mjs), because it needs the board's
// data on this machine; and a remote mode set half-way is an error, never a silent fallback to
// writing locally.
//
// THE TOKEN GOES TO ONE ORIGIN, AND NOWHERE ELSE. Every request is built as
// `new URL("/api/<verb>", <origin of BLAZE_REMOTE_URL>)`, and redirects are an error rather
// than followed — a redirect is how a credential leaves for a host nobody configured. The URL
// must be https (plain http only for a loopback host, which never leaves the machine), carry no
// `user:pass@`, path, query or fragment, and no message here ever prints the token.
//
// Built-in `fetch` only: no dependency, and `fetch` is injectable so tests can watch every call.
import { isLoopback } from "./model/serve-auth.mjs";

export const REMOTE_URL_ENV = "BLAZE_REMOTE_URL";
export const REMOTE_TOKEN_ENV = "BLAZE_TOKEN";

/** The verbs remote mode forwards, and the endpoint each one calls. */
export const REMOTE_VERBS = {
  new: "/api/new", move: "/api/move", edit: "/api/edit",
  resolve: "/api/resolve", log: "/api/log", link: "/api/link",
};

/**
 * Is remote mode on, and is it configured sanely?
 * @returns { remote: false } | { remote: true, origin, token } | { error }
 */
export function remoteFrom(env = process.env) {
  const url = String(env[REMOTE_URL_ENV] ?? "").trim();
  const token = String(env[REMOTE_TOKEN_ENV] ?? "").trim();
  if (!url && !token) return { remote: false };
  if (!url || !token) {
    const [set, unset] = url ? [REMOTE_URL_ENV, REMOTE_TOKEN_ENV] : [REMOTE_TOKEN_ENV, REMOTE_URL_ENV];
    return { error: `blaze: remote mode needs both ${REMOTE_URL_ENV} and ${REMOTE_TOKEN_ENV}; `
      + `${set} is set and ${unset} is not. Refusing rather than writing to a local board — `
      + `set ${unset}, or unset ${set} to work locally.` };
  }
  let u;
  try { u = new URL(url); } catch {
    return { error: `blaze: ${REMOTE_URL_ENV} is not a URL. Expected e.g. https://blaze.example.com` };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { error: `blaze: ${REMOTE_URL_ENV} must be an https:// URL (got ${u.protocol})` };
  }
  if (u.protocol === "http:" && !isLoopback(u.hostname.replace(/^\[|\]$/g, ""))) {
    return { error: `blaze: ${REMOTE_URL_ENV} is plain http to ${u.hostname}, which would send `
      + `${REMOTE_TOKEN_ENV} in the clear. Use https:// (http:// is accepted for a loopback host only).` };
  }
  if (u.username || u.password) {
    return { error: `blaze: ${REMOTE_URL_ENV} must not carry a user:password@ — the credential is ${REMOTE_TOKEN_ENV}` };
  }
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    return { error: `blaze: ${REMOTE_URL_ENV} must be the board's origin only, e.g. ${u.origin} — `
      + "no path, query or fragment" };
  }
  if (/\s/.test(token)) return { error: `blaze: ${REMOTE_TOKEN_ENV} contains whitespace` };
  return { remote: true, origin: u.origin, token };
}

const NEW_VALUE_FLAGS = {
  "--project": "project", "--type": "type", "--priority": "priority", "--estimate": "estimate",
  "--parent": "parent", "--assignee": "assignee", "--likelihood": "likelihood", "--impact": "impact",
  "--reason": "reason", "--sprint": "sprint", "--not-before": "not_before", "--deadline": "deadline",
};
const DERIVED = { "--start": "--not-before", "--due": "--deadline" };
const commaList = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * argv (after the verb) → the request, parsed exactly as the local runner parses it.
 * @returns { path, body } | { error }
 */
export function requestFor(verb, argv) {
  const path = Object.hasOwn(REMOTE_VERBS, verb) ? REMOTE_VERBS[verb] : null;
  if (!path) return { error: `blaze: ${verb} is not available in remote mode` };
  const plain = (n, usage, args = argv) => {
    const pos = [];
    for (const a of args) {
      if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
      pos.push(a);
    }
    return pos.length < n || pos.slice(0, n).some((x) => !x) ? { error: usage } : { pos };
  };
  if (verb === "new") {
    const body = {};
    const title = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (DERIVED[a]) return { error: `blaze new: ${a} is derived by the scheduler; pass ${DERIVED[a]} to constrain it` };
      if (a === "--labels" || a === "--components") {
        if (argv[i + 1] === undefined) return { error: `blaze new: ${a} needs a value` };
        body[a.slice(2)] = commaList(argv[++i]); continue;
      }
      if (NEW_VALUE_FLAGS[a]) {
        if (argv[i + 1] === undefined) return { error: `blaze new: ${a} needs a value` };
        body[NEW_VALUE_FLAGS[a]] = argv[++i]; continue;
      }
      if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
      title.push(a);
    }
    body.title = title.join(" ");
    if (body.estimate !== undefined) body.estimate = Number(body.estimate);
    if (!body.project || !body.type || !body.title) {
      return { error: 'usage: blaze new --project <KEY> --type <type> "<title>" [--estimate m] [--parent ID] …' };
    }
    return { path, body };
  }
  if (verb === "move") {
    const r = plain(2, "usage: blaze move <id> <status>");
    return r.error ? r : { path, body: { id: r.pos[0], to: r.pos[1] } };
  }
  if (verb === "resolve") {
    const r = plain(2, "usage: blaze resolve <id> <resolution>");
    return r.error ? r : { path, body: { id: r.pos[0], resolution: r.pos[1] } };
  }
  if (verb === "edit") {
    // Only the id/field selectors are flag-checked; the value is freeform, as edit-runner.mjs's is.
    const [id, field, ...value] = argv;
    if (id?.startsWith("--")) return { error: `unknown flag: ${id}` };
    if (field?.startsWith("--")) return { error: `unknown flag: ${field}` };
    if (!id || !field || !value.length) return { error: "usage: blaze edit <id> <field> <value>" };
    return { path, body: { id, patch: { [field]: value.join(" ") } } };
  }
  if (verb === "log") {
    const body = {};
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--date" || a === "--note") {
        if (argv[i + 1] === undefined) return { error: `blaze log: ${a} needs a value` };
        body[a.slice(2)] = argv[++i]; continue;
      }
      if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
      pos.push(a);
    }
    if (!pos[0] || pos[1] === undefined) return { error: 'usage: blaze log <id> <minutes> [--date YYYY-MM-DD] [--note "..."]' };
    return { path, body: { id: pos[0], minutes: Number(pos[1]), ...body } };
  }
  // link — `--rm` first, as link-runner.mjs reads it
  const remove = argv[0] === "--rm";
  const r = plain(3, "usage: blaze link [--rm] <id> <TYPE> <target>", remove ? argv.slice(1) : argv);
  return r.error ? r : { path, body: { id: r.pos[0], type: r.pos[1], target: r.pos[2], remove } };
}

/** The line a successful response prints — the local verb's wording, marked remote. */
export function successLine(verb, body, answer, origin) {
  const at = `(remote: ${origin})`;
  switch (verb) {
    case "new": return `created ${answer.id} ${at}`;
    case "move": return `${body.id}: → ${body.to} ${at}`;
    case "edit": { const [[f, v]] = Object.entries(body.patch); return `${body.id}: ${f} = ${v} ${at}`; }
    case "resolve": return `${body.id}: resolution = ${body.resolution} ${at}`;
    case "log": return `logged ${body.minutes}m to ${body.id} ${at}`;
    default: return `${body.id}: ${body.remove ? "removed" : "added"} ${body.type} → ${body.target} ${at}`;
  }
}

/**
 * Run one verb against the server.
 * @returns the process exit code: 0 done, 1 refused or failed
 */
export async function runRemote(verb, argv, { env = process.env, fetch: fetchImpl = globalThis.fetch,
                                              out = console.log, err = console.error } = {}) {
  const cfg = remoteFrom(env);
  if (cfg.error) { err(cfg.error); return 1; }
  if (!cfg.remote) { err("blaze: remote mode is not configured"); return 1; }
  const req = requestFor(verb, argv);
  if (req.error) { err(req.error); return 1; }
  const url = new URL(req.path, `${cfg.origin}/`);
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json",
                 authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(req.body),
    });
  } catch (e) {
    // `e.message` only: fetch's error never carries the request headers, and nothing here
    // adds them — but a redirect refusal must read as one, not as a network blip.
    err(`blaze ${verb}: no answer from ${cfg.origin} — ${e?.cause?.message ?? e?.message ?? e}`);
    return 1;
  }
  let answer = null;
  try { answer = await res.json(); } catch { answer = null; }
  if (!res.ok || !answer || answer.ok !== true) {
    const errors = Array.isArray(answer?.errors) ? answer.errors : [`HTTP ${res.status} ${res.statusText}`.trim()];
    err(`blaze ${verb} failed (${cfg.origin} answered ${res.status}):\n  ${errors.join("\n  ")}`);
    return 1;
  }
  for (const w of Array.isArray(answer.warnings) ? answer.warnings : []) err(`warning: ${w}`);
  out(successLine(verb, req.body, answer, cfg.origin));
  return 0;
}
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/remote-mode.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/cli*.test.mjs tests/readonly*.test.mjs tests/runner-*.test.mjs tests/model/seam-closure.test.mjs tests/package.test.mjs tests/shipped-doc-links.test.mjs
```

Expected: `tests 10, suites 2, pass 10`, and every neighbour green.

- [ ] **Step 5: Docs, in the same commit.**

In `AGENTS.md`, replace:

```markdown

## Querying the board
```

with:

```markdown

## Remote mode (writing from another machine)

When the board lives on a server — a deployed `blaze board`, typically on Postgres — set
**both** `BLAZE_REMOTE_URL` (the server's origin, `https://…`) and `BLAZE_TOKEN` (a `member`
API token from `blaze user add`). Then `blaze new`, `move`, `edit`, `resolve`, `log` and `link`
take the same arguments as locally but run on the server, over HTTP, and print one line ending
`(remote: <origin>)`. Nothing is written locally, so there is no worktree, commit or queue to
manage, and two agents on two machines creating tickets at once get distinct ids.

Every other command is refused in remote mode (it needs the board's data on this machine);
read the board over `GET /api/live` or the page. Setting only ONE of the two variables is an
error for every command — never a silent local write. The token is only ever sent to
`BLAZE_REMOTE_URL`'s origin: redirects are refused, and plain `http://` is accepted for a
loopback host only. See
[the command reference](https://github.com/hjr15/blaze/blob/main/docs/guide/commands.md#remote-mode).

## Querying the board
```

In `docs/guide/commands.md`, replace (1/2):

```markdown

## Environment variables
```

with:

```markdown

## Remote mode

With **both** `BLAZE_REMOTE_URL` and `BLAZE_TOKEN` set, `blaze` writes to a board server over
HTTP instead of to a local tree (BLZ-684). This is how a second machine writes to the live
board once it is on Postgres (spec §5.4): the verb runs once, on the server, against the store
the server owns, and under `BLAZE_WRITE_PORT=db` the id comes from the database's counter, so
two machines creating at once never collide.

| Command | Endpoint |
|---|---|
| `blaze new …` | `POST /api/new` |
| `blaze move <id> <status>` | `POST /api/move` |
| `blaze edit <id> <field> <value>` | `POST /api/edit` |
| `blaze resolve <id> <resolution>` | `POST /api/resolve` |
| `blaze log <id> <minutes> [--date] [--note]` | `POST /api/log` |
| `blaze link [--rm] <id> <TYPE> <target>` | `POST /api/link` |

The arguments are the local command's own. Each prints one line ending `(remote: <origin>)`,
or the server's refusal and exit `1`. Every **other** command — `audit`, `reconcile`, `db`,
`import`, `sprint`, `board`, `show`/`list`-style reads … — is refused with
`blaze: <cmd> is not available in remote mode`: it needs the board's data on this machine.
Read the board over `GET /api/live` or the page instead. A remote mode set **half-way** (only
one of the two variables) is an error for every command, never a silent fallback to writing
locally. `BLAZE_READONLY` still refuses a write first.

The token is sent to `BLAZE_REMOTE_URL`'s origin and nowhere else: every request is built
against that origin, a redirect is refused rather than followed, plain `http://` is accepted
only for a loopback host, and no message prints the token. Use a `member` token (`blaze user
add --role member`): a `viewer` token is refused `403` on every write. The server skips the
CSRF header for such a bearer request (ADR-0013's addendum), so remote mode needs a board with
users — a loopback board with none still requires the header, and remote mode cannot supply it.

## Environment variables
```

In `docs/guide/commands.md`, replace (2/2):

```markdown
| `BLAZE_DB_DIR` | Directory for the derived `.blaze/` caches. | `.blaze/` under the data repo |

```

with:

```markdown
| `BLAZE_DB_DIR` | Directory for the derived `.blaze/` caches. | `.blaze/` under the data repo |
| `BLAZE_REMOTE_URL` | The board server's origin, e.g. `https://blaze.example.com` — turns on [remote mode](#remote-mode) together with `BLAZE_TOKEN`. `https://` only (plain `http://` for a loopback host); no path, query, fragment or `user:pass@`. | unset (local) |
| `BLAZE_TOKEN` | The API token remote mode sends as `Authorization: Bearer`, to `BLAZE_REMOTE_URL`'s origin and nowhere else. Setting only one of the two is an error for every command. | unset |

```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/remote-mode.test.mjs scripts/cli.mjs scripts/remote-client.mjs AGENTS.md docs/guide/commands.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-684: blaze remote mode — the six ticket verbs over HTTP to one origin" -m "New scripts/remote-client.mjs (remoteFrom, requestFor, runRemote on built-in fetch; https or loopback http only, origin only, redirects refused, the token never printed); cli.mjs sends new/move/edit/resolve/log/link to it when BLAZE_REMOTE_URL and BLAZE_TOKEN are both set, refuses every other command, and refuses everything when half-set. New tests/remote-mode.test.mjs (incl. an end-to-end CLI process against a real server); commands.md remote-mode section and env rows, AGENTS.md section." -- tests/remote-mode.test.mjs scripts/cli.mjs scripts/remote-client.mjs AGENTS.md docs/guide/commands.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/remote-mode.test.mjs   # green on the COMMITTED tree
```


---

### Task 4: the two-machine proof — `scripts/ops/concurrency-proof.mjs` and spec §6's Postgres test

**Files:**
- Create: `tests/concurrency-proof.test.mjs`
- Create: `scripts/ops/concurrency-proof.mjs`
- Modify: `scripts/remote-client.mjs`
- Modify: `docs/guide/commands.md`

**Interfaces:**
- Consumes: Task 3's `remoteFrom`.
- Produces: `requestRemote(cfg, method, path, body, { fetch }) → Promise<{ status, ok, statusText, answer }>` (`remote-client.mjs`, now the one function that sends the token; `runRemote` uses it). `scripts/ops/concurrency-proof.mjs`: `createMany(cfg, { project, count, type, estimate, parallel, label, fetch }) → { ids, failures }`, `verifyLists(cfg, lists, { fetch }) → { ok, total, distinct, duplicates, missing }`, `main(argv, { env, out, err, fetch }) → exit code`; CLI `create --project K --count N [--type] [--estimate] [--parallel] [--label]` (prints `{ origin, label, ids, failures }` JSON) and `verify <file…>` (prints `PROOF: PASS|FAIL`).

- [ ] **Step 1: Write the failing tests.**

Create `tests/concurrency-proof.test.mjs`:

```js
// tests/concurrency-proof.test.mjs — BLZ-684: the two-machine proof (spec §6 and §7 step 3).
//
// The Postgres test is spec §6's: two PROCESSES each fire 50 `POST /api/new` in parallel at one
// db-mode server, and the result is 100 distinct ids, 100 rows, and no gap the counter did not
// skip. The rest pins `scripts/ops/concurrency-proof.mjs` — the harness the operator runs on two
// real machines — against a filesystem board, so it is covered without a database.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { remoteFrom, requestRemote } from "../scripts/remote-client.mjs";
import { createMany, verifyLists, main } from "../scripts/ops/concurrency-proof.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { QUIET } from "./helpers/db-board.mjs";
import { PG, PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const scratch = scratchRegistry();
const PROOF = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ops", "concurrency-proof.mjs");

function gitBoard() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz684-proof-")));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["ENG"] }));
  writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-one.md"),
    ["---", "id: ENG-1", "title: one", "type: task", "project: ENG", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}
async function serve(root) {
  const server = startServer({ port: 0, root, projectsDir: join(root, "projects") });
  await new Promise((res) => server.once("listening", res));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const capture = () => {
  const out = [], err = [];
  return { out, err, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } };
};
/** The harness as a real process — async, so an in-process server can answer it. */
function proof(args, env) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY"]) delete base[k];
    const p = spawn(process.execPath, [PROOF, ...args], { env: { ...base, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const num = (id) => Number(id.split("-").pop());

describe("the harness, against a filesystem board", () => {
  test("createMany creates distinct tickets in parallel; verifyLists passes them", async () => {
    const root = gitBoard();
    const { token } = await addUser(root, { email: "m@example.com", role: "member" });
    const { server, url } = await serve(root);
    try {
      const cfg = remoteFrom({ BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token });
      const r = await createMany(cfg, { project: "ENG", count: 4, parallel: 2, label: "t" });
      assert.deepEqual(r.failures, []);
      assert.deepEqual(r.ids.map(num).sort((a, b) => a - b), [2, 3, 4, 5]);
      assert.deepEqual(await verifyLists(cfg, [r.ids.slice(0, 2), r.ids.slice(2)]),
        { ok: true, total: 4, distinct: 4, duplicates: [], missing: [] });
    } finally { server.close(); }
  });

  test("verifyLists FAILS a duplicate across lists, an id the server lacks, and an empty set", async () => {
    const root = gitBoard();
    const { token } = await addUser(root, { email: "m@example.com", role: "member" });
    const { server, url } = await serve(root);
    try {
      const cfg = remoteFrom({ BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token });
      assert.deepEqual(await verifyLists(cfg, [["ENG-1"], ["ENG-1", "ENG-99"]]),
        { ok: false, total: 3, distinct: 2, duplicates: ["ENG-1"], missing: ["ENG-99"] });
      assert.equal((await verifyLists(cfg, [[], []])).ok, false, "a proof that created nothing proves nothing");
    } finally { server.close(); }
  });

  test("a refused create is counted as a failure, not an id; the run exits 1", async () => {
    const root = gitBoard();
    const { token } = await addUser(root, { email: "v@example.com", role: "viewer" });
    const { server, url } = await serve(root);
    try {
      const c = capture();
      const code = await main(["create", "--project", "ENG", "--count", "2"],
        { env: { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token }, ...c.io });
      assert.equal(code, 1);
      const printed = JSON.parse(c.out[0]);
      assert.deepEqual(printed.ids, []);
      assert.equal(printed.failures.length, 2);
      assert.match(c.err.join("\n"), /failed \(403\): this token does not carry the 'write' scope/);
    } finally { server.close(); }
  });

  test("main: create prints JSON a later verify reads; bad arguments print the usage", async () => {
    const root = gitBoard();
    const { token } = await addUser(root, { email: "m@example.com", role: "member" });
    const { server, url } = await serve(root);
    try {
      const env = { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token };
      const made = capture();
      assert.equal(await main(["create", "--project", "ENG", "--count", "3", "--label", "m1"], { env, ...made.io }), 0);
      const file = join(root, "m1.json");
      writeFileSync(file, made.out[0]);
      const v = capture();
      assert.equal(await main(["verify", file], { env, ...v.io }), 0);
      assert.match(v.out.join("\n"), /3 ids from 1 list\(s\): 3 distinct, 0 duplicated, 0 not on the server[\s\S]*PROOF: PASS/);
      for (const argv of [["create", "--count", "3"], ["create", "--project", "ENG", "--count", "0"],
                          ["create", "--project"], ["create", "--bogus", "1"], ["verify"], ["nonsense"]]) {
        const c = capture();
        assert.equal(await main(argv, { env, ...c.io }), 1, argv.join(" "));
        assert.match(c.err.join("\n"), /usage: node scripts\/ops\/concurrency-proof\.mjs/);
      }
      const unread = capture();
      assert.equal(await main(["verify", join(root, "absent.json")], { env, ...unread.io }), 1);
      assert.match(unread.err.join("\n"), /cannot read/);
      writeFileSync(join(root, "bad.json"), "{}");
      const bad = capture();
      assert.equal(await main(["verify", join(root, "bad.json")], { env, ...bad.io }), 1);
      assert.match(bad.err.join("\n"), /holds no "ids" list/);
      const local = capture();
      assert.equal(await main(["verify", file], { env: {}, ...local.io }), 1);
      assert.match(local.err.join("\n"), /remote mode is not configured/);
    } finally { server.close(); }
  });

  test("requestRemote never builds a URL off the configured origin", async () => {
    const cfg = remoteFrom({ BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN: "blz_t" });
    let called = false;
    await assert.rejects(requestRemote(cfg, "GET", "//evil.example/api/x", undefined,
      { fetch: async () => { called = true; } }), /refusing to send the token to http:\/\/evil\.example/);
    assert.equal(called, false);
  });
});

test("spec §6: 2 processes × 50 parallel POST /api/new on Postgres → 100 distinct ids, 100 rows, no gaps",
  PG_SKIP, async () => {
    const db = await scratchPgDb("proof");
    const root = scratch(mkdtempSync(join(tmpdir(), "blz684-pgproof-")));
    mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ projects: ["ENG"], database: { driver: "postgres" } }));
    writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-one.md"),
      ["---", "id: ENG-1", "title: one", "type: task", "project: ENG", "estimate: 30",
       "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
    const u = new URL(PG);
    const dbEnv = { BLAZE_DB_HOST: u.hostname, BLAZE_DB_PORT: u.port || "5432", BLAZE_DB_NAME: db.name,
                    BLAZE_DB_USER: decodeURIComponent(u.username), BLAZE_DB_PASSWORD_ENV: "BLZ684_TEST_PGPW",
                    BLZ684_TEST_PGPW: decodeURIComponent(u.password), BLAZE_WRITE_PORT: "db" };
    const saved = Object.fromEntries(Object.keys(dbEnv).map((k) => [k, process.env[k]]));
    Object.assign(process.env, dbEnv);
    const roots = { dataRoot: root, projectsDir: join(root, "projects") };
    let server;
    try {
      assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
      assert.equal(await runDb(["load"], { ...QUIET, roots }), 0);
      const { token } = await addUser(root, { email: "m@example.com", role: "member" });
      ({ server } = await serve(root));
      const remote = { BLAZE_REMOTE_URL: `http://127.0.0.1:${server.address().port}`, BLAZE_TOKEN: token.token };
      const [a, b] = await Promise.all(["a", "b"].map((label) =>
        proof(["create", "--project", "ENG", "--count", "50", "--parallel", "5", "--label", label], remote)));
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);
      const ids = [...JSON.parse(a.stdout).ids, ...JSON.parse(b.stdout).ids];
      assert.equal(ids.length, 100);
      assert.equal(new Set(ids).size, 100, "100 distinct ids");
      assert.deepEqual(ids.map(num).sort((x, y) => x - y), Array.from({ length: 100 }, (_, i) => i + 2),
        "ENG-2..ENG-101: no gap the counter did not skip");
      const c = await pgClient(db.url);
      try {
        assert.equal(Number((await c.query("SELECT count(*) AS n FROM ticket WHERE project_key = 'ENG'")).rows[0].n), 101);
        assert.equal(Number((await c.query("SELECT n FROM project_counter WHERE project_key = 'ENG'")).rows[0].n), 101);
      } finally { await c.end(); }
      // …and the operator's verify step agrees, over the API.
      writeFileSync(join(root, "a.json"), a.stdout);
      writeFileSync(join(root, "b.json"), b.stdout);
      const v = await proof(["verify", join(root, "a.json"), join(root, "b.json")], remote);
      assert.equal(v.status, 0, v.stdout + v.stderr);
      assert.match(v.stdout, /100 ids from 2 list\(s\): 100 distinct[\s\S]*PROOF: PASS/);
    } finally {
      server?.close();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await db.drop();
    }
  });
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/concurrency-proof.test.mjs
```

Expected: the file fails to load — `Cannot find module '…/scripts/ops/concurrency-proof.mjs'` (`tests 1, fail 1`).

- [ ] **Step 3: Implement.**

Create `scripts/ops/concurrency-proof.mjs`:

```js
#!/usr/bin/env node
// scripts/ops/concurrency-proof.mjs — the cutover's two-machine proof (BLZ-684, spec §7 step 3).
//
// BLZ-254's acceptance criterion is "two agents on two machines each create 50 tickets
// concurrently — distinct ids, no ceremony". This is the harness the operator runs for it:
//
//   create  — on EACH machine, in remote mode (BLAZE_REMOTE_URL + BLAZE_TOKEN), create
//             `--count` tickets through `POST /api/new`, `--parallel` at a time, and print the
//             ids as JSON on stdout. Save each machine's output to a file.
//
//       node scripts/ops/concurrency-proof.mjs create --project BLZ --count 50 --label m1 > m1.json
//
//   verify  — on either machine, hand it every saved file: it checks the ids are distinct
//             across ALL of them and that each one is on the server, and exits 0 or 1.
//
//       node scripts/ops/concurrency-proof.mjs verify m1.json m2.json
//
// Every request goes through remote-client.mjs's `requestRemote`, so the token reaches
// BLAZE_REMOTE_URL's origin and nowhere else. The tickets it creates are real: run it against
// the rehearsal database, and clean up with `blaze resolve <id> wont-do` (or drop the
// database) — the proof never deletes anything itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { remoteFrom, requestRemote } from "../remote-client.mjs";

const USAGE = `usage: node scripts/ops/concurrency-proof.mjs create --project <KEY> --count <n>
         [--type task] [--estimate 15] [--parallel 8] [--label <name>]
       node scripts/ops/concurrency-proof.mjs verify <ids.json> [<ids.json> …]
  Both need BLAZE_REMOTE_URL and BLAZE_TOKEN (remote mode).`;

/**
 * Create `count` tickets, at most `parallel` in flight at once.
 * @returns { ids: string[], failures: [{ n, status, errors }] } — ids in completion order
 */
export async function createMany(cfg, { project, count, type = "task", estimate = 15, parallel = 8,
                                        label = "proof", fetch } = {}) {
  const ids = [], failures = [];
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const n = ++next;
      let r;
      try {
        r = await requestRemote(cfg, "POST", "/api/new",
          { project, type, estimate, title: `concurrency proof ${label} ${n}` }, { fetch });
      } catch (e) {
        failures.push({ n, status: null, errors: [String(e?.cause?.message ?? e?.message ?? e)] });
        continue;
      }
      if (r.ok && r.answer?.ok === true && typeof r.answer.id === "string") ids.push(r.answer.id);
      else failures.push({ n, status: r.status, errors: r.answer?.errors ?? [] });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, count)) }, worker));
  return { ids, failures };
}

/**
 * The verdict over every machine's list: duplicates (within or across lists) and ids the
 * server does not hold. Asks the server about each distinct id (`GET /api/panel?id=`).
 * @returns { ok, total, distinct, duplicates: string[], missing: string[] }
 */
export async function verifyLists(cfg, lists, { fetch } = {}) {
  const all = lists.flat();
  const seen = new Set(), duplicates = new Set();
  for (const id of all) (seen.has(id) ? duplicates : seen).add(id);
  const missing = [];
  for (const id of seen) {
    const r = await requestRemote(cfg, "GET", `/api/panel?id=${encodeURIComponent(id)}`, undefined, { fetch });
    if (r.status !== 200) missing.push(id);
  }
  return { ok: all.length > 0 && duplicates.size === 0 && missing.length === 0,
           total: all.length, distinct: seen.size, duplicates: [...duplicates].sort(), missing: missing.sort() };
}

/** The CLI. @returns the exit code */
export async function main(argv, { env = process.env, out = console.log, err = console.error, fetch } = {}) {
  const [mode, ...rest] = argv;
  const cfg = remoteFrom(env);
  if (cfg.error) { err(cfg.error); return 1; }
  if (!cfg.remote) { err(`concurrency-proof: remote mode is not configured\n\n${USAGE}`); return 1; }
  if (mode === "create") {
    const o = { type: "task", estimate: 15, parallel: 8, label: "proof" };
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i];
      const v = rest[++i];
      if (v === undefined) { err(`concurrency-proof: ${k} needs a value\n\n${USAGE}`); return 1; }
      if (k === "--project") o.project = v;
      else if (k === "--type") o.type = v;
      else if (k === "--label") o.label = v;
      else if (k === "--count" || k === "--estimate" || k === "--parallel") o[k.slice(2)] = Number(v);
      else { err(`concurrency-proof: unknown argument ${k}\n\n${USAGE}`); return 1; }
    }
    if (!o.project || !Number.isInteger(o.count) || o.count < 1 || !Number.isInteger(o.parallel) || o.parallel < 1) {
      err(USAGE); return 1;
    }
    const r = await createMany(cfg, { ...o, fetch });
    out(JSON.stringify({ origin: cfg.origin, label: o.label, ids: r.ids, failures: r.failures }));
    for (const f of r.failures) err(`concurrency-proof: ticket ${f.n} failed (${f.status ?? "no answer"}): ${f.errors.join("; ")}`);
    return r.failures.length ? 1 : 0;
  }
  if (mode === "verify") {
    if (!rest.length) { err(USAGE); return 1; }
    const lists = [];
    for (const file of rest) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(file, "utf8")); }
      catch (e) { err(`concurrency-proof: cannot read ${file}: ${e.message}`); return 1; }
      if (!Array.isArray(parsed?.ids)) { err(`concurrency-proof: ${file} holds no "ids" list`); return 1; }
      lists.push(parsed.ids);
    }
    const v = await verifyLists(cfg, lists, { fetch });
    out(`${v.total} ids from ${lists.length} list(s): ${v.distinct} distinct, `
      + `${v.duplicates.length} duplicated, ${v.missing.length} not on the server`);
    if (v.duplicates.length) out(`  duplicated: ${v.duplicates.join(", ")}`);
    if (v.missing.length) out(`  not on the server: ${v.missing.join(", ")}`);
    out(v.ok ? "PROOF: PASS" : "PROOF: FAIL");
    return v.ok ? 0 : 1;
  }
  err(USAGE);
  return 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
```

In `scripts/remote-client.mjs`, replace (1/2):

```js
/**
 * Run one verb against the server.
```

with:

```js
/**
 * One request to the configured origin, and nowhere else: the URL is built against
 * `cfg.origin` (a `path` can only ever be a path on it), the token rides in `Authorization`,
 * and a redirect is an ERROR rather than followed. Shared by `runRemote` and
 * `scripts/ops/concurrency-proof.mjs` (BLZ-684), so there is one place that sends the token.
 * @returns { status, ok, answer } — `answer` is the parsed JSON body, or null
 */
export async function requestRemote(cfg, method, path, body, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(path, `${cfg.origin}/`);
  if (url.origin !== cfg.origin) throw new Error(`refusing to send the token to ${url.origin}`);
  const res = await fetchImpl(url, {
    method,
    redirect: "error",
    headers: { accept: "application/json", authorization: `Bearer ${cfg.token}`,
               ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let answer = null;
  try { answer = await res.json(); } catch { answer = null; }
  return { status: res.status, ok: res.ok, statusText: res.statusText, answer };
}

/**
 * Run one verb against the server.
```

In `scripts/remote-client.mjs`, replace (2/2):

```js
  if (req.error) { err(req.error); return 1; }
  const url = new URL(req.path, `${cfg.origin}/`);
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json",
                 authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(req.body),
    });
  } catch (e) {
    // `e.message` only: fetch's error never carries the request headers, and nothing here
    // adds them — but a redirect refusal must read as one, not as a network blip.
    err(`blaze ${verb}: no answer from ${cfg.origin} — ${e?.cause?.message ?? e?.message ?? e}`);
    return 1;
  }
  let answer = null;
  try { answer = await res.json(); } catch { answer = null; }
  if (!res.ok || !answer || answer.ok !== true) {
```

with:

```js
  if (req.error) { err(req.error); return 1; }
  let res;
  try {
    res = await requestRemote(cfg, "POST", req.path, req.body, { fetch: fetchImpl });
  } catch (e) {
    // The message only: fetch's error never carries the request headers, and nothing here
    // adds them — a redirect refusal reads as "no answer", never as a success.
    err(`blaze ${verb}: no answer from ${cfg.origin} — ${e?.cause?.message ?? e?.message ?? e}`);
    return 1;
  }
  const { answer } = res;
  if (!res.ok || !answer || answer.ok !== true) {
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/concurrency-proof.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/remote-mode.test.mjs tests/model/seam-closure.test.mjs tests/tmp-scratch-attribution.test.mjs tests/temp-cleanup-guard.test.mjs tests/package.test.mjs
```

Expected: `tests 6, suites 1, pass 6` (1 skips without Postgres), and every neighbour green.

- [ ] **Step 5: Docs, in the same commit.**

In `docs/guide/commands.md`, replace:

```markdown

## Environment variables
```

with:

```markdown

**The two-machine proof** (the cutover rehearsal, BLZ-254 spec §7 step 3) is
`scripts/ops/concurrency-proof.mjs`, run in remote mode. On each machine,
`node scripts/ops/concurrency-proof.mjs create --project <KEY> --count 50 --label <machine> > <machine>.json`
creates the tickets (`--parallel 8` in flight by default) and prints their ids as JSON; then
`node scripts/ops/concurrency-proof.mjs verify m1.json m2.json` checks every id is distinct
across all the files and present on the server, and prints `PROOF: PASS` (exit `0`) or the
duplicated and missing ids (exit `1`). The tickets are real: run it against the rehearsal
database. The same shape runs in CI against Postgres (`tests/concurrency-proof.test.mjs`: two
processes × 50 → 100 distinct ids, 100 rows, no gaps).

## Environment variables
```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/concurrency-proof.test.mjs scripts/ops/concurrency-proof.mjs scripts/remote-client.mjs docs/guide/commands.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-684: the two-machine concurrency proof and its Postgres test" -m "remote-client.mjs gains requestRemote (the one place the token is sent; runRemote uses it); new scripts/ops/concurrency-proof.mjs (create N in parallel and print ids; verify lists are distinct and on the server). New tests/concurrency-proof.test.mjs incl. spec 6's 2 processes x 50 POST /api/new on Postgres -> 100 distinct ids, 100 rows, no gaps; commands.md." -- tests/concurrency-proof.test.mjs scripts/ops/concurrency-proof.mjs scripts/remote-client.mjs docs/guide/commands.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/concurrency-proof.test.mjs   # green on the COMMITTED tree
```


---

### Task 5: Verification before the PR (no commit)

- [ ] **Step 1: Kickoff §9, on the branch.**

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-684-remote-writes
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
git fetch origin
npm test 2>&1 | tail -12                                   # fail 0
node scripts/ci/hygiene-check.mjs origin/main              # hygiene: clean
git log origin/main..HEAD --format=%B | grep -ci 'co-authored-by\|signed-off-by'   # 0
git log origin/main..HEAD --format=%s | grep -vc '^BLZ-'  # 0
git status --short                                         # empty
[ "$(git merge-base HEAD origin/main)" = "$(git rev-parse origin/main)" ] && echo base-ok
```

- [ ] **Step 2: The local Postgres run, with coverage.**

```bash
docker run -d --rm --name blz-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=blaze_test -p 127.0.0.1:55432:5432 postgres:17-alpine
until docker exec blz-pg pg_isready -U postgres -d blaze_test; do sleep 1; done
BOX=$(mktemp -d /tmp/blz684-box-XXXX)
TMPDIR=$BOX BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test npm run test:coverage > "$BOX.log" 2>&1; tail -12 "$BOX.log"
grep -c "already executing" "$BOX.log"                    # 0
node scripts/ci/tmp-scratch-attribution.mjs --tmp "$BOX" --max 0
docker stop blz-pg
```

Expected: `fail 0`, the c8 thresholds pass (91/77/93/91), no deprecation line, no attributable scratch directory left.

- [ ] **Step 3: `gh pr checks <PR>` after opening the PR** — every row pass; re-read it before merging (`--watch` can exit 0 on a failure). PR title: `BLZ-684: remote writes — POST /api/new, bearer CSRF exemption, blaze remote mode`; it touches auth, so it is reviewed on its own (spec §8).

## Operator acceptance (spec §7 step 3, after PR C's Postgres exists)

On the rehearsal board, with `BLAZE_WRITE_PORT=db` and a `member` token issued by `blaze user add` on the server:

```bash
export BLAZE_REMOTE_URL=https://<the board's origin> BLAZE_TOKEN=<member token>   # on BOTH machines
node scripts/ops/concurrency-proof.mjs create --project BLZ --count 50 --label m1 > m1.json   # machine 1
node scripts/ops/concurrency-proof.mjs create --project BLZ --count 50 --label m2 > m2.json   # machine 2, at the same time
node scripts/ops/concurrency-proof.mjs verify m1.json m2.json                               # either machine: PROOF: PASS
```

The gate is spec §7 step 3's: 100 distinct ids, 100 rows, 0 errors. The tickets are real; resolve them `wont-do` (or drop `blaze_rehearsal`, step 7) afterwards.

## Self-review

- **Spec coverage:** §5.4 — `POST /api/new` (Task 2), `/api/link` confirmed absent and added (Task 2, Finding 1), the CSRF rule incl. cookie+bearer and the ADR-0013 addendum (Task 1), CLI remote mode with the refusals and half-set error (Task 3; `ac` resolved by Finding 5), remote reads out of scope (unchanged); §6's server, CLI-to-server end-to-end and 2×50 concurrency tests (Tasks 1, 3, 4); §7 step 3's harness (Task 4). The supervisor twin was checked (Finding 2).
- **Security constraints:** each of the six pinned behaviours has a named test (Global Constraints, Review Focus).
- **Placeholders:** none — every code step is the prototype's literal content.
- **Type consistency:** `requestRemote`'s `{ status, ok, answer }` is what both `runRemote` and the harness read; `REMOTE_VERBS`' keys are what `cli.mjs` checks with `Object.hasOwn`; `/api/new`'s `{ ok, id }` is what `successLine` and `createMany` read.
