// The out-of-band callback control.
//
// THE ATTACK: an attacker submits a real company's name and tax id, their own
// wallet, and their own phone number. They sign the control proof correctly —
// it is their wallet. If the operator then dials the number that came with the
// submission, the attacker confirms their own fraud and every check is green.
//
// THE CONTROL: the contact dialled must come from a source INDEPENDENT of the
// submission being confirmed. Never from the request body, never from a field
// the same actor just wrote.
//
// Spec: docs/architecture.md §3, §4.1

import type { Vendor, VendorWallet } from "@prisma/client";

export type IndependentContact = {
  value: string;
  /** Where it came from — recorded so an auditor can see it was independent. */
  source: "REGISTRY_LOOKUP" | "DIGILOCKER_VERIFIED_MOBILE" | "PRE_EXISTING_ON_FILE";
};

export type CallbackCheck =
  | { allowed: true; matched: IndependentContact }
  | { allowed: false; reason: string };

/**
 * Normalises for comparison only.
 *
 * A registry writes "+91 22 5550-0100" and an operator types "+912255500100".
 * Rejecting that difference blocks a legitimate confirmation, so separators are
 * ignored — but nothing else is. Digits must match exactly.
 */
function canonical(phone: string): string {
  return phone.replace(/[\s()\-.]/g, "");
}

/**
 * Builds the set of contacts that may legitimately be dialled.
 *
 * Note what is NOT here: anything from the current request, and anything on the
 * wallet being confirmed. Both are attacker-controlled in the scenario above.
 */
export function independentContactsFor(
  vendor: Vendor,
  decryptedVerifiedPhone: string | null,
): IndependentContact[] {
  const contacts: IndependentContact[] = [];

  // BUSINESS: from an independent business-registry lookup.
  if (vendor.registryVerifiedContact) {
    contacts.push({ value: vendor.registryVerifiedContact, source: "REGISTRY_LOOKUP" });
  }

  // INDIVIDUAL: no business registry exists for a freelancer or sole supplier.
  // The DigiLocker-linked mobile is the equivalent independent source — it is
  // attested by the identity flow, not supplied alongside the wallet.
  if (decryptedVerifiedPhone && vendor.verifiedPhoneAt) {
    contacts.push({
      value: decryptedVerifiedPhone,
      source: "DIGILOCKER_VERIFIED_MOBILE",
    });
  }

  return contacts;
}

/**
 * Decides whether a callback confirmation may be accepted.
 *
 * For an EXISTING vendor changing wallets, a contact only counts if it predates
 * the wallet being confirmed. Otherwise an attacker who has already taken over
 * an account could add a contact and immediately confirm against it.
 */
export function checkCallbackChannel(input: {
  vendor: Vendor;
  wallet: VendorWallet;
  channelUsed: string;
  decryptedVerifiedPhone: string | null;
}): CallbackCheck {
  const contacts = independentContactsFor(input.vendor, input.decryptedVerifiedPhone);

  if (contacts.length === 0) {
    // Fail closed. No independent contact means there is no way to confirm
    // this wallet safely, and "no contact on file" must never mean "skip the
    // check" — that is the demo shortcut that removes the control entirely.
    return {
      allowed: false,
      reason:
        "No independent contact on file for this vendor. Complete identity verification " +
        "or record a registry-verified contact before confirming a wallet.",
    };
  }

  const target = canonical(input.channelUsed);
  const matched = contacts.find((contact) => canonical(contact.value) === target);

  if (!matched) {
    // Do not echo the expected contact. Telling an attacker which number to
    // claim they dialled turns this into a single guess.
    return {
      allowed: false,
      reason:
        "The contact used does not match any independently verified contact for this vendor.",
    };
  }

  // Guards the account-takeover path: a contact recorded after this wallet was
  // submitted is not independent of it.
  if (
    matched.source === "DIGILOCKER_VERIFIED_MOBILE" &&
    input.vendor.verifiedPhoneAt &&
    input.vendor.verifiedPhoneAt > input.wallet.createdAt
  ) {
    return {
      allowed: false,
      reason:
        "The verified contact was recorded after this wallet was submitted, so it is " +
        "not independent of it.",
    };
  }

  return { allowed: true, matched };
}
