// Prints one VendorMatchRequest row, or the most recent few.
// Used to confirm a workflow's verdict callback actually landed (D48) —
// a green simulation result says the workflow computed a verdict, not that
// the verdict reached us.
//
//   node apps/api/scripts/show-match-request.mjs [requestId]

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const id = process.argv[2];

const rows = id
  ? [await prisma.vendorMatchRequest.findUnique({ where: { id } })]
  : await prisma.vendorMatchRequest.findMany({ orderBy: { createdAt: "desc" }, take: 5 });

for (const row of rows) {
  if (!row) {
    console.log("(no such request)");
    continue;
  }
  console.log(
    [
      row.id,
      row.status.padEnd(9),
      `match=${row.match}`,
      `score=${row.score}`,
      `reason=${row.reasonCode ?? "-"}`,
      row.failureReason ? `failure=${row.failureReason}` : "",
      row.workflowExecutionId ? `exec=${row.workflowExecutionId.slice(0, 12)}…` : "",
    ]
      .filter(Boolean)
      .join("  "),
  );
}

await prisma.$disconnect();
