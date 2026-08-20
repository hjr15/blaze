// Makes `import("pg")` fail for a reason that is NOT resolution — the package is
// found, but loading it blows up (a corrupt install, a broken transitive dependency,
// a native binding that will not load). The missing-package guard must NOT claim this
// is a missing package, or a broken install sends people to `npm install pg`, which
// they have already done, and which will not fix it.
export function resolve(specifier, context, next) {
  if (specifier === "pg") {
    const err = new Error("pg exploded on load: simulated corrupt install");
    err.code = "ERR_SOMETHING_ELSE";
    throw err;
  }
  return next(specifier, context);
}
