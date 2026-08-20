// A resolve hook that makes `import("pg")` fail exactly as it does on a machine where
// the optional peer dependency was never installed. `pg` IS present in devDependencies
// (CI runs the Postgres conformance suite), so the absent case cannot be observed
// without simulating it — and it is the case most users will hit first.
export function resolve(specifier, context, next) {
  if (specifier === "pg") {
    const err = new Error(`Cannot find package 'pg'`);
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  }
  return next(specifier, context);
}
