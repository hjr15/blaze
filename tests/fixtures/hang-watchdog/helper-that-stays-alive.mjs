// Spawned by tests/fixtures/hang-watchdog/spawns-a-helper-then-leaks.mjs. It never exits on
// its own, so if the watchdog kills the test process without reaping its children, this
// process is left running on the machine — which is exactly what was observed.
setInterval(() => {}, 60_000);
