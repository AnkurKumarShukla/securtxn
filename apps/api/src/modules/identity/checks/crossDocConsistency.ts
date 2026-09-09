// Check 2 of 4: cross-document consistency.
//
// Name, date of birth and gender must agree between the Aadhaar and the PAN.
// A mismatch is a strong fraud signal and must block CONFIRMED (D04) — it is
// not a data-entry nuisance to be smoothed over.
//
// Every comparison runs through the normalisers first. Comparing raw strings
// rejects a legitimate user, because the same person is formatted three
// different ways across these sources (D10).
//
// Spec: docs/architecture.md §4.7

import type { AadhaarDocument } from "../parse/aadhaar.js";
import type { PanDocument } from "../parse/pan.js";
import type { UserProfile } from "../parse/profile.js";
import { datesMatch, gendersMatch, namesMatch } from "../normalise/index.js";

export type ConsistencyResult = {
  consistent: boolean;
  /**
   * Field NAMES only. The values are the person's legal identity, and this
   * result travels into error responses and logs — naming the field is enough
   * to debug a mismatch without publishing a date of birth (D06).
   */
  mismatchedFields: string[];
  /** Fields absent from one side entirely, which cannot be compared. */
  missingFields: string[];
};

export function checkCrossDocConsistency(
  aadhaar: AadhaarDocument,
  pan: PanDocument,
  profile?: UserProfile,
): ConsistencyResult {
  const mismatchedFields: string[] = [];
  const missingFields: string[] = [];

  const compare = (
    field: string,
    left: unknown,
    right: unknown,
    matcher: (a: unknown, b: unknown) => boolean,
  ): void => {
    if (left === null || left === undefined || right === null || right === undefined) {
      missingFields.push(field);
      return;
    }
    if (!matcher(left, right)) mismatchedFields.push(field);
  };

  compare("name", aadhaar.name, pan.name, namesMatch);
  compare("dob", aadhaar.dob, pan.dob, datesMatch);
  compare("gender", aadhaar.gender, pan.gender, gendersMatch);

  // The profile is unsigned aggregator data, so it is cross-checked but held to
  // the same standard: if it disagrees with a signed document, something is
  // wrong somewhere and a human should look (D04).
  if (profile) {
    if (profile.name !== null) compare("profile.name", aadhaar.name, profile.name, namesMatch);
    if (profile.dob !== null) compare("profile.dob", aadhaar.dob, profile.dob, datesMatch);
    if (profile.gender !== null) {
      compare("profile.gender", aadhaar.gender, profile.gender, gendersMatch);
    }
  }

  return {
    // A field that could not be compared is not a pass. Missing identity data
    // fails the check rather than being quietly skipped.
    consistent: mismatchedFields.length === 0 && missingFields.length === 0,
    mismatchedFields,
    missingFields,
  };
}
