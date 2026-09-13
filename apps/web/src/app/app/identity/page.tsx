// The payee-side name for what is now simply the account.
//
// Same reasoning as `/app/setup`: the screen moved, the old paths stay so that
// existing links and bookmarks land somewhere correct.

import { redirect } from "next/navigation";

export default function IdentityPage(): never {
  redirect("/app/account");
}
