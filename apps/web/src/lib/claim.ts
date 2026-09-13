// Claiming an escrow, from the payee's own key.
//
// THE REVEAL IS THE RECEIPT. The escrow pays out to whoever presents the
// preimage, so the claim has to be sent by the payee — a platform-side claim
// would prove only that the platform can move its own money. That is why this
// lives in the payee's browser and signs with the key stored there.
//
// Three steps, in this order:
//   1. sign EIP-712 SecretRelease   — proves control of the payout address
//   2. exchange it for the preimage — the API refuses anyone else
//   3. call claim() on chain        — the reveal, which settles it
//
// Spec: docs/architecture.md §4.5 (D41)

import { createPublicClient, http, type Hex } from "viem";
import { SECRET_RELEASE_TYPES, SECRET_RELEASE_STATEMENT, domainFor } from "@cp/shared-types";
import { CHAIN_ID, RPC_URL, hederaTestnet } from "./chain";
import type { PayeeSigner } from "./wallet";
import { api, messageOf } from "./flow";

/** Only the one function this needs. */
const CLAIM_ABI = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "lockId", type: "bytes32" },
      { name: "preimage", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export type ClaimProgress = (line: string) => void;

export async function claimEscrow(input: {
  paymentId: string;
  /**
   * Whoever is claiming, and whatever holds their key.
   *
   * Takes a signer rather than a private key so the claim works identically
   * from a generated key and from MetaMask. With MetaMask the person sees and
   * approves both the signature and the transaction, which is the point — the
   * reveal below IS the receipt, and a receipt nobody consciously produced is
   * not worth much.
   */
  signer: PayeeSigner;
  token: string;
  report: ClaimProgress;
}): Promise<{ claimTxHash: string }> {
  const { paymentId, signer, token, report } = input;
  const { address, client } = signer;

  const settlement = await api(`/payments/${paymentId}/settlement`, { token });
  if (!settlement.ok) throw new Error(`settlement → ${messageOf(settlement.body)}`);

  const { lockId, escrowAddress, status } = settlement.body as {
    lockId: Hex;
    escrowAddress: Hex;
    status: string;
  };
  if (status !== "LOCKED") throw new Error(`escrow is '${status}' — there is nothing to claim`);

  // 1. Prove control of the payout address. The lock id is inside the signed
  //    payload, so a signature captured for one escrow cannot open the next.
  report(
    signer.mode === "metamask"
      ? "approve the signature in MetaMask…"
      : "signing the secret release…",
  );
  const signature = await client.signTypedData({
    account: address,
    domain: domainFor(CHAIN_ID),
    types: SECRET_RELEASE_TYPES,
    primaryType: "SecretRelease",
    message: {
      paymentRequestId: paymentId,
      recipientAddress: address,
      lockId,
      statement: SECRET_RELEASE_STATEMENT,
    },
  });

  // 2. Exchange it for the preimage.
  report("requesting the preimage…");
  const released = await api(`/payments/${paymentId}/settlement/secret`, {
    method: "POST",
    token,
    body: { signature },
  });
  if (!released.ok) throw new Error(`secret → ${messageOf(released.body)}`);
  const { preimage } = released.body as { preimage: Hex };

  // 3. Reveal it on chain. This is the moment the money becomes theirs, and the
  //    transaction itself is the proof they received it.
  report(
    signer.mode === "metamask" ? "confirm the claim in MetaMask…" : "claiming on chain…",
  );
  const claimTxHash = await client.writeContract({
    account: address,
    chain: hederaTestnet,
    address: escrowAddress,
    abi: CLAIM_ABI,
    functionName: "claim",
    args: [lockId, preimage],
    // Hedera charges by gas actually used, so an explicit ceiling here costs
    // nothing and avoids an estimate that the relay sometimes gets wrong.
    gas: 1_000_000n,
  });

  // Read through our own RPC rather than the wallet's: MetaMask's transport
  // answers from whatever node it is pointed at, and waiting for a receipt is a
  // read we would rather not have blocked on the extension being open.
  const publicClient = createPublicClient({ chain: hederaTestnet, transport: http(RPC_URL) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: claimTxHash });
  if (receipt.status !== "success") throw new Error(`claim reverted (tx ${claimTxHash})`);

  // 4. Report it, so the platform's record matches the chain. Reporting is not
  //    what settles it — the transaction above did that — which is why this
  //    happens last and cannot be faked into a settlement.
  report("recording the claim…");
  const recorded = await api(`/payments/${paymentId}/settlement/claim`, {
    method: "POST",
    token,
    body: { preimage, claimTxHash },
  });
  if (!recorded.ok) throw new Error(`record claim → ${messageOf(recorded.body)}`);

  return { claimTxHash };
}
