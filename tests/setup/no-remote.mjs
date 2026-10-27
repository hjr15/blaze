// tests/setup/no-remote.mjs — BLZ-684. THE SUITE NEVER WRITES TO A REMOTE BOARD.
//
// With BLAZE_REMOTE_URL and BLAZE_TOKEN both set, `blaze new|move|edit|resolve|log|link` send
// the write to that server with that token. An operator who exported the pair in a shell and
// then ran `npm test` would have had existing CLI tests post real writes to the live board —
// adversarial review reproduced five authenticated writes from three unrelated test files. So
// both — and BLZ-710's BLAZE_TOKEN_FILE, the same credential by another route — are deleted
// from THIS process's environment before any test runs; every process a test spawns inherits
// that environment, and a test that wants remote mode sets the variables itself.
//
// Loaded by `hang-watchdog.mjs` (which every test process preloads with `--import`), so no
// command line has to remember a second flag. `tests/remote-env-guard.test.mjs` pins it.
delete process.env.BLAZE_REMOTE_URL;
delete process.env.BLAZE_TOKEN;
// BLZ-710: the token file is the same credential by another route (review M11).
delete process.env.BLAZE_TOKEN_FILE;
