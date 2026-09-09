// Aadhaar (UIDAI) document parser.
//
// Structure verified against the live 2026-09-08 capture, NOT inferred from the
// docs — the Poa attribute names are abbreviated in the real document
// (`lm`, `loc`, `pc`) where §4.7 spells them out.
//
// Spec: docs/architecture.md §4.7

import type { StructuredAddress } from "@cp/shared-types";
import { attr, firstElement, parseXml, requireAttr, requireElement, textOf } from "./xml.js";

export type AadhaarDocument = {
  /** Envelope */
  code: string | null;
  /** "Y" on success. */
  ret: string | null;
  ts: string | null;
  /** Re-verification deadline. Observed as issue + 1 year (D06). */
  ttl: string | null;
  /**
   * Carries the DigiLocker user id: "UKC:<userId><timestamp>". The id inside is
   * the same value as the PAN Person@uid — that equality is the same-subject
   * check (D02).
   */
  txn: string | null;

  /** Always masked by UIDAI: "xxxxxxxx1234". The full number is never sent. */
  maskedUid: string | null;
  /** Derived from maskedUid. The only part of the Aadhaar number ever stored. */
  last4: string | null;

  /** Poi — proof of identity. */
  name: string | null;
  dob: string | null;
  gender: string | null;

  /** Poa — proof of address. Government-attested postal address. */
  address: StructuredAddress;

  /** Base64 JPEG portrait, used for face match. Never logged, never on-chain. */
  photoBase64: string | null;
};

const CONTEXT = "Aadhaar document";

export function parseAadhaar(raw: string): AadhaarDocument {
  const doc = parseXml(raw);

  const kycRes = requireElement(doc, "KycRes", CONTEXT);
  const uidData = requireElement(doc, "UidData", CONTEXT);
  const poi = requireElement(doc, "Poi", CONTEXT);
  const poa = firstElement(doc, "Poa");

  const maskedUid = requireAttr(uidData, "uid", CONTEXT);

  return {
    code: attr(kycRes, "code"),
    ret: attr(kycRes, "ret"),
    ts: attr(kycRes, "ts"),
    ttl: attr(kycRes, "ttl"),
    txn: attr(kycRes, "txn"),

    maskedUid,
    last4: extractLast4(maskedUid),

    name: attr(poi, "name"),
    dob: attr(poi, "dob"),
    gender: attr(poi, "gender"),

    // Short attribute names are what the real document uses. Mapping them to
    // readable keys here means nothing downstream has to know that.
    address: {
      ...optional("co", attr(poa, "co")),
      ...optional("street", attr(poa, "street")),
      ...optional("landmark", attr(poa, "lm")),
      ...optional("locality", attr(poa, "loc")),
      ...optional("vtc", attr(poa, "vtc")),
      ...optional("po", attr(poa, "po")),
      ...optional("subdist", attr(poa, "subdist")),
      ...optional("dist", attr(poa, "dist")),
      ...optional("state", attr(poa, "state")),
      ...optional("pincode", attr(poa, "pc")),
      ...optional("country", attr(poa, "country")),
    },

    photoBase64: textOf(firstElement(doc, "Pht")),
  };
}

/**
 * Pulls the DigiLocker user id out of the KycRes txn string.
 *
 * Observed format: "UKC:<32 hex chars><14 digit timestamp>". Anchored to a
 * 32-character hex run so a format change fails loudly instead of returning a
 * truncated id that would silently not match the PAN.
 */
export function extractUserIdFromTxn(txn: string | null): string | null {
  if (!txn) return null;
  const match = /^[A-Z]+:([0-9a-f]{32})\d*$/i.exec(txn.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/** UIDAI returns "xxxxxxxx1234"; only these four digits may ever be stored (D02). */
function extractLast4(maskedUid: string): string | null {
  const match = /(\d{4})$/.exec(maskedUid);
  return match?.[1] ?? null;
}

function optional<K extends string>(key: K, value: string | null): Record<K, string> | undefined {
  return value === null ? undefined : ({ [key]: value } as Record<K, string>);
}
