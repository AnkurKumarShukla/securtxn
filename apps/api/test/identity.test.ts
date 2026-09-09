import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  datesMatch,
  gendersMatch,
  namesMatch,
  normaliseGender,
  normaliseName,
  toIsoDate,
} from "../src/modules/identity/normalise/index.js";
import { parseAadhaar, extractUserIdFromTxn } from "../src/modules/identity/parse/aadhaar.js";
import { parsePan } from "../src/modules/identity/parse/pan.js";
import { parseProfile } from "../src/modules/identity/parse/profile.js";
import { runIdentityChecks } from "../src/modules/identity/checks/index.js";
import { verifyXmlSignature } from "../src/modules/identity/checks/xmldsig.js";
import { MockIdentityProvider } from "../src/modules/identity/providers/MockIdentityProvider.js";
import { fixtureOracle } from "./fixtures/oracle.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const REAL_FIXTURES = join(REPO_ROOT, "fixtures", "digilocker");
const hasRealFixtures = existsSync(join(REAL_FIXTURES, "documents", "aadhaar.xml"));

// ---------------------------------------------------------------------------
// Normalisation. Pure, and the single most likely source of a false rejection
// of a legitimate user (D10) — so these run everywhere, fixtures or not.
// ---------------------------------------------------------------------------

describe("date normalisation", () => {
  it("treats the three observed formats as the same date", () => {
    expect(toIsoDate("19/11/2001")).toBe("2001-11-19"); // profile
    expect(toIsoDate("19-11-2001")).toBe("2001-11-19"); // Aadhaar and PAN
    expect(datesMatch("19/11/2001", "19-11-2001")).toBe(true);
  });

  it("handles the documented unix-ms form as well as the observed string", () => {
    // The profile endpoint documents a timestamp but returned a string live.
    expect(toIsoDate(Date.UTC(2001, 10, 19))).toBe("2001-11-19");
    expect(toIsoDate("1006128000000")).toBe("2001-11-19");
  });

  it("reads day-first, not month-first", () => {
    // 11/09 is 11 September in these sources. Reading it as 9 November would
    // silently compare two different real dates.
    expect(toIsoDate("11/09/2001")).toBe("2001-09-11");
  });

  it("rejects impossible dates instead of rolling them over", () => {
    // new Date(2001, 12, 32) quietly becomes a valid date in the next month.
    expect(toIsoDate("32-01-2001")).toBeNull();
    expect(toIsoDate("01-13-2001")).toBeNull();
  });

  it("returns null rather than matching on missing data", () => {
    expect(datesMatch(null, null)).toBe(false);
    expect(datesMatch("", "")).toBe(false);
  });
});

describe("gender normalisation", () => {
  it("collapses the three observed representations", () => {
    expect(normaliseGender("male")).toBe("MALE"); // profile
    expect(normaliseGender("M")).toBe("MALE"); // Aadhaar
    expect(normaliseGender("MALE")).toBe("MALE"); // PAN
    expect(gendersMatch("M", "MALE")).toBe(true);
    expect(gendersMatch("male", "M")).toBe(true);
  });

  it("does not match unknown values to anything", () => {
    expect(normaliseGender("unspecified")).toBeNull();
    expect(gendersMatch("unspecified", "unspecified")).toBe(false);
  });
});

describe("name normalisation", () => {
  it("compares case-insensitively across sources", () => {
    expect(namesMatch("Priya Kumar Sharma", "PRIYA KUMAR SHARMA")).toBe(true);
  });

  it("collapses whitespace and punctuation differences", () => {
    expect(namesMatch("A. K.  Sharma", "A K Sharma")).toBe(true);
    expect(normaliseName("  Priya   Kumar ")).toBe("priya kumar");
  });

  it("is exact, not fuzzy — different people must not match", () => {
    // A similarity threshold here would let one person's documents vouch for
    // another's. Fuzzy scoring belongs in vendor matching, not in a boolean
    // that gates money.
    expect(namesMatch("Priya Kumar", "Priya Kumari")).toBe(false);
    expect(namesMatch("Priya Kumar Sharma", "Priya Sharma")).toBe(false);
  });
});

