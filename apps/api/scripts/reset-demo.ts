// Clears every operational row so a demo starts from nothing.
//
// WHAT THIS IS FOR. A demo run leaves state that blocks the next one: a
// DigiLocker identity is linked to a vendor and one identity may only back one
// vendor, so the second run gets a 409 at identity/complete. Clearing the link
// by hand is what /dev/identity/release did, and that route does not exist in
// production.
//
// WHAT IT CANNOT UNDO. Only this database. Three things outlive it, and each
// one has surprised us at least once:
//
//   - THE CHAIN. A wallet granted KYC on the ATS security stays granted; the
//     HTLC locks stay locked; the HCS anchors stay anchored. grantKyc is
//     idempotent for exactly this reason.
//   - THE BROWSER. The wallet private key lives in localStorage, so "connect
//     wallet" after a reset returns the SAME address unless site data is
//     cleared too.
//   - WORLD ID. Deleting the rows here forgets the enrolment; the nullifier
//     upstream is unchanged, and re-enrolling the same human is what should
//     happen.
//
// ORDER IS NOT NEGOTIABLE. Every relation in this schema is onDelete: Restrict
// — evidence is never silently orphaned — so this deletes leaves first and
// roots last. A wrong order fails on a foreign key rather than half-deleting a
// payment.
//
//   pnpm --filter @cp/api reset:demo -- --yes

import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../src/config/index.js";

/** Leaves first, roots last. */
const ORDER = [
  "evidenceRecord",
  "evidenceAnchor",
  "approvalEvent",
  "proposal",
  "payeeConsent",
  "recipientAcknowledgment",
  "htlcSettlement",
  "exceptionCase",
  "notification",
  "vendorMatchRequest",
  "paymentRequest",
  "verifiableCredential",
  "securityEvent",
  "security",
  "identityBlock",
  "worldIdVerification",
  "vendorWallet",
  "vendor",
  "encryptedBlob",
] as const;

type Delegate = {
  count: () => Promise<number>;
  deleteMany: (args?: unknown) => Promise<{ count: number }>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
};

const config = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });
const model = (name: string) => (prisma as unknown as Record<string, Delegate>)[name]!;

// Says which database, without printing the credentials in the URL.
const host = new URL(config.DATABASE_URL).host;

const before: [string, number][] = [];
for (const name of ORDER) {
  const n = await model(name).count();
  if (n > 0) before.push([name, n]);
}

const total = before.reduce((sum, [, n]) => sum + n, 0);
console.log(`database : ${host}`);
if (total === 0) {
  console.log("already empty — nothing to do");
  await prisma.$disconnect();
  process.exit(0);
}

for (const [name, n] of before) console.log(`  ${String(n).padStart(5)}  ${name}`);
console.log(`\n${total} rows across ${before.length} tables`);

// Deliberately not the default. This is irreversible and points at whatever
// DATABASE_URL says, which on this project is the deployed database.
if (!process.argv.includes("--yes")) {
  console.log("\nNothing deleted. Re-run with --yes to confirm.");
  await prisma.$disconnect();
  process.exit(0);
}

// A wallet can point at the wallet it replaced. Self-references have to be
// broken before the rows they point at can go.
const unlinked = await model("vendorWallet").updateMany({
  where: { supersededById: { not: null } },
  data: { supersededById: null },
});
if (unlinked.count > 0) console.log(`\nunlinked ${unlinked.count} superseded wallet pointer(s)`);

console.log();
let deleted = 0;
for (const name of ORDER) {
  const { count } = await model(name).deleteMany({});
  deleted += count;
  if (count > 0) console.log(`  ${String(count).padStart(5)}  ${name}`);
}

const left: string[] = [];
for (const name of ORDER) {
  const n = await model(name).count();
  if (n > 0) left.push(`${name}=${n}`);
}

console.log(`\ndeleted ${deleted} rows`);
console.log(left.length === 0 ? "every table is empty" : `STILL POPULATED: ${left.join(", ")}`);
console.log("\nThe chain and the browser are untouched — clear site data for a fresh wallet.");

await prisma.$disconnect();
