// scripts/remote-client.mjs — `blaze` in remote mode (BLZ-684, spec §5.4).
//
// When BLAZE_REMOTE_URL and BLAZE_TOKEN (or BLAZE_TOKEN_FILE, BLZ-710) are BOTH set, cli.mjs
// sends `new`, `move`, `edit`, `resolve`, `log` and `link` to the board server's matching
// `POST /api/*` endpoint and prints what it answered; `show` and `list` (BLZ-709) send a `GET /api/ticket`, `/api/tickets` or
// `/api/projects` and render the answer. The verb's logic and its validation run ONCE, on the server, against the
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
import { readRegularFileSync } from "./model/regular-file.mjs";

export const REMOTE_URL_ENV = "BLAZE_REMOTE_URL";
export const REMOTE_TOKEN_ENV = "BLAZE_TOKEN";
export const REMOTE_TOKEN_FILE_ENV = "BLAZE_TOKEN_FILE";

/** The verbs remote mode forwards, and the endpoint each one calls. */
export const REMOTE_VERBS = {
  new: "/api/new", move: "/api/move", edit: "/api/edit",
  resolve: "/api/resolve", log: "/api/log", link: "/api/link",
  // BLZ-709 (spec D7): the two reads. GETs, answered as JSON and rendered here.
  show: "/api/ticket", list: "/api/tickets",
};

/** "The credential" in a message: either source counts (BLZ-710). */
const CREDENTIAL = `${REMOTE_TOKEN_ENV} (or ${REMOTE_TOKEN_FILE_ENV})`;

/**
 * Is remote mode on, and is it configured sanely?
 *
 * BLZ-710: the token is `BLAZE_TOKEN` when that is non-blank; otherwise, when
 * `BLAZE_TOKEN_FILE` names a path, the trimmed content of that file (mode 0600, so an agent's
 * shell never holds the token itself). The file is read as a REGULAR file only — a FIFO or a
 * directory is refused, never opened and waited on. Its CONTENT never appears in any message
 * here: a refusal names the variable, the path and an error code, nothing read from the file.
 * @returns { remote: false } | { remote: true, origin, token } | { error }
 */
