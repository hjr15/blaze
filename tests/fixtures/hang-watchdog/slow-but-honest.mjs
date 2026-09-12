// Fixture for tests/hang-watchdog.test.mjs. NOT a `.test.mjs` file, so `node --test` with no
// arguments never picks it up.
//
// A file that is merely SLOW: it does three seconds of ordinary timer-driven work and leaks
// nothing at all. Run against a deadline shorter than that, it trips the watchdog — because
// the watchdog's timer starts at IMPORT, not at test completion, so it cannot tell this file
// apart from one that has finished and cannot exit. The watchdog must therefore not claim
// it can. This fixture is the reason the verdict wording is what it is.
import { test } from "node:test";

test("three seconds of honest work, leaking nothing", async () => {
  const end = Date.now() + 3_000;
  while (Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
});
