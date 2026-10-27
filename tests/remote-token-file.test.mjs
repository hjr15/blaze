// tests/remote-token-file.test.mjs — BLZ-710: BLAZE_TOKEN_FILE, and a TLS-trust hint.
//
// Remote mode's credential can come from a file (mode 0600) instead of the environment, so an
// agent's shell never holds the token itself. The file's CONTENT is a credential: no message,
// log line or test failure text may carry it. So the secret below is built at run time (no
// literal token sits in this source), and every assertion on text that could hold it is
// `assert.ok(re.test(..))` / `assert.ok(!text.includes(SECRET))` — never `assert.match` or
// `assert.equal`, whose failure output would print the text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteFrom, runRemote, failureLine, REMOTE_TOKEN_FILE_ENV } from "../scripts/remote-client.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");
const SECRET = "blz_" + "S3CRETVALUE";
const URL_ = "https://b.example";

function tokenFile(content, name = "token") {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blz710-token-")));
  const f = join(dir, name);
  writeFileSync(f, content, { mode: 0o600 });
  return f;
}

test("BLZ-710: the env name is exported", () => {
  assert.equal(REMOTE_TOKEN_FILE_ENV, "BLAZE_TOKEN_FILE");
});

test("BLZ-710: the token is read from BLAZE_TOKEN_FILE when BLAZE_TOKEN is unset", () => {
  const f = tokenFile(SECRET + "\n");
  const r = remoteFrom({ BLAZE_REMOTE_URL: URL_, BLAZE_TOKEN_FILE: f });
  assert.ok(r.remote === true && r.origin === URL_, "remote, to the origin");
  assert.ok(r.token === SECRET, "the token is the file's content, trimmed");
  // An empty or whitespace BLAZE_TOKEN counts as unset, so the file is still used.
  const r2 = remoteFrom({ BLAZE_REMOTE_URL: URL_, BLAZE_TOKEN: "  ", BLAZE_TOKEN_FILE: f });
  assert.ok(r2.token === SECRET, "a blank BLAZE_TOKEN falls through to the file");
});

test("BLZ-710: BLAZE_TOKEN wins over the file", () => {
  const f = tokenFile(SECRET);
  let reads = 0;
  const r = remoteFrom({ BLAZE_REMOTE_URL: URL_, BLAZE_TOKEN: "blz_env", BLAZE_TOKEN_FILE: f },
                       { readFile: () => { reads++; return SECRET; } });
  assert.deepEqual(r, { remote: true, origin: URL_, token: "blz_env" });
  assert.equal(reads, 0, "the file is not even read when BLAZE_TOKEN is set");
});

test("BLZ-710: URL plus file alone is complete; file alone is half-set", () => {
  const f = tokenFile(SECRET);
  assert.ok(remoteFrom({ BLAZE_REMOTE_URL: URL_, BLAZE_TOKEN_FILE: f }).remote === true, "URL + file is remote");
  const half = remoteFrom({ BLAZE_TOKEN_FILE: f });
  assert.ok(typeof half.error === "string", "file alone is an error");
  assert.ok(/needs both BLAZE_REMOTE_URL and BLAZE_TOKEN \(or BLAZE_TOKEN_FILE\)/.test(half.error), "names both sources");
  assert.ok(/BLAZE_TOKEN_FILE is set and BLAZE_REMOTE_URL is not/.test(half.error), "says which half is set");
  assert.ok(!half.error.includes(SECRET), "never the content");
  const urlOnly = remoteFrom({ BLAZE_REMOTE_URL: URL_ });
  assert.ok(/needs both BLAZE_REMOTE_URL and BLAZE_TOKEN \(or BLAZE_TOKEN_FILE\).*BLAZE_REMOTE_URL is set and BLAZE_TOKEN \(or BLAZE_TOKEN_FILE\) is not/
    .test(urlOnly.error), "URL alone names the credential as either source");
  assert.deepEqual(remoteFrom({ BLAZE_TOKEN_FILE: "  " }), { remote: false }, "a blank path is unset");
});

test("BLZ-710: a missing, empty or whitespace token file is one line naming the path, never the content", () => {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blz710-bad-")));
  const missing = join(dir, "nope");
  const empty = tokenFile("\n  \n");
  const spaced = tokenFile(SECRET.slice(0, 6) + " " + SECRET.slice(6) + "\n");
  const cases = [
    [missing, /^blaze: BLAZE_TOKEN_FILE \(.*\) could not be read \(ENOENT\)$/],
    [empty, /^blaze: BLAZE_TOKEN_FILE \(.*\) is empty$/],
    [spaced, /^blaze: BLAZE_TOKEN_FILE \(.*\) contains whitespace$/],
  ];
  for (const [f, re] of cases) {
    const { error } = remoteFrom({ BLAZE_REMOTE_URL: URL_, BLAZE_TOKEN_FILE: f });
    assert.ok(typeof error === "string", `${f}: an error`);
    assert.ok(error.includes(`(${f})`), `${f}: names the path`);
    assert.ok(re.test(error), `${f}: the expected one-line message`);
    assert.ok(!error.includes("\n"), `${f}: one line`);
    assert.ok(!error.includes(SECRET.slice(4)), `${f}: never the content`);
    assert.ok(!error.includes(SECRET.slice(0, 6)), `${f}: not even its first half`);
  }
});