describe("txn user-id extraction", () => {
  it("pulls the 32-char id out of the KycRes txn", () => {
    expect(extractUserIdFromTxn("UKC:0123456789abcdef0123456789abcdef20260903040949")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
  });

  it("returns null on an unexpected format rather than a truncated id", () => {
    // A partial id would silently fail to match the PAN, which reads as
    // "different people" instead of "we could not parse this".
    expect(extractUserIdFromTxn("0123456f")).toBeNull();
    expect(extractUserIdFromTxn("UKC:")).toBeNull();
    expect(extractUserIdFromTxn(null)).toBeNull();
  });
});

describe("profile parsing", () => {
  it("accepts both the response envelope and a bare data object", () => {
    const envelope = parseProfile({ code: 200, data: { name: "A", date_of_birth: "19/11/2001" } });
    const bare = parseProfile({ name: "A", date_of_birth: "19/11/2001" });
    expect(envelope.name).toBe("A");
    expect(bare.name).toBe("A");
  });

  it("normalises an empty email to null", () => {
    expect(parseProfile({ email: "" }).email).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Replay against the real recorded capture. These are the assertions
// fixtures/digilocker/index.json defines as the test oracle (§4.7.1).
//
// Skipped when the real tier is absent — it is gitignored, so a fresh clone or
// CI has only the synthetic tier (D11).
// ---------------------------------------------------------------------------

describe.skipIf(!hasRealFixtures)("fixture replay (real tier)", () => {
  const aadhaarXml = readFileSync(join(REAL_FIXTURES, "documents", "aadhaar.xml"), "utf8");
  const panXml = readFileSync(join(REAL_FIXTURES, "documents", "pan.xml"), "utf8");
  const expected = JSON.parse(
    readFileSync(join(REAL_FIXTURES, "index.json"), "utf8"),
  ).expected_check_results as Record<string, unknown>;

  it("verifies both document signatures against the embedded certificate", () => {
    for (const xml of [aadhaarXml, panXml]) {
      const result = verifyXmlSignature(xml);
      expect(result.integrityValid).toBe(true);
      expect(result.trusted).toBe(true);
      expect(result.signerSubject).toContain("DIGITAL INDIA CORPORATION");
    }
  });

  it("detects a single altered character of content", () => {
    // The whole security property in one assertion: change what the document
    // says and the digest stops matching (D04).
    const last4 = fixtureOracle().aadhaarLast4;
    const tampered = aadhaarXml.replace(`uid="xxxxxxxx${last4}"`, 'uid="xxxxxxxx0000"');
    expect(tampered).not.toBe(aadhaarXml);
    expect(verifyXmlSignature(tampered).integrityValid).toBe(false);
  });

  it("tolerates edits that canonicalisation removes", () => {
    // Exclusive C14N normalises attribute syntax before digesting, so extra
    // whitespace inside a tag is NOT tampering — the document still says the
    // same thing. Worth pinning: a test that treats this as a failure would be
    // asserting the wrong security property.
    const reformatted = aadhaarXml.replace('name="', 'name ="');
    expect(reformatted).not.toBe(aadhaarXml);
    expect(verifyXmlSignature(reformatted).integrityValid).toBe(true);
  });

  it("rejects a document whose signature was stripped", () => {
    const unsigned = aadhaarXml.replace(/<Signature[\s\S]*<\/Signature>/, "");
    const result = verifyXmlSignature(unsigned);
    expect(result.verified).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/no <Signature>/);
  });

  it("reproduces every value in index.json expected_check_results", () => {
    const outcome = runIdentityChecks({ aadhaarXml, panXml });

    expect(outcome.results.xmlSignatureVerified).toBe(expected.xmlSignatureVerified);
    expect(outcome.results.crossDocConsistent).toBe(expected.crossDocConsistent);
    expect(outcome.userId).toBe(expected.digilockerUserId);
    expect(outcome.aadhaarLast4).toBe(expected.aadhaarLast4);
    // index.json records the ttl in its source timezone (IST). Compare the
    // instant, not a UTC calendar day — the two differ, which is exactly the
    // trap that made the deadline depend on server timezone.
    expect(outcome.ttl?.getTime()).toBe(
      new Date(`${String(expected.aadhaarKycTtl)}+05:30`).getTime(),
    );

    expect(outcome.results.sameSubjectLinked).toBe(true);
    expect(outcome.results.ttlCaptured).toBe(true);
    expect(outcome.passed).toBe(true);
    expect(outcome.failures).toEqual([]);
  });

  it("extracts the attested address using the real short attribute names", () => {
    // The live document abbreviates: lm / loc / pc, not landmark / locality /
    // pincode as the prose spells them. Coding from the docs yields an empty
    // address and a vendor who never reaches TIER3.
    const aadhaar = parseAadhaar(aadhaarXml);
    expect(aadhaar.address.state).toBeTruthy();
    expect(aadhaar.address.pincode).toMatch(/^\d{6}$/);
    expect(aadhaar.address.dist).toBeTruthy();
  });

  it("never exposes more than the last four Aadhaar digits", () => {
    const aadhaar = parseAadhaar(aadhaarXml);
    expect(aadhaar.maskedUid).toMatch(/^x+\d{4}$/);
    expect(aadhaar.last4).toHaveLength(4);
  });

  it("reads the PAN linkage id and verification date", () => {
    const pan = parsePan(panXml);
    expect(pan.personUid).toBe(expected.digilockerUserId);
    expect(pan.status).toBe("A");
    expect(toIsoDate(pan.verifiedOn?.split(" ")[0])).toBeTruthy();
  });

  // --- rejection paths, driven by injection rather than by waiting (D21) ---

  it("fails linkage when the two documents describe different accounts", () => {
    const otherAccount = panXml.replace(
      /uid="[0-9a-f]{32}"/,
      'uid="ffffffffffffffffffffffffffffffff"',
    );
    const outcome = runIdentityChecks({ aadhaarXml, panXml: otherAccount });
    expect(outcome.results.sameSubjectLinked).toBe(false);
    expect(outcome.passed).toBe(false);
    expect(outcome.failures.join(" ")).toMatch(/different DigiLocker accounts/);
  });

  it("fails the TTL check once the deadline has passed", () => {
    // CONFIRMED is time-bounded; a stale document must not confirm (D06).
    const outcome = runIdentityChecks({ aadhaarXml, panXml, now: new Date("2030-01-01") });
    expect(outcome.results.ttlCaptured).toBe(false);
    expect(outcome.passed).toBe(false);
  });

  it("fails when the signing certificate is not an accepted issuer", () => {
    const outcome = runIdentityChecks({
      aadhaarXml,
      panXml,
      trustPolicy: {
        requiredSubjectFragments: ["SOME OTHER AUTHORITY"],
        pinnedFingerprints: [],
        requireCurrentValidity: true,
      },
    });
    // Integrity still holds — the bytes are intact. Trust does not, which is
    // exactly the distinction the check keeps separate.
    expect(outcome.results.xmlSignatureVerified).toBe(false);
    expect(outcome.passed).toBe(false);
  });

  it("fails when a pinned fingerprint does not match", () => {
    const outcome = runIdentityChecks({
      aadhaarXml,
      panXml,
      trustPolicy: {
        requiredSubjectFragments: [],
        pinnedFingerprints: ["AA:BB:CC"],
        requireCurrentValidity: true,
      },
    });
    expect(outcome.results.xmlSignatureVerified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider behaviour: the state machine must stay honest in mock mode (D17).
// ---------------------------------------------------------------------------

describe.skipIf(!hasRealFixtures)("MockIdentityProvider", () => {
  const build = (): MockIdentityProvider =>
    new MockIdentityProvider({
      fixtureDir: REAL_FIXTURES,
      consentStubBaseUrl: "http://localhost:3001/mock/digilocker-consent",
    });

  it("starts a session in 'created', not 'succeeded'", async () => {
    const provider = build();
    const { sessionId, authorizationUrl } = await provider.startSession({ docTypes: ["aadhaar", "pan"] });

    const status = await provider.getStatus(sessionId);
    expect(status.status).toBe("created");
    // Nothing is consented before the human step.
    expect(status.consented).toEqual([]);
    expect(authorizationUrl).toContain("mock/digilocker-consent");
  });

  it("refuses to hand over documents before consent", async () => {
    const provider = build();
    const { sessionId } = await provider.startSession({ docTypes: ["aadhaar", "pan"] });
    await expect(provider.fetchIdentity(sessionId)).rejects.toThrow(/only available after consent/);
  });

  it("advances to succeeded only when the consent stub is visited", async () => {
    const provider = build();
    const { sessionId } = await provider.startSession({ docTypes: ["aadhaar", "pan"] });

    provider.grantConsent(sessionId);

    const status = await provider.getStatus(sessionId);
    expect(status.status).toBe("succeeded");
    expect(status.consented).toEqual(["aadhaar", "pan"]);
  });

  it("returns a verified identity after consent", async () => {
    const provider = build();
    const { sessionId } = await provider.startSession({ docTypes: ["aadhaar", "pan"] });
    provider.grantConsent(sessionId);

    const identity = await provider.fetchIdentity(sessionId);
    expect(identity.providerUserId).toBe(fixtureOracle().digilockerUserId);
    expect(identity.signatureVerified).toBe(true);
    expect(identity.ttl).toBeInstanceOf(Date);
    expect(identity.photoBase64).toBeTruthy();
  });

  it("reports failed and expired sessions", async () => {
    const provider = build();
    const { sessionId } = await provider.startSession({ docTypes: ["aadhaar"] });
    provider.failSession(sessionId, "expired");
    expect((await provider.getStatus(sessionId)).status).toBe("expired");
    await expect(provider.fetchIdentity(sessionId)).rejects.toThrow();
  });

  it("404s on an unknown session", async () => {
    await expect(build().getStatus("no-such-session")).rejects.toThrow(/not found/i);
  });
});
