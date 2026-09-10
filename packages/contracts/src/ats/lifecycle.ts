// Lifecycle operations on a deployed ATS security.
//
// Everything the platform does to a security after it exists: preparing it so
// KYC grants are honoured, minting, transferring, scheduling coupons, moving
// maturity, and redeeming at maturity.
//
// THIS IS THE LIBRARY THE API CALLS. It used to live as raw ABI calls inside
// scripts/lifecycle-demo.ts, which was fine while a demo was the only caller.
// A consumer app triggers these from HTTP routes, and a route that hand-rolls
// contract encoding is a route that will disagree with the demo about what a
// coupon is.
//
// Every method returns the transaction hash of a CONFIRMED transaction. There
// is no path here that reports success for a transaction that reverted.
//
// Spec: docs/architecture.md §4.5

import type { Address, Hex } from "viem";
import { BOND_LIFECYCLE_ABI, ROLES } from "./bond.js";
import type { HederaClients } from "./clients.js";

/** ERC-20 surface the ATS security exposes through its facets. */
export const TOKEN_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_to", type: "address" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export const ACCESS_CONTROL_ABI = [
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_role", type: "bytes32" },
      { name: "_account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "_role", type: "bytes32" },
      { name: "_account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Self-sovereign identity: the register of credential issuers the token trusts. */
export const SSI_ABI = [
  {
    type: "function",
    name: "addIssuer",
    stateMutability: "nonpayable",
    inputs: [{ name: "_issuer", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isIssuer",
    stateMutability: "view",
    inputs: [{ name: "_issuer", type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export type CouponTerms = {
  /** Holders at this moment receive the coupon. */
  recordDate: Date;
  /** When the payout happens. Must be after the record date. */
  executionDate: Date;
  startDate: Date;
  endDate: Date;
  fixingDate: Date;
  /** Basis points at `rateDecimals` precision, e.g. 250 with 2 decimals = 2.50%. */
  rate: bigint;
  rateDecimals?: number;
};

export type PrepareResult = {
  ssiManagerGranted: boolean;
  issuerRegistered: boolean;
  txHashes: Hex[];
};

export class SecurityLifecycle {
  constructor(private readonly clients: HederaClients) {}

  get operatorAddress(): Address {
    return this.clients.address;
  }

  resolve(idOrAddress: string): Promise<Address> {
    return this.clients.resolve(idOrAddress);
  }

  /**
   * Makes the operator a credential issuer the token will accept.
   *
   * Two steps the factory deploy does not do: grant ROLE_SSI_MANAGER, then
   * register the account as a trusted issuer. Without the first, `addIssuer`
   * reverts on a missing role; without the second, every `grantKyc` reverts
   * with `AccountIsNotIssuer`.
   *
   * That second check is the security property, not an obstacle: the token
   * honours KYC grants only from an issuer it has been told to trust (D40).
   *
   * Idempotent, and cheap when there is nothing to do — both facts are read
   * first, so re-running costs two view calls and no gas.
   */
  async prepare(security: Address): Promise<PrepareResult> {
    const operator = this.clients.address;
    const txHashes: Hex[] = [];

    const [hasRole, isIssuer] = await Promise.all([
      this.clients.publicClient.readContract({
        address: security,
        abi: ACCESS_CONTROL_ABI,
        functionName: "hasRole",
        args: [ROLES.SSI_MANAGER, operator],
      }),
      this.clients.publicClient.readContract({
        address: security,
        abi: SSI_ABI,
        functionName: "isIssuer",
        args: [operator],
      }),
    ]);

    if (!hasRole) {
      txHashes.push(
        await this.write(security, ACCESS_CONTROL_ABI, "grantRole", [ROLES.SSI_MANAGER, operator], "grantRole"),
      );
    }
    if (!isIssuer) {
      txHashes.push(await this.write(security, SSI_ABI, "addIssuer", [operator], "addIssuer"));
    }

    return { ssiManagerGranted: !hasRole, issuerRegistered: !isIssuer, txHashes };
  }

  /** Creates new units and assigns them to a holder. Requires ROLE_ISSUER. */
  async mint(security: Address, to: Address, amount: bigint): Promise<Hex> {
    return this.write(security, TOKEN_ABI, "mint", [to, amount], "mint", 2_000_000n);
  }

  /**
   * Moves units from the operator's own holding.
   *
   * Reverts when either side lacks KYC, which is the compliance gate doing its
   * job rather than a failure to handle (D46).
   */
  async transfer(security: Address, to: Address, amount: bigint): Promise<Hex> {
    return this.write(security, TOKEN_ABI, "transfer", [to, amount], "transfer", 2_000_000n);
  }

  /**
   * Schedules a coupon. Requires ROLE_CORPORATE_ACTION.
   *
   * `rateStatus` is pinned to SET (1). PENDING (0) is for a rate fixed later at
   * the fixing date, and a standard-rate bond rejects it at scheduling with
   * `InterestRateIsStandard()` (D49).
   */
  async setCoupon(security: Address, terms: CouponTerms): Promise<Hex> {
    const coupon = {
      recordDate: seconds(terms.recordDate),
      executionDate: seconds(terms.executionDate),
      startDate: seconds(terms.startDate),
      endDate: seconds(terms.endDate),
      fixingDate: seconds(terms.fixingDate),
      rate: terms.rate,
      rateDecimals: terms.rateDecimals ?? 2,
      rateStatus: 1,
    } as const;

    return this.write(security, BOND_LIFECYCLE_ABI, "setCoupon", [coupon], "setCoupon", 2_000_000n);
  }

  async couponCount(security: Address): Promise<bigint> {
    return this.clients.publicClient.readContract({
      address: security,
      abi: BOND_LIFECYCLE_ABI,
      functionName: "getCouponCount",
    });
  }

  /**
   * Moves the maturity date. Requires ROLE_MATURITY_MANAGER.
   *
   * The contract insists the new date is strictly in the future and rejects
   * anything else with `MaturityDateInvalid()` — the same error it uses for a
   * redemption attempted too early (D49).
   */
  async updateMaturityDate(security: Address, maturity: Date): Promise<Hex> {
    return this.write(
      security,
      BOND_LIFECYCLE_ABI,
      "updateMaturityDate",
      [seconds(maturity)],
      "updateMaturityDate",
    );
  }

  /** Burns a matured holding back to the issuer. Requires ROLE_MATURITY_REDEEMER. */
  async redeemAtMaturity(
    security: Address,
    holder: Address,
    partition: Hex,
    amount: bigint,
  ): Promise<Hex> {
    return this.write(
      security,
      BOND_LIFECYCLE_ABI,
      "redeemAtMaturityByPartition",
      [holder, partition, amount],
      "redeemAtMaturityByPartition",
      2_000_000n,
    );
  }

  balanceOf(security: Address, holder: Address): Promise<bigint> {
    return this.clients.publicClient.readContract({
      address: security,
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      args: [holder],
    });
  }

  totalSupply(security: Address): Promise<bigint> {
    return this.clients.publicClient.readContract({
      address: security,
      abi: TOKEN_ABI,
      functionName: "totalSupply",
    });
  }

  /**
   * The token's decimals, read from chain rather than assumed.
   *
   * A human amount has to be scaled into base units before it goes near a
   * transfer, and guessing the scale by two is the difference between paying a
   * vendor and paying them a hundred times over.
   */
  async decimals(security: Address): Promise<number> {
    return Number(
      await this.clients.publicClient.readContract({
        address: security,
        abi: TOKEN_ABI,
        functionName: "decimals",
      }),
    );
  }

  /** Current chain time, which is what every deadline on the token is compared to. */
  async chainTime(): Promise<Date> {
    const block = await this.clients.publicClient.getBlock();
    return new Date(Number(block.timestamp) * 1000);
  }

  private async write(
    address: Address,
    abi: readonly unknown[],
    functionName: string,
    args: readonly unknown[],
    label: string,
    gas?: bigint,
  ): Promise<Hex> {
    const hash = await this.clients.walletClient.writeContract({
      address,
      abi: abi as never,
      functionName,
      args: args as never,
      chain: this.clients.chain,
      account: this.clients.account,
      gas: gas ?? this.clients.gas,
    });
    return this.clients.confirm(hash, label);
  }
}

function seconds(date: Date): bigint {
  return BigInt(Math.floor(date.getTime() / 1000));
}
