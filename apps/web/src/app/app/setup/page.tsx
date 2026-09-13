// Setting up used to be a separate thing from identity. It is not any more.
//
// Paying and being paid are one account: one company name, one DigiLocker
// verification, one World ID enrolment, one wallet, one identity binding, one
// on-chain KYC grant. The database always required that — a DigiLocker id backs
// exactly one vendor, and an address can be the confirmed wallet of only one —
// so two screens running the same six steps could only ever produce a collision
// on the second run.
//
// Kept as a redirect rather than deleted: this path is linked from the
// overview, from the new-payment screen, and from anywhere a person bookmarked
// it, and a 404 is a worse answer than the right screen.

import { redirect } from "next/navigation";

export default function SetupPage(): never {
  redirect("/app/account");
}