test("BLZ-710: the file is read as a regular file only — a directory or a FIFO is refused", () => {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blz710-irregular-")));
  const sub = join(dir, "adir");
  mkdirSync(sub);
  const r = remoteFrom({ BLAZE_REMOTE_URL: URL_, BLAZE_TOKEN_FILE: sub });
  assert.ok(/BLAZE_TOKEN_FILE \(.*adir\) could not be read \(ERR_BLAZE_NOT_A_REGULAR_FILE\)/.test(r.error),
            "a directory is refused by type");
  const fifo = join(dir, "fifo");
  if (spawnSync("mkfifo", [fifo]).status === 0) {
    // readFileSync would block forever opening a FIFO with no writer; readRegularFileSync refuses.
    const f = remoteFrom({ BLAZE_REMOTE_URL: URL_, BLAZE_TOKEN_FILE: fifo });
    assert.ok(/could not be read \(ERR_BLAZE_NOT_A_REGULAR_FILE\)/.test(f.error), "a FIFO is refused, not opened");
  }
});

test("BLZ-710: the token from the file never appears on a failed run", async () => {
  const f = tokenFile(SECRET + "\n");
  const env = { BLAZE_REMOTE_URL: URL_, BLAZE_TOKEN_FILE: f };
  const stubs = [
    async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }); },
    async () => new Response(JSON.stringify({ errors: ["bad token"] }), { status: 401 }),
  ];
  for (const fetch of stubs) {
    const out = []; const err = [];
    const seen = [];
    const code = await runRemote("move", ["ENG-1", "done"], {
      env, fetch: async (url, init) => { seen.push(init.headers.authorization); return fetch(url, init); },
      out: (l) => out.push(l), err: (l) => err.push(l) });
    assert.equal(code, 1);
    assert.ok(seen.length === 1 && seen[0] === `Bearer ${SECRET}`, "the file's token was the one sent");
    const text = [...out, ...err].join("\n");
    assert.ok(text.length > 0, "the failure said something");
    assert.ok(!text.includes(SECRET), "the token never reaches output");
  }
});

test("BLZ-710: each TLS trust failure names NODE_EXTRA_CA_CERTS", () => {
  for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
                      "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]) {
    const line = failureLine("blaze new", URL_,
      new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code }) }));
    assert.match(line, /NODE_EXTRA_CA_CERTS/, code);
    assert.ok(line.includes(code), `${code}: names the code`);
    assert.equal(line, `blaze new: ${URL_}'s TLS certificate is not trusted on this machine (${code}). `
      + "Point NODE_EXTRA_CA_CERTS at the CA certificate that signed it — e.g. "
      + "NODE_EXTRA_CA_CERTS=/path/to/ca.crt — and run again.");
  }
  const other = failureLine("blaze new", URL_,
    new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }));
  assert.doesNotMatch(other, /NODE_EXTRA_CA_CERTS/);
  assert.equal(other, `blaze new: no answer from ${URL_} — connect ECONNREFUSED`, "every other cause keeps today's line");
});

function blaze(args, extraEnv) {
  const cwd = scratch(mkdtempSync(join(tmpdir(), "blz710-cwd-")));
  const env = { ...process.env };
  for (const k of ["BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_TOKEN_FILE", "BLAZE_WRITE_PORT", "BLAZE_READONLY"]) delete env[k];
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let stdout = ""; let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("BLZ-710: blaze enters remote mode on BLAZE_TOKEN_FILE alone with the URL", async () => {
  const f = tokenFile(SECRET + "\n");
  const r = await blaze(["move", "ENG-1", "done"], { BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN_FILE: f });
  assert.equal(r.status, 1);
  assert.ok(/no answer from http:\/\/127\.0\.0\.1:9/.test(r.stderr), "remote, not local");
  assert.ok(!(r.stdout + r.stderr).includes(SECRET), "the token never reaches output");
});

test("BLZ-710: BLAZE_TOKEN_FILE alone turns the CLI's remote gate on, and is refused as half-set", async () => {
  const f = tokenFile(SECRET + "\n");
  const r = await blaze(["move", "ENG-1", "done"], { BLAZE_TOKEN_FILE: f });
  assert.equal(r.status, 1);
  assert.ok(/remote mode needs both BLAZE_REMOTE_URL and BLAZE_TOKEN \(or BLAZE_TOKEN_FILE\)/.test(r.stderr),
            "the gate saw the file: a half-set refusal, never a local run");
  assert.ok(!(r.stdout + r.stderr).includes(SECRET), "the token never reaches output");
});

test("BLZ-710 review: the plain-http and user:pass@ refusals name the file as a credential source too", () => {
  const f = tokenFile(SECRET + "\n");
  for (const [url, re] of [
    ["http://blaze.example.com", /plain http to blaze\.example\.com, which would send the token from BLAZE_TOKEN \(or BLAZE_TOKEN_FILE\) in the clear/],
    ["https://user:pw@blaze.example.com", /must not carry a user:password@ — the credential is BLAZE_TOKEN \(or BLAZE_TOKEN_FILE\)/],
  ]) {
    const { error } = remoteFrom({ BLAZE_REMOTE_URL: url, BLAZE_TOKEN_FILE: f });
    assert.ok(typeof error === "string" && re.test(error), `${url}: names both sources`);
    assert.ok(!error.includes(SECRET), `${url}: never the content`);
  }
});
