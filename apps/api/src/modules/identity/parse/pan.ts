// PAN (Income Tax Department) document parser.
//
// Structure verified against the live 2026-09-08 capture.
//
// Spec: docs/architecture.md §4.7

import { attr, firstElement, parseXml, requireElement } from "./xml.js";

export type PanDocument = {
  /** PAN number. Persisted only as an HMAC, never in this form (D06). */
  panNumber: string | null;
  /** "DD-MM-YYYY HH:MM:SS" in the live capture — normalise before comparing. */
  verifiedOn: string | null;
  /** Certificate status; "A" observed for an active PAN. */
  status: string | null;
  certificateType: string | null;

  name: string | null;
  dob: string | null;
  gender: string | null;

  /**
   * The DigiLocker user id. Must equal the id embedded in the Aadhaar KycRes
   * txn string — that equality is what proves both documents describe the same
   * subject (D02), and it is the identity primary key.
   */
  personUid: string | null;
};

const CONTEXT = "PAN document";

export function parsePan(raw: string): PanDocument {
  const doc = parseXml(raw);

  const certificate = requireElement(doc, "Certificate", CONTEXT);
  const person = requireElement(doc, "Person", CONTEXT);
  const pan = firstElement(doc, "PAN");

  return {
    panNumber: attr(pan, "num"),
    verifiedOn: attr(pan, "verifiedOn"),
    status: attr(certificate, "status"),
    certificateType: attr(certificate, "type"),

    name: attr(person, "name"),
    dob: attr(person, "dob"),
    gender: attr(person, "gender"),

    personUid: attr(person, "uid"),
  };
}
