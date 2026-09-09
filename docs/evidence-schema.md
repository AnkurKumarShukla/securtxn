# Evidence record schemas

Canonical JSON payload per `EvidenceRecord.eventType`. Enforced by the Zod
schemas in `@cp/shared-types/src/evidence.ts` — this document and those schemas
must agree, and the schemas win.

Spec: [architecture.md](./architecture.md) §4.8 · Decisions: D07, D27, D36

## Envelope

```ts
type EvidencePayload = {
  eventType: string;
  paymentRequestId: string;
  timestamp: string;            // ISO 8601
  data: Record<string, unknown>; // shape depends on eventType
};
```

Hashing: `keccak256(canonicalJsonStringify(payload) + previousRecordHash)`,
stored as bare 64-hex without an `0x` prefix so every link — including the
all-zero genesis — has the same shape. Genesis `previousRecordHash` is
`"0" x 64`.

Key order is established by `lib/canonical-json.ts`: object keys sorted by code
unit, array order preserved, `undefined` members dropped, and anything JSON
cannot round-trip (NaN, Infinity, bigint, functions, cycles) rejected outright.
`JSON.stringify` is not sufficient — it preserves insertion order, so two equal
payloads built differently would hash differently.

## The PII rule

**No raw PII, banking details, location or device fingerprints in any payload**
(design principle 2). Every field below is an identifier, an enum, a score, or a
hash. That is the test to apply before adding one.

The union is closed and discriminated, so a payload whose `data` does not match
its `eventType` is rejected rather than written, and Zod strips undeclared keys
so a leaked field does not survive parsing.

## Event types

| eventType | Written when | `data` fields |
|---|---|---|
| `vendor_match` | matching completes during run-decision | `matched`, `score`, `reasonCode`, `matcher` (`fallback` \| `cre`) |
| `decision` | the decision engine returns | `decision`, `reasonCode`, `matchScore`, `tierLimitApplied` |
| `approval` | an approver confirms | `approverId`, `selfieCheckVerified`, `ledgerConfirmed` |
| `send` | the bridge reports a tx hash | `txHash`, `network`, `toAddress`, `amount`, `token` |
| `ack` | a recipient signed ack is accepted | `recipientAddress`, `recipientCommitment` |
| `exception_opened` | reconciliation opens a case | `exceptionType`, `openedBy` |
| `evidence_accessed` | someone reads the chain | `actorId`, `actorRole` |

`vendor_match` and `decision` are written as **two records in causal order**, not
one combined record: a single record would lose the distinction between "the
match was wrong" and "the policy was wrong".

## Write rule

Every record is appended in the **same transaction** as the state change it
records (D07). `EvidenceService.append` takes a transaction client for exactly
this reason — there is deliberately no "append later" method.

`appendStandalone` is the one exception, used only by the access audit, which is
not tied to a state change. It retries on a unique-constraint collision, since
two concurrent readers can race for the same chain tip.

## Verification

`GET /payments/:id/evidence` recomputes the chain from genesis on every read
rather than trusting a stored flag, and reports the **first** break with its
index. Two distinct failures are detected:

- **content** — a payload no longer hashes to its stored `payloadHash`
- **linkage** — a record does not link to its predecessor (insertion, removal, reordering)

## Not yet covered

Evidence is payment-scoped: `EvidenceRecord` requires a `paymentRequestId`.
Vendor-level events — identity verified, wallet confirmed, KYB status changed —
therefore have **no chain today**. §4.8 does not address this; it needs either a
nullable payment reference or a separate vendor chain. Tracked in progress.md.
