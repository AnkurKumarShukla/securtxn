// Who you are on this platform. One record, for both directions.
//
// WHY ONE. Paying and being paid used to be two identities in one browser: an
// "org" with a vendor record, and a separate payee session with its own vendor,
// its own wallet and its own key. That was convenient for demonstrating both
// sides on one machine and wrong as a model, in a way the database already
// refused to allow:
//
//   `Vendor.digilockerUserId` is UNIQUE. One DigiLocker identity backs exactly
//   one vendor, so the same human onboarding as both parties collides on the
//   second attempt.
//
//   At most one CONFIRMED wallet may exist per address. The same MetaMask
//   account cannot be the payout address of two vendors.
//
// So a person is ONE account: one company name, one DigiLocker verification,
// one World ID enrolment, one wallet, one identity binding, one on-chain KYC
// grant. That wallet sends and it receives. Everything the platform checks was
// always about the same human; only the UI pretended otherwise.
//
// `view` is what is left of the old role. It decides which screens you are
// looking at and nothing else — it is not an identity, it does not change who
// signs, and switching it does not change a single value below it.

/**
 * Which half of the product is on screen.
 *
 * Named for the two sides of a payment, not for two users. One account is both:
 * "payer" lists the screens for sending, "payee" the screens for receiving, and
 * switching changes nothing about who you are or what signs.
 */
export type Role = "payer" | "payee";

const KEY = "securtxn.account.v2";

/** The two predecessors, read once during migration and then left alone. */
const LEGACY_ORG_KEY = "securtxn.org.v1";
const LEGACY_PAYEE_KEY = "confirmed-payee.session.v1";

export type Account = {
  version: 2;
  /** The vendor record both sides of a payment resolve to. */
  vendorId: string | null;
  displayName: string | null;
  /**
   * The wallet. Funds escrows when you pay, receives them when you are paid.
   *
   * Always a connected account — there is no generated-key mode here. A key in
   * localStorage is a poor way to hold money you are about to send, and a
   * single account has to be able to do both.
   */
  address: `0x${string}` | null;
  /** The registered VendorWallet for that address, once the API knows it. */
  walletId: string | null;
  /** Recorded once; every later payment-time check compares against it. */
  enrolmentId: string | null;
  /** Whether DigiLocker has been completed and has not expired. */
  identityVerified: boolean;
  /** Which half of the product is on screen. A view, not an identity. */
  view: Role;
};

export function emptyAccount(): Account {
  return {
    version: 2,
    vendorId: null,
    displayName: null,
    address: null,
    walletId: null,
    enrolmentId: null,
    identityVerified: false,
    view: "payer",
  };
}

/**
 * Reads the account, folding in a pre-split session if one is still there.
 *
 * MUST NOT run during render: a value present on the client and absent on the
 * server is a hydration mismatch, and React discards the tree.
 *
 * The merge prefers whichever half got further. Someone who onboarded as a
 * payee has a verified vendor and a confirmed wallet; someone who only set up
 * an organisation has a name and possibly an enrolment. Taking the payee's
 * vendor when it exists keeps the side that actually completed the gates.
 */
export function loadAccount(): Account {
  if (typeof window === "undefined") return emptyAccount();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Account;
      if (parsed?.version === 2) return { ...emptyAccount(), ...parsed };
    }
    return migrate();
  } catch {
    return emptyAccount();
  }
}

function migrate(): Account {
  const next = emptyAccount();
  try {
    const orgRaw = window.localStorage.getItem(LEGACY_ORG_KEY);
    if (orgRaw) {
      const org = JSON.parse(orgRaw) as Partial<Account> & { role?: Role };
      next.vendorId = org.vendorId ?? null;
      next.displayName = org.displayName ?? null;
      next.address = org.address ?? null;
      next.walletId = org.walletId ?? null;
      next.enrolmentId = org.enrolmentId ?? null;
      next.identityVerified = org.identityVerified ?? false;
      if (org.role) next.view = org.role;
    }

    const payeeRaw = window.localStorage.getItem(LEGACY_PAYEE_KEY);
    if (payeeRaw) {
      const payee = JSON.parse(payeeRaw) as {
        vendorId?: string | null;
        walletId?: string | null;
        enrolmentId?: string | null;
        address?: `0x${string}` | null;
        mode?: string;
      };
      // The payee side is preferred where it exists, because it is the side
      // that had to pass every gate to be paid at all.
      if (payee.vendorId) {
        next.vendorId = payee.vendorId;
        next.walletId = payee.walletId ?? null;
      }
      if (payee.enrolmentId) next.enrolmentId = payee.enrolmentId;
      // Only a connected address migrates. A generated key cannot become the
      // account's wallet: it has no way to send, and the account must do both.
      if (payee.mode === "metamask" && payee.address) next.address = payee.address;
    }

    // Written straight back, so the merge happens once rather than on every
    // load, and so a later change to the migration cannot re-derive a different
    // answer from the same two stale records.
    saveAccount(next);
  } catch {
    /* unreadable legacy state is the same position as a first visit */
  }
  return next;
}

export function saveAccount(account: Account): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(account));
  } catch {
    /* private mode or full storage — the session still works, it will not resume */
  }
}

export function clearAccount(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
    window.localStorage.removeItem(LEGACY_ORG_KEY);
    window.localStorage.removeItem(LEGACY_PAYEE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Everything the platform needs before this account can transact either way. */
export function isOnboarded(account: Account): boolean {
  return Boolean(
    account.vendorId && account.address && account.walletId && account.identityVerified,
  );
}
