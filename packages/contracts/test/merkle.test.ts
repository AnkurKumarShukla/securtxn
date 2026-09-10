import { describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import {
  buildTree,
  hashLeaf,
  hashNode,
  merkleProof,
  merkleRoot,
  verifyMerkleProof,
} from "../src/index.js";

const leaf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const leaves = (count: number): Hex[] => Array.from({ length: count }, (_, i) => leaf(i + 1));

describe("domain separation", () => {
  // Without distinct prefixes an attacker can hand over an internal node and
  // claim it is a leaf, proving inclusion of data that was never in the tree.
  it("hashes a leaf and a node differently for the same bytes", () => {
    const a = leaf(1);
    const b = leaf(2);
    expect(hashLeaf(a)).not.toBe(keccak256(a));
    expect(hashNode(a, b)).not.toBe(hashLeaf(a));
  });

  it("does not let a node hash pass as a leaf hash", () => {
    const internal = hashNode(leaf(1), leaf(2));
    expect(hashLeaf(internal)).not.toBe(internal);
  });

  it("preserves order rather than sorting pairs", () => {
    // Sorted pairs would make a proof valid at more than one position, and
    // position is what an inclusion proof claims.
    expect(hashNode(leaf(1), leaf(2))).not.toBe(hashNode(leaf(2), leaf(1)));
  });
});

describe("root construction", () => {
  it("is the leaf hash for a single record", () => {
    expect(merkleRoot([leaf(1)])).toBe(hashLeaf(leaf(1)));
  });

  it("is deterministic", () => {
    expect(merkleRoot(leaves(7))).toBe(merkleRoot(leaves(7)));
  });

  it("changes when any leaf changes", () => {
    const before = merkleRoot(leaves(5));
    const tampered = leaves(5);
    tampered[3] = leaf(99);
    expect(merkleRoot(tampered)).not.toBe(before);
  });

  it("changes when leaves are reordered", () => {
    const forward = leaves(4);
    const swapped = [forward[1]!, forward[0]!, forward[2]!, forward[3]!];
    expect(merkleRoot(swapped)).not.toBe(merkleRoot(forward));
  });

  /**
   * Bitcoin duplicates a lone node at the end of an odd level, which lets two
   * different leaf sets collide on one root. Promotion has no such collision,
   * and this is the case that catches a regression back to duplication.
   */
  it("promotes an odd node instead of duplicating it", () => {
    const three = leaves(3);
    const duplicated = merkleRoot([...three, three[2]!]);
    expect(merkleRoot(three)).not.toBe(duplicated);
  });

  it("refuses an empty batch", () => {
    expect(() => merkleRoot([])).toThrow(/at least one leaf/);
  });

  it("builds the expected number of levels", () => {
    expect(buildTree(leaves(1))).toHaveLength(1);
    expect(buildTree(leaves(2))).toHaveLength(2);
    expect(buildTree(leaves(5))).toHaveLength(4);
  });
});

describe("inclusion proofs", () => {
  // Every size class: a lone leaf, exact powers of two, and the odd counts
  // where promotion happens at different levels.
  it.each([1, 2, 3, 4, 5, 8, 9, 17])("verifies every leaf in a batch of %i", (size) => {
    const batch = leaves(size);
    const root = merkleRoot(batch);

    for (let index = 0; index < size; index += 1) {
      const proof = merkleProof(batch, index);
      expect(proof.root).toBe(root);
      expect(proof.leaf).toBe(batch[index]);
      expect(verifyMerkleProof(proof)).toBe(true);
    }
  });

  it("rejects a proof whose leaf was swapped", () => {
    const batch = leaves(6);
    const proof = merkleProof(batch, 2);
    expect(verifyMerkleProof({ ...proof, leaf: leaf(99) })).toBe(false);
  });

  it("rejects a proof against a different root", () => {
    const proof = merkleProof(leaves(6), 2);
    expect(verifyMerkleProof({ ...proof, root: merkleRoot(leaves(5)) })).toBe(false);
  });

  it("rejects a proof with a flipped sibling side", () => {
    // The side is what fixes the leaf's position. Flipping it must not verify,
    // or a record could claim a position it never held.
    const proof = merkleProof(leaves(8), 3);
    const flipped = proof.steps.map((step) => ({
      ...step,
      position: step.position === "left" ? ("right" as const) : ("left" as const),
    }));
    expect(verifyMerkleProof({ ...proof, steps: flipped })).toBe(false);
  });

  it("rejects a proof with a step removed", () => {
    const proof = merkleProof(leaves(8), 5);
    expect(verifyMerkleProof({ ...proof, steps: proof.steps.slice(1) })).toBe(false);
  });

  it("refuses to build a proof for an index outside the batch", () => {
    expect(() => merkleProof(leaves(4), 4)).toThrow(/outside a tree/);
  });

  it("needs no more steps than the tree is deep", () => {
    // log2(1000) is under 10, so a batch of a thousand records still proves
    // inclusion in ten hashes. This is why batching costs nothing to verify.
    const proof = merkleProof(leaves(1000), 500);
    expect(proof.steps.length).toBeLessThanOrEqual(10);
    expect(verifyMerkleProof(proof)).toBe(true);
  });
});
