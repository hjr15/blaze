// tests/helpers/open-driver.mjs — BLZ-534.
//
// A RESOURCE IS RELEASABLE FROM THE INSTANT IT EXISTS, NOT FROM WHEN SETUP FINISHES.
//
// BLZ-534's acceptance criterion is that the leaked `pg` connection is closed ON THE PATH
// THAT LEAKS IT. Two paths leak, and only one of them is a failing assertion:
//
//   * THE ASSERTION PATH. Every test in tests/model/driver-conformance.test.mjs used to end
//     with `await s.close?.()` — the one statement a failing assertion never reaches. Moving
//     teardown into `t.after()` closed that path.
//   * THE SETUP PATH. Registering `t.after` only once the seed has RETURNED leaves the
//     window between "the socket is open" and "setup finished" uncovered, and that window is
//     where `seedPg` does its TRUNCATE and its INSERTs. Reproduced with a real Postgres and a
//     `BEFORE TRUNCATE` trigger that raises: the shipped conformance file ran past a
//     45-second bound and was killed at exit 124 — BLZ-534's exact shape.
//
// So a seed does not RETURN its resources, it RELEASES them: it is handed a `release`
// callback and calls it the statement after each resource becomes live. Whatever has been
// released by the time a throw propagates is torn down, because the `t.after` hook is
// registered before the seed is ever called.
//
// This helper lives outside `tests/` proper on purpose: `scripts/ci/temp-cleanup-guard.mjs`
// is a line scanner that cannot follow cleanup into a helper — its documented blind spot,
// and the reason this defect survived the guard. tests/driver-setup-teardown.test.mjs is the
// check that stands in its place.

/**
 * Run `seed`, tearing down everything it releases whether it returns or throws.
 *
 * @param {(release: (fn: () => unknown) => void) => Promise<{s: unknown, root?: string|null}>} seed
 *   Setup, which must call `release` immediately after each resource becomes live.
 * @param {import("node:test").TestContext} t The test whose `after` hook owns the teardown.
 * @returns whatever `seed` resolves to.
 */
export async function openDriver(seed, t) {
  const teardowns = [];
  // Registered BEFORE `seed` runs. This ordering IS the fix: a throw inside `seed` cannot
  // skip a hook that was already installed.
  t.after(async () => {
    let first;
    // Reverse order, and every one is attempted — a teardown that throws must not strand
    // the resources released before it, which is when a leak matters most.
    for (const release of teardowns.reverse()) {
      try { await release(); } catch (error) { first ??= error; }
    }
    if (first) throw first;
  });
  return seed((fn) => teardowns.push(fn));
}
