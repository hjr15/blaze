# BLZ-254 PR B — remote writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a second machine write to the live board over HTTP once it is on Postgres: `POST /api/new` and `POST /api/link` on `blaze board`, a bearer-only request exempt from the CSRF header, `blaze` remote mode (`BLAZE_REMOTE_URL` + `BLAZE_TOKEN`), and the two-machine concurrency proof.

**Architecture:** One predicate, `csrfRequired({ headers, store })` in `serve-auth.mjs`, decides the CSRF exemption: exempt only for a bearer token the gate judged, with no session cookie beside it. `serve.mjs`'s POST handler gains `/api/new` (`applyNew` through the resolved port, so under db the id comes from `project_counter`) and `/api/link` (`applyLink`), both recording the caller as the event's actor. `scripts/remote-client.mjs` (built-in `fetch`) turns the six verbs' argv into requests to one origin; `cli.mjs` routes to it when both variables are set and refuses everything else. `scripts/ops/concurrency-proof.mjs` is the operator's create/verify harness on the same client.

**Tech Stack:** Node 24 ESM, `node:test`, built-in `fetch`, `node:sqlite`, `pg` 8 against Postgres 17.

**Spec:** `docs/superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md` — §5.4, §6 ("Remote writes"), §7 step 3, and §8 row B. Read it first; this plan argues from it. ADR-0013 §7 is the decision Task 1 amends.

**Prototype provenance.** Every code and test block below was run, task by task, in a scratch worktree of `385d2aa` (PR A's squash on `main`) against `postgres:17-alpine`. This Markdown was then GENERATED from that prototype's per-task trees: each "replace" block was checked to occur exactly once in its file at that point, and applying all of them in order reproduces the prototype byte for byte (34 edits, 16 files). Each task's tests were run on the tree with only that task's tests applied — the failures named in each Step 2 are that run's — and then on the finished task. On the final tree, `npm run test:coverage` with `BLAZE_TEST_PG_URL` set and a private `TMPDIR` → `tests 5442, pass 5441, fail 0, skipped 1`; c8 statements 98.04 %, branches 88.28 %, functions 97.68 %, lines 98.04 % (thresholds 91/77/93/91); 0 pg deprecation lines; `hygiene-check` clean; no attributable scratch directory left.

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
3. **The exemption needs a board with users.** `csrfRequired` exempts a bearer request only when `store` is set: on a loopback board with no users the gate judges nothing, so the header is the only control left (a page in the operator's own browser could otherwise POST cross-origin with an arbitrary `Authorization`… which a browser would preflight — but the rule does not lean on that). Consequence: remote mode needs a board with users; against a no-user loopback board every remote write is `403 bad csrf token`. Documented in `commands.md`.
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

> **WIP:** Tasks 3–4 and the verification task follow in the next commit.
