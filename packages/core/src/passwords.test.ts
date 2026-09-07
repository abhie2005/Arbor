import { describe, expect, it } from "vitest";

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PasswordError,
  assertPasswordPolicy,
  normalizeEmail,
} from "./passwords";

describe("password policy", () => {
  it("accepts a long enough password", () => {
    expect(assertPasswordPolicy("correct horse battery")).toBe("correct horse battery");
  });

  it("refuses one that is too short", () => {
    expect(() => assertPasswordPolicy("short")).toThrow(PasswordError);
    expect(() => assertPasswordPolicy("a".repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(/at least/);
    expect(() => assertPasswordPolicy("a".repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it("refuses one long enough to be a denial of service against the hash", () => {
    expect(() => assertPasswordPolicy("a".repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(/limited to/);
  });

  it("refuses nothing at all", () => {
    expect(() => assertPasswordPolicy("")).toThrow(/required/);
    expect(() => assertPasswordPolicy("          ")).toThrow(/required/);
    expect(() => assertPasswordPolicy(undefined)).toThrow(/required/);
  });

  it("does not trim, because spaces are characters someone chose", () => {
    // Trimming means a password manager's stored value stops matching.
    const padded = " a long enough one ";
    expect(assertPasswordPolicy(padded)).toBe(padded);
  });

  it("imposes no composition rules", () => {
    // Length is what costs an attacker; "one uppercase, one digit, one symbol"
    // produces Password1! and nothing else.
    expect(() => assertPasswordPolicy("aaaaaaaaaaaaaaaa")).not.toThrow();
  });
});

describe("email", () => {
  it("lowercases and trims, so the same address is one account", () => {
    expect(normalizeEmail("  Avery@Example.COM ")).toBe("avery@example.com");
  });

  it("refuses something that is not an address", () => {
    for (const bad of ["avery", "avery@", "@example.com", "a b@example.com", "", undefined]) {
      expect(() => normalizeEmail(bad)).toThrow(PasswordError);
    }
  });
});
