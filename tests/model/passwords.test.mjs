// tests/model/passwords.test.mjs — BLZ-566. The local password verifier.
//
// ADR-0013 §2 named "a local password today" as the first way a user proves who they
// are, and then nothing stored one. This is that store's pure half: a KDF verifier
// string, a constant-time comparison, and a policy. It touches no database.
//
// The property that is easy to lose and expensive to lose is the LAST one in this file:
// the unknown-account path must still pay the KDF cost, or sign-in answers "no such
// account" in a microsecond and "wrong password" in a hundred milliseconds, and the
// identical 401 body stops meaning anything.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkPasswordPolicy, hashPassword, verifyAgainst, MIN_PASSWORD_LENGTH }
  from "../../scripts/model/passwords.mjs";

describe("a password is stored as a verifier, never as itself", () => {
  test("the verifier does not contain the password", async () => {
    const verifier = await hashPassword("correct horse battery staple");
    assert.doesNotMatch(verifier, /correct horse battery staple/);
    assert.match(verifier, /^scrypt\$/, "the verifier names its own KDF and parameters");
  });

  test("two hashes of the same password differ — the salt is per-password", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    assert.notEqual(a, b);
  });

  test("the right password verifies and a wrong one does not", async () => {
    const verifier = await hashPassword("correct horse battery staple");
    assert.equal((await verifyAgainst(verifier, "correct horse battery staple")).ok, true);
    assert.equal((await verifyAgainst(verifier, "correct horse battery stapl")).ok, false);
  });

  test("a malformed verifier is refused, never thrown over", async () => {
    for (const bad of ["", "not-a-verifier", "scrypt$x$8$1$aa$bb", "argon2$1$2$3$aa$bb"]) {
      const r = await verifyAgainst(bad, "anything");
      assert.equal(r.ok, false, `${JSON.stringify(bad)} must not verify`);
    }
  });
});

describe("the policy is a floor, and it is checked before anything is stored", () => {
  test(`a password shorter than ${MIN_PASSWORD_LENGTH} characters is refused`, () => {
    const r = checkPasswordPolicy("x".repeat(MIN_PASSWORD_LENGTH - 1));
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(String(MIN_PASSWORD_LENGTH)));
  });

  test("a password at the floor is accepted", () => {
    assert.equal(checkPasswordPolicy("x".repeat(MIN_PASSWORD_LENGTH)).ok, true);
  });

  test("a non-string is not a short password — it is not a password", () => {
    for (const bad of [null, undefined, 12345678901234, {}, []]) {
      assert.equal(checkPasswordPolicy(bad).ok, false);
    }
  });

  test("an unbounded password is refused rather than handed to the KDF", () => {
    assert.equal(checkPasswordPolicy("x".repeat(4097)).ok, false);
  });
});

describe("an account with no password still pays the KDF cost", () => {
  // THIS IS THE ORACLE FOR THE IDENTICAL-401 CLAIM. `signin` answers exactly the same
  // body for an unknown email and a wrong password; that is worth nothing if the two
  // take visibly different times. `verifyAgainst(null, …)` derives against a decoy so
  // the unknown-account branch costs what the known-account branch costs.
  test("verifyAgainst(null, …) is false AND actually derived a key", async () => {
    const r = await verifyAgainst(null, "anything at all");
    assert.equal(r.ok, false);
    assert.equal(r.derived, true,
      "the unknown-account path must run the KDF, or the 401 body is a timing oracle");
  });

  test("a real verification also reports that it derived", async () => {
    const verifier = await hashPassword("correct horse battery staple");
    assert.equal((await verifyAgainst(verifier, "wrong")).derived, true);
  });
});