export function remoteFrom(env = process.env, { readFile = (p) => readRegularFileSync(p, "utf8") } = {}) {
  const url = String(env[REMOTE_URL_ENV] ?? "").trim();
  const envToken = String(env[REMOTE_TOKEN_ENV] ?? "").trim();
  const tokenPath = envToken ? "" : String(env[REMOTE_TOKEN_FILE_ENV] ?? "").trim();
  const credential = envToken || tokenPath;
  if (!url && !credential) return { remote: false };
  if (!url || !credential) {
    const [set, unset] = url ? [REMOTE_URL_ENV, CREDENTIAL]
      : [envToken ? REMOTE_TOKEN_ENV : REMOTE_TOKEN_FILE_ENV, REMOTE_URL_ENV];
    return { error: `blaze: remote mode needs both ${REMOTE_URL_ENV} and ${CREDENTIAL}; `
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
  let token = envToken;
  if (token) {
    if (/\s/.test(token)) return { error: `blaze: ${REMOTE_TOKEN_ENV} contains whitespace` };
  } else {
    // The file's content stays out of every message below: path and code only.
    const where = `${REMOTE_TOKEN_FILE_ENV} (${tokenPath})`;
    try { token = String(readFile(tokenPath)).trim(); } catch (e) {
      return { error: `blaze: ${where} could not be read (${e?.code ?? "error"})` };
    }
    if (!token) return { error: `blaze: ${where} is empty` };
    if (/\s/.test(token)) return { error: `blaze: ${where} contains whitespace` };
  }
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
 *
 * Two consequences of "exactly", kept on purpose (BLZ-691): positionals past the ones a verb
 * takes are ignored, as move-, resolve-, log- and link-runner.mjs ignore them; and a
 * non-numeric `--estimate` or `<minutes>` becomes `NaN`, as the local runners' `Number()`
 * does. JSON has no NaN, so it is sent as `null` — and the SERVER refuses that `422`, naming
 * the field. Validation stays on the server, in one place.
 *
 * BLZ-709: a read (`show`, `list`) is a GET with its arguments in the query string, `read`
 * naming the answer's shape for `renderRead`; a write is a POST with `read: false`.
 * @returns { method, path, body, read, json } | { error }
 */
export function requestFor(verb, argv) {
  const path = Object.hasOwn(REMOTE_VERBS, verb) ? REMOTE_VERBS[verb] : null;
  if (!path) return { error: `blaze: ${verb} is not available in remote mode` };
  if (verb === "show" || verb === "list") return readRequestFor(verb, argv);
  const r = writeRequestFor(verb, path, argv);
  return r.error ? r : { method: "POST", path: r.path, body: r.body, read: false, json: false };
}

const LIST_FILTERS = { "--project": "project", "--status": "status", "--type": "type" };

function readRequestFor(verb, argv) {
  let json = false;
  if (verb === "show") {
    const pos = [];
    for (const a of argv) {
      if (a === "--json") { json = true; continue; }
      if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
      pos.push(a);
    }
    if (!pos[0]) return { error: "usage: blaze show <id> [--json]" };
    return { method: "GET", path: `/api/ticket?id=${encodeURIComponent(pos[0])}`, body: undefined,
             read: "ticket", json };
  }
  const query = new URLSearchParams();
  let projects = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { json = true; continue; }
    if (a === "--projects") { projects = true; continue; }
    if (LIST_FILTERS[a]) {
      // A value that is itself a flag (`--status --json`) is a missing value, not a status.
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) return { error: `blaze list: ${a} needs a value` };
      query.set(LIST_FILTERS[a], argv[++i]); continue;
    }
    if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
    return { error: "usage: blaze list [--project K] [--status S] [--type T] [--json] | blaze list --projects [--json]" };
  }
  if (projects) {
    if ([...query.keys()].length) {
      return { error: "blaze list: --projects lists projects and takes no --project, --status or --type" };
    }
    return { method: "GET", path: "/api/projects", body: undefined, read: "projects", json };
  }
  const q = query.toString();
  return { method: "GET", path: q ? `/api/tickets?${q}` : "/api/tickets", body: undefined, read: "tickets", json };
}

/** The six writes' argv → `{ path, body }`, unchanged from BLZ-684. */
function writeRequestFor(verb, path, argv) {
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

/** BLZ-710: the `fetch` failure causes that mean "this machine does not trust the server's CA". */
export const TLS_TRUST_CODES = new Set(["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]);

/**
 * Why a request got no usable answer, as one line (BLZ-691). `redirect: "error"` makes fetch
 * reject a 3xx with `TypeError("fetch failed", { cause: "unexpected redirect" })`; the server
 * DID answer, so that reads as a refused redirect, never as "no answer". The message only:
 * fetch's error never carries the request headers, so the token cannot appear in it.
 */
export function failureLine(prefix, origin, e) {
  // BLZ-710: a private CA's certificate is the common first-run failure. Name the fix.
  const code = e?.cause?.code;
  if (TLS_TRUST_CODES.has(code)) {
    return `${prefix}: ${origin}'s TLS certificate is not trusted on this machine (${code}). `
      + "Point NODE_EXTRA_CA_CERTS at the CA certificate that signed it — e.g. "
      + "NODE_EXTRA_CA_CERTS=/path/to/ca.crt — and run again.";
  }
  const cause = String(e?.cause?.message ?? e?.message ?? e);
  if (cause === "unexpected redirect") {
    return `${prefix}: refused a redirect from ${origin} — the token is sent to that origin only, never on to where it points`;
  }
  return `${prefix}: no answer from ${origin} — ${cause}`;
}

const scalar = (v) => (Array.isArray(v) ? v.join(", ")
  : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));
const isEmpty = (v) => v === null || v === undefined || v === ""
  || (Array.isArray(v) && v.length === 0);
const headLine = (t) => [t.id, t.status, t.frontmatter?.type, t.frontmatter?.title]
  .map((v) => v ?? "-").join("  ");

/**
 * BLZ-709: what a read prints on stdout. `--json` is the answer's payload, exactly; otherwise
 * one line per ticket or project, or one ticket's header, fields and body. The count line is
 * not here: `runRemote` writes it to stderr, so `--json` stdout stays parseable.
 */
export function renderRead(req, answer, origin) {
  if (req.json) return JSON.stringify(answer.ticket ?? answer.tickets ?? answer.projects, null, 2);
  if (req.read === "ticket") {
    const t = answer.ticket;
    const fields = Object.entries(t.frontmatter ?? {})
      .filter(([k, v]) => !["id", "title", "type", "project"].includes(k) && !isEmpty(v))
      .map(([k, v]) => `  ${k}: ${scalar(v)}`);
    return [headLine(t), ...fields, "", t.body ?? ""].join("\n");
  }
  if (req.read === "tickets") return answer.tickets.map(headLine).join("\n");
  return answer.projects.map((p) => `${p.key}  labels: ${(p.labels ?? []).join(", ") || "-"}  `
    + `components: ${(p.components ?? []).join(", ") || "-"}`).join("\n");
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
 * One request to the configured origin, and nowhere else: the URL is built against
 * `cfg.origin` (a `path` can only ever be a path on it), the token rides in `Authorization`,
 * and a redirect is an ERROR rather than followed. Shared by `runRemote` and
 * `scripts/ops/concurrency-proof.mjs` (BLZ-684), so there is one place that sends the token.
 * @returns { status, ok, statusText, answer } — `answer` is the parsed JSON body, or null
 * @throws when no response arrives: a network error, or a redirect (refused, never followed)
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
 * @returns the process exit code: 0 done, 1 refused or failed
 */
export async function runRemote(verb, argv, { env = process.env, fetch: fetchImpl = globalThis.fetch,
                                              out = console.log, err = console.error } = {}) {
  const cfg = remoteFrom(env);
  if (cfg.error) { err(cfg.error); return 1; }
  if (!cfg.remote) { err("blaze: remote mode is not configured"); return 1; }
  const req = requestFor(verb, argv);
  if (req.error) { err(req.error); return 1; }
  let res;
  try {
    res = await requestRemote(cfg, req.method, req.path, req.body, { fetch: fetchImpl });
  } catch (e) {
    // A refused redirect or no answer at all — never a success (`failureLine`).
    err(failureLine(`blaze ${verb}`, cfg.origin, e));
    return 1;
  }
  const { answer } = res;
  if (!res.ok || !answer || answer.ok !== true) {
    const errors = Array.isArray(answer?.errors) ? answer.errors : [`HTTP ${res.status} ${res.statusText}`.trim()];
    err(`blaze ${verb} failed (${cfg.origin} answered ${res.status}):\n  ${errors.join("\n  ")}`);
    return 1;
  }
  for (const w of Array.isArray(answer.warnings) ? answer.warnings : []) err(`warning: ${w}`);
  if (!req.read) { out(successLine(verb, req.body, answer, cfg.origin)); return 0; }
  // BLZ-709: a read. A 200 that lacks the payload its route promises is a failure, never
  // "undefined" on stdout or a throw. Then the rendering on stdout, the count on stderr.
  const payload = { ticket: answer.ticket, tickets: answer.tickets, projects: answer.projects }[req.read];
  const wellFormed = req.read === "ticket"
    ? payload !== null && typeof payload === "object" && !Array.isArray(payload)
    : Array.isArray(payload);
  if (!wellFormed) { err(`blaze ${verb} failed: malformed answer`); return 1; }
  const text = renderRead(req, answer, cfg.origin);
  if (text !== "") out(text);
  if (req.read === "tickets") err(`${answer.tickets.length} ticket(s) (remote: ${cfg.origin})`);
  if (req.read === "projects") err(`${answer.projects.length} project(s) (remote: ${cfg.origin})`);
  return 0;
}
