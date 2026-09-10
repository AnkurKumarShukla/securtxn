// Publishing evidence roots to a consensus topic, behind one seam.
//
// Same shape as the chain and compliance gateways, and mock by default for the
// same reason: a test run must never post to the real audit topic. Test roots
// interleaved among real ones would be worse than gaps, because the topic's
// whole value is that everything on it is real (D21).
//
// The mock is honest about being a mock. Its sequence numbers are its own
// counter, its topic id is unmistakable, and `broadcasts` is false — so a
// caller can never render a mock anchor as something a third party could go and
// read.
//
// Spec: docs/architecture.md §4.8

import { HcsAnchorClient, messageUrl, type SubmittedAnchor } from "@cp/contracts";
import type { Config } from "../config/index.js";

export type AnchorReceipt = SubmittedAnchor & {
  /** Public mirror-node URL for the message. Null when nothing was published. */
  messageUrl: string | null;
};

export interface AnchorGateway {
  readonly kind: "hcs" | "mock";
  /** False for the mock: no message exists on any topic. */
  readonly broadcasts: boolean;
  readonly topicId: string;

  publish(contents: string): Promise<AnchorReceipt>;
  /**
   * Reads a published message back from a public mirror node.
   *
   * Null when it has not propagated yet, which is a wait rather than a failure.
   * This is the verifier's path, and it is what makes an anchor worth writing.
   */
  fetch(sequenceNumber: number): Promise<{ contents: string; consensusTimestamp: string } | null>;
  close(): void;
}

export function createAnchorGateway(config: Config): AnchorGateway {
  const configured =
    config.ANCHOR_GATEWAY === "hcs" &&
    config.HCS_TOPIC_ID &&
    config.ATS_ISSUER_ACCOUNT_ID &&
    config.ATS_ISSUER_PRIVATE_KEY &&
    config.HEDERA_MIRROR_NODE_URL;

  return configured ? new HcsGateway(config) : new MockAnchorGateway();
}

export class HcsGateway implements AnchorGateway {
  readonly kind = "hcs" as const;
  readonly broadcasts = true;
  readonly topicId: string;

  private readonly client: HcsAnchorClient;
  private readonly mirrorNodeUrl: string;

  constructor(config: Config) {
    this.topicId = config.HCS_TOPIC_ID!;
    this.mirrorNodeUrl = config.HEDERA_MIRROR_NODE_URL!;
    this.client = new HcsAnchorClient({
      accountId: config.ATS_ISSUER_ACCOUNT_ID!,
      privateKey: config.ATS_ISSUER_PRIVATE_KEY!,
      network: config.HEDERA_CHAIN_ID === 295 ? "mainnet" : "testnet",
      mirrorNodeUrl: this.mirrorNodeUrl,
    });
  }

  async publish(contents: string): Promise<AnchorReceipt> {
    const submitted = await this.client.submitMessage(this.topicId, contents);
    return {
      ...submitted,
      messageUrl: messageUrl(this.mirrorNodeUrl, this.topicId, submitted.sequenceNumber),
    };
  }

  async fetch(sequenceNumber: number) {
    const message = await this.client.fetchMessage(this.topicId, sequenceNumber);
    if (!message) return null;
    return { contents: message.contents, consensusTimestamp: message.consensusTimestamp };
  }

  close(): void {
    this.client.close();
  }
}

/**
 * An in-memory topic. Publishes nothing.
 *
 * It keeps the messages it was given so `fetch` returns what `publish` stored,
 * which lets the round trip — publish, read back, mark verified — be tested
 * without a network. What it cannot simulate is the property that matters:
 * that somebody else is holding the message.
 */
export class MockAnchorGateway implements AnchorGateway {
  readonly kind = "mock" as const;
  readonly broadcasts = false;
  /** Deliberately not a plausible topic id. Nobody can mistake this for real. */
  readonly topicId = "0.0.0";

  private sequence = 0;
  private readonly messages = new Map<number, { contents: string; consensusTimestamp: string }>();

  async publish(contents: string): Promise<AnchorReceipt> {
    this.sequence += 1;
    const consensusTimestamp = `${Math.floor(Date.now() / 1000)}.000000000`;
    this.messages.set(this.sequence, { contents, consensusTimestamp });

    return {
      topicId: this.topicId,
      sequenceNumber: this.sequence,
      consensusTimestamp,
      transactionId: `mock-anchor-${this.sequence}`,
      // Null, not a fabricated link. A URL that 404s reads as a bug in the
      // anchoring rather than as an absence of anchoring.
      messageUrl: null,
    };
  }

  async fetch(sequenceNumber: number) {
    return this.messages.get(sequenceNumber) ?? null;
  }

  close(): void {}
}
