// canonicalEntityName is what makes digest matching usable (D62).
//
// The whole scheme rests on one property: two spellings of the same company
// must reduce to ONE string, or every legitimate payment fails on a suffix.
// These tests pin that property, and the cases where it must NOT collapse.

import { describe, expect, it } from "vitest";
import { canonicalEntityName, nameSimilarity } from "../src/scoring/index.js";

describe("canonicalEntityName", () => {
  it("collapses the corporate-suffix and casing variants that must agree", () => {
    // The live sandbox pair: these scored 1.0 under the old similarity rule, so
    // they have to keep matching under digests or the change is a regression.
    expect(canonicalEntityName("MERIDIAN COMPONENTS PRIVATE LIMITED")).toBe(
      canonicalEntityName("Meridian Components Pvt Ltd"),
    );
  });

  it("is order-insensitive, because the score it replaces compared SETS", () => {
    expect(canonicalEntityName("Components Meridian")).toBe(
      canonicalEntityName("Meridian Components"),
    );
  });

  it("ignores punctuation the old normaliser stripped", () => {
    expect(canonicalEntityName("Meridian-Components (Pvt.) Ltd.")).toBe(
      canonicalEntityName("Meridian Components"),
    );
  });

  it("de-duplicates repeated tokens", () => {
    // Set semantics again: a repeated word never changed the score.
    expect(canonicalEntityName("Meridian Meridian Components")).toBe(
      canonicalEntityName("Meridian Components"),
    );
  });

  it("returns null when nothing distinguishing survives", () => {
    // "Private Limited" is all suffix. Hashing the empty string would make every
    // such name match every other — the fail-open this must not have.
    expect(canonicalEntityName("Private Limited")).toBeNull();
    expect(canonicalEntityName("Pvt Ltd")).toBeNull();
    expect(canonicalEntityName("   ")).toBeNull();
  });

  it("does NOT collapse genuinely different companies", () => {
    expect(canonicalEntityName("Meridian Components")).not.toBe(
      canonicalEntityName("Rakesh Traders"),
    );
  });

  it("does NOT tolerate a typo — this is the cost of exactness", () => {
    // Under the old rule this scored ~0.5 and reached a human as REVERIFY.
    // Now it is a flat mismatch. Recorded as a test so the trade is visible
    // rather than discovered in production (D62).
    expect(canonicalEntityName("Meridian Componentz")).not.toBe(
      canonicalEntityName("Meridian Components"),
    );
    expect(nameSimilarity("Meridian Componentz", "Meridian Components")).toBeLessThan(1);
  });

  it("agrees with the similarity rule wherever that rule said 1.0", () => {
    // The equivalence that justifies the swap: anything the old rule called a
    // perfect match must still match.
    const pairs: [string, string][] = [
      ["MERIDIAN COMPONENTS PRIVATE LIMITED", "Meridian Components Pvt Ltd"],
      ["Acme Industries LLC", "acme industries"],
      ["Zenith Traders Inc.", "ZENITH TRADERS"],
    ];
    for (const [left, right] of pairs) {
      expect(nameSimilarity(left, right)).toBe(1);
      expect(canonicalEntityName(left)).toBe(canonicalEntityName(right));
    }
  });
});
