// Check 3 of 4: same-subject linkage.
//
// Two individually valid, individually consistent documents can still describe
// two different people. The DigiLocker user id appears in BOTH — as the PAN
// Person@uid, and embedded in the Aadhaar KycRes txn string — and their
// equality is what proves one subject.
//
// The resulting id is the identity primary key. Never the Aadhaar number, which
// is never even received (D02).
//
// Spec: docs/architecture.md §4.7

import type { AadhaarDocument } from "../parse/aadhaar.js";
import type { PanDocument } from "../parse/pan.js";
import { extractUserIdFromTxn } from "../parse/aadhaar.js";

export type LinkageResult = {
  linked: boolean;
  /** Present only when both sides agree — never a guess from one document. */
  userId: string | null;
  reason: string | null;
};

export function checkSameSubjectLinkage(
  aadhaar: AadhaarDocument,
  pan: PanDocument,
): LinkageResult {
  const fromAadhaar = extractUserIdFromTxn(aadhaar.txn);
  const fromPan = pan.personUid?.trim().toLowerCase() ?? null;

  if (fromAadhaar === null) {
    return { linked: false, userId: null, reason: "no user id embedded in the Aadhaar KycRes txn" };
  }
  if (fromPan === null) {
    return { linked: false, userId: null, reason: "PAN document carries no Person@uid" };
  }
  if (fromAadhaar !== fromPan) {
    // Do not report the two ids. They are pseudonymous account identifiers, and
    // the fact that they differ is the whole finding.
    return {
      linked: false,
      userId: null,
      reason: "Aadhaar and PAN identify different DigiLocker accounts",
    };
  }

  return { linked: true, userId: fromAadhaar, reason: null };
}
