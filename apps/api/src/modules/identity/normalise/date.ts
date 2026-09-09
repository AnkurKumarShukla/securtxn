// Date normalisation.
//
// The same person's date of birth arrives in three shapes across the DigiLocker
// endpoints, and a naive comparison rejects a legitimate user (D10):
//
//   profile      19/11/2001      DD/MM/YYYY
//   Aadhaar Poi  19-11-2001      DD-MM-YYYY
//   PAN Person   19-11-2001      DD-MM-YYYY
//
// The profile endpoint additionally documents date_of_birth as a unix
// millisecond timestamp but returned a string in the live capture, so both
// types have to be handled.
//
// Spec: docs/architecture.md §4.7.1

/** Day-first, because every Indian government source here is day-first. */
const DAY_FIRST = /^(\d{2})[/-](\d{2})[/-](\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An ISO datetime carrying no timezone, e.g. the KycRes ttl "2027-09-03T04:10:04". */
const ISO_DATETIME_NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * DigiLocker timestamps are Indian Standard Time. `KycRes@ts` says so
 * explicitly ("2026-09-03T04:10:04.984+05:30") while `KycRes@ttl` omits the
 * offset — and it is the same wall clock, one year on.
 *
 * Applied explicitly because `new Date("2027-09-03T04:10:04")` resolves against
 * the SERVER's timezone. That makes a re-verification deadline depend on where
 * the process happens to run: the same document expires on different days in
 * Mumbai and in Frankfurt.
 */
const IST_OFFSET = "+05:30";

/**
 * Parses any of the observed forms to a calendar date.
 *
 * Returns null rather than throwing: a missing or unparseable date is a check
 * failure to be reported, not an exception to unwind through the request.
 */
export function parseFlexibleDate(input: unknown): Date | null {
  if (input === null || input === undefined) return null;

  // Documented as unix-ms. Accept a number, and a numeric string, since JSON
  // sources are inconsistent about quoting.
  if (typeof input === "number") {
    return Number.isFinite(input) ? fromEpochMs(input) : null;
  }

  if (typeof input !== "string") return null;
  const value = input.trim();
  if (value === "") return null;

  if (/^\d{10,}$/.test(value)) return fromEpochMs(Number(value));

  const dayFirst = DAY_FIRST.exec(value);
  if (dayFirst) {
    const [, day = "", month = "", year = ""] = dayFirst;
    return buildUtcDate(Number(year), Number(month), Number(day));
  }

  if (ISO_DATETIME_NAIVE.test(value)) {
    const withZone = new Date(`${value}${IST_OFFSET}`);
    return Number.isNaN(withZone.getTime()) ? null : withZone;
  }

  const iso = ISO_DATE.exec(value);
  if (iso) {
    const [, year = "", month = "", day = ""] = iso;
    return buildUtcDate(Number(year), Number(month), Number(day));
  }

  // A full ISO timestamp (KycRes ts/ttl) still parses natively.
  const native = new Date(value);
  return Number.isNaN(native.getTime()) ? null : native;
}

/** Calendar date as YYYY-MM-DD, the form compared and persisted. */
export function toIsoDate(input: unknown): string | null {
  const date = parseFlexibleDate(input);
  return date ? (date.toISOString().split("T")[0] ?? null) : null;
}

/**
 * Compares two dates from different sources.
 *
 * Both sides go through normalisation first. Comparing raw strings is the bug
 * this module exists to prevent.
 */
export function datesMatch(left: unknown, right: unknown): boolean {
  const a = toIsoDate(left);
  const b = toIsoDate(right);
  return a !== null && a === b;
}

function fromEpochMs(ms: number): Date | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Builds a UTC date and rejects impossible calendar dates. `new Date(2001, 12, 32)`
 * silently rolls over into the next month, which would let a malformed document
 * pass a consistency check against a different real date.
 */
function buildUtcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  const rolledOver =
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day;
  return rolledOver ? null : date;
}
