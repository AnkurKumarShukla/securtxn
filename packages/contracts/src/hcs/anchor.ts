// Hedera Consensus Service: publishing evidence roots, and reading them back.
//
// HCS is a NATIVE Hedera service, not an EVM one, so this is the one place in
// the codebase that uses @hashgraph/sdk rather than viem. It needs an account
// id alongside the key, because the native protocol addresses accounts by
// 0.0.x and not by EVM address.
//
// The same ECDSA key the platform already uses works here — verified by
// deriving its EVM address through the SDK and matching it against the issuer
// address viem derives. No second account is required.
//
// WHY THE READ PATH IS HERE TOO. Anchoring is only worth doing if someone can
// check it, and checking means fetching the message from a mirror node, not
// asking us what we wrote. `fetchAnchoredRoot` is the verifier's half, and it
// runs against the public mirror node with no credentials at all.
//
// Docs: https://docs.hedera.com/hedera/sdks-and-apis/sdks/consensus-service
//       https://docs.hedera.com/hedera/tutorials/consensus/query-messages-with-mirror-node
// Spec: docs/architecture.md §4.8

import {
  AccountId,
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";

/**
 * Max size of a single HCS message is 1024 bytes; the SDK chunks anything
 * larger across up to 20 messages. An anchor payload is a root, a count and two
 * timestamps — well inside one message, and it must stay that way, because a
 * chunked anchor would have several sequence numbers and no single one to cite.
 */
export const MAX_MESSAGE_BYTES = 1024;

export type HcsAnchorOptions = {
  /** Operator account, e.g. "0.0.10443799". Native Hedera addressing, not EVM. */
  accountId: string;
  /** Hex ECDSA key, with or without the 0x prefix. */
  privateKey: string;
  network: "testnet" | "mainnet" | "previewnet";
  /** Public REST endpoint used by the verification path. No credentials needed. */
  mirrorNodeUrl: string;
};

export type SubmittedAnchor = {
  topicId: string;
  /** Ordinal position in the topic. Cite this to fetch the message back. */
  sequenceNumber: number;
  /** Network consensus time, not our clock. This is what the anchor proves. */
  consensusTimestamp: string;
  transactionId: string;
};

export type FetchedMessage = {
  sequenceNumber: number;
  consensusTimestamp: string;
  /** Decoded from the mirror node's base64. */
  contents: string;
  payerAccountId: string;
};

export class HcsAnchorClient {
  private readonly client: Client;
  private readonly mirrorNodeUrl: string;

  constructor(options: HcsAnchorOptions) {
    this.client =
      options.network === "mainnet"
        ? Client.forMainnet()
        : options.network === "previewnet"
          ? Client.forPreviewnet()
          : Client.forTestnet();

    // fromStringECDSA, not fromString: the deprecated one guesses the curve,
    // and guessing ED25519 for a secp256k1 key yields a valid-looking key for a
    // different account.
    this.client.setOperator(
      AccountId.fromString(options.accountId),
      PrivateKey.fromStringECDSA(options.privateKey),
    );

    this.mirrorNodeUrl = options.mirrorNodeUrl.replace(/\/+$/, "");
  }

  /** The EVM address this key controls. Used to assert it is the expected account. */
  get operatorEvmAddress(): string {
    const key = this.client.operatorPublicKey;
    if (!key) throw new Error("no operator configured");
    return `0x${key.toEvmAddress()}`;
  }

  /**
   * Creates the topic anchors are written to. A one-time setup step.
   *
   * An admin key is set so the topic can be updated or deleted later; a submit
   * key is NOT, deliberately. Restricting submission would mean only we can
   * write to it, and the value of this topic comes from it being publicly
   * readable, not privately writable. What matters is that our messages are
   * signed by our account, which the payer id records either way.
   */
  async createTopic(memo: string): Promise<string> {
    const response = await new TopicCreateTransaction()
      .setTopicMemo(memo)
      .setAdminKey(this.client.operatorPublicKey!)
      .execute(this.client);

    const receipt = await response.getReceipt(this.client);
    const topicId = receipt.topicId;
    if (!topicId) throw new Error("topic creation returned no topic id");
    return topicId.toString();
  }

  /** Publishes one message and returns where it landed. */
  async submitMessage(topicId: string, contents: string): Promise<SubmittedAnchor> {
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > MAX_MESSAGE_BYTES) {
      // Refused rather than chunked. A chunked anchor spans several sequence
      // numbers, and an inclusion proof needs exactly one to cite.
      throw new Error(`anchor message is ${bytes} bytes; the single-message limit is ${MAX_MESSAGE_BYTES}`);
    }

    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(contents)
      .execute(this.client);

    const receipt = await response.getReceipt(this.client);
    if (receipt.topicSequenceNumber === null) {
      throw new Error("message submission returned no sequence number");
    }

    return {
      topicId,
      sequenceNumber: Number(receipt.topicSequenceNumber),
      // The receipt's consensus timestamp is the transaction's; the mirror node
      // is authoritative for the message's, and the two agree.
      consensusTimestamp: response.transactionId.validStart?.toString() ?? "",
      transactionId: response.transactionId.toString(),
    };
  }

  /**
   * Reads a published message back from the public mirror node.
   *
   * The verifier's path, and it takes no credentials on purpose: a proof that
   * only we can check is not a proof.
   */
  async fetchMessage(topicId: string, sequenceNumber: number): Promise<FetchedMessage | null> {
    const url = messageUrl(this.mirrorNodeUrl, topicId, sequenceNumber);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`mirror node returned ${response.status} for ${url}`);
    }

    const body = (await response.json()) as {
      messages?: {
        sequence_number: number;
        consensus_timestamp: string;
        message: string;
        payer_account_id: string;
      }[];
    };

    const message = body.messages?.[0];
    // Null rather than an error: a message submitted seconds ago may not have
    // reached the mirror node yet, and that is a wait, not a failure.
    if (!message) return null;

    return {
      sequenceNumber: message.sequence_number,
      consensusTimestamp: message.consensus_timestamp,
      contents: Buffer.from(message.message, "base64").toString("utf8"),
      payerAccountId: message.payer_account_id,
    };
  }

  close(): void {
    this.client.close();
  }
}

/**
 * The public URL for one anchored message.
 *
 * Handed to callers so a verifier can open it themselves. This is the link that
 * turns "our records say so" into something checkable.
 */
export function messageUrl(mirrorNodeUrl: string, topicId: string, sequenceNumber: number): string {
  const base = mirrorNodeUrl.replace(/\/+$/, "");
  return `${base}/topics/${topicId}/messages?sequencenumber=${sequenceNumber}`;
}
