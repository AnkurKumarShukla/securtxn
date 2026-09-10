// Merkle trees over evidence record hashes.
//
// WHAT THIS BUYS. The evidence chain already detects tampering, but only for
// someone who trusts our database — the chain and the records it protects live
// in the same place, so an operator who can rewrite one can rewrite both. A
// Merkle root published to a public consensus topic fixes that: it is a single
// 32-byte commitment to a whole batch, written somewhere we cannot edit. After
// that, "this record existed, unchanged, before that consensus timestamp" is a
// claim anyone can check without asking us (D19).
//
// One root per batch rather than one message per record, because per-record
// anchoring costs and rate-limits badly and proves nothing extra.
//
// THREE CHOICES THAT ARE EASY TO GET WRONG:
//
//   Domain separation. Leaves are hashed with a 0x00 prefix and internal nodes
//   with 0x01. Without it, an attacker can present an internal node as if it
//   were a leaf and prove inclusion of data that was never in the tree — the
//   classic second-preimage attack on Merkle trees.
//
//   Odd nodes are PROMOTED, not duplicated. Bitcoin duplicates the last node,
//   which lets two different leaf sets produce the same root. Promotion (as in
//   RFC 6962) has no such collision.
//
//   Proof steps carry a side. Sorting each pair before hashing would make
//   proofs slightly smaller, but it also makes a proof valid at more than one
//   position. Position is exactly what an inclusion proof is claiming.
//
// Spec: docs/architecture.md §4.8

import { keccak256, type Hex } from "viem";

/** One step up the tree: the sibling, and which side it sits on. */
export type MerkleProofStep = {
  hash: Hex;
  position: "left" | "right";
};

export type MerkleProof = {
  /** The leaf VALUE, before leaf hashing. An evidence record's payloadHash. */
  leaf: Hex;
  /** Zero-based position in the ordered batch. */
  index: number;
  steps: MerkleProofStep[];
  root: Hex;
};

const LEAF_PREFIX = "00";
const NODE_PREFIX = "01";

/** keccak256(0x00 || leaf). The prefix is what stops a node posing as a leaf. */
export function hashLeaf(leaf: Hex): Hex {
  return keccak256(`0x${LEAF_PREFIX}${strip(leaf)}` as Hex);
}

/** keccak256(0x01 || left || right). Order is preserved, never sorted. */
export function hashNode(left: Hex, right: Hex): Hex {
  return keccak256(`0x${NODE_PREFIX}${strip(left)}${strip(right)}` as Hex);
}

/**
 * Builds every level of the tree, leaves first.
 *
 * Returned rather than discarded so the root and a proof come from one
 * construction. Building the tree twice invites the two to disagree, and a
 * proof that does not match the anchored root is worse than no proof.
 */
export function buildTree(leaves: readonly Hex[]): Hex[][] {
  if (leaves.length === 0) {
    throw new Error("a Merkle tree needs at least one leaf");
  }

  const levels: Hex[][] = [leaves.map(hashLeaf)];

  while (true) {
    const current = levels[levels.length - 1]!;
    if (current.length === 1) break;

    const next: Hex[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = current[i + 1];
      // Promoted unchanged when the level is odd. Duplicating it would let a
      // different leaf set produce this same root.
      next.push(right === undefined ? left : hashNode(left, right));
    }
    levels.push(next);
  }

  return levels;
}

export function merkleRoot(leaves: readonly Hex[]): Hex {
  const levels = buildTree(leaves);
  return levels[levels.length - 1]![0]!;
}

/** The sibling path from one leaf up to the root. */
export function merkleProof(leaves: readonly Hex[], index: number): MerkleProof {
  const leaf = leaves[index];
  if (leaf === undefined) {
    throw new Error(`leaf index ${index} is outside a tree of ${leaves.length}`);
  }

  const levels = buildTree(leaves);
  const steps: MerkleProofStep[] = [];
  let position = index;

  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level]!;
    const isRightChild = position % 2 === 1;
    const siblingIndex = isRightChild ? position - 1 : position + 1;
    const sibling = nodes[siblingIndex];

    // No sibling means this node was promoted. Nothing to record: the
    // verifier's running hash passes through this level unchanged.
    if (sibling !== undefined) {
      steps.push({ hash: sibling, position: isRightChild ? "left" : "right" });
    }

    position = Math.floor(position / 2);
  }

  return { leaf, index, steps, root: levels[levels.length - 1]![0]! };
}

/**
 * Recomputes the root from a leaf and its siblings.
 *
 * This is the whole point of the exercise, and it deliberately needs nothing
 * from this system: a leaf, a handful of hashes, and keccak256. Anyone holding
 * the proof and the anchored root can run it.
 */
export function verifyMerkleProof(proof: MerkleProof): boolean {
  let running = hashLeaf(proof.leaf);

  for (const step of proof.steps) {
    running =
      step.position === "left" ? hashNode(step.hash, running) : hashNode(running, step.hash);
  }

  return running.toLowerCase() === proof.root.toLowerCase();
}

function strip(value: string): string {
  return value.replace(/^0x/, "").toLowerCase();
}
