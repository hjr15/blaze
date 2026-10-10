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
    res = await requestRemote(cfg, "POST", req.path, req.body, { fetch: fetchImpl });
  } catch (e) {
    // The message only: fetch's error never carries the request headers, and nothing here
    // adds them — a redirect refusal reads as "no answer", never as a success.
    err(`blaze ${verb}: no answer from ${cfg.origin} — ${e?.cause?.message ?? e?.message ?? e}`);
    return 1;
  }
  const { answer } = res;
  if (!res.ok || !answer || answer.ok !== true) {
    const errors = Array.isArray(answer?.errors) ? answer.errors : [`HTTP ${res.status} ${res.statusText}`.trim()];
    err(`blaze ${verb} failed (${cfg.origin} answered ${res.status}):\n  ${errors.join("\n  ")}`);
    return 1;
  }
  for (const w of Array.isArray(answer.warnings) ? answer.warnings : []) err(`warning: ${w}`);
  out(successLine(verb, req.body, answer, cfg.origin));
  return 0;
}
