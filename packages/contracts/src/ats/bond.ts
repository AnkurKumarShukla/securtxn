// Bond issuance against the ATS factory.
//
// Headless, via the factory ABI rather than the SDK — the SDK is browser-only
// with no server-side signer (D42). Doing it in code rather than by clicking
// through a UI means the deploy is reproducible, reviewable, and lives in this
// repo as evidence that ATS was actually used.
//
// Spec: docs/architecture.md §4.5

import {
  createPublicClient,
  createWalletClient,
  http,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAddressResolver, hederaChain } from "./hedera.js";

/** From contracts/constants/roles.sol, ATS contracts 8.0.0. */
export const ROLES = {
  DEFAULT_ADMIN: "0x0000000000000000000000000000000000000000000000000000000000000000",
  KYC: "0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc",
  KYC_MANAGER: "0xec811504e835acf29535b5b62307b08000468f0c61ca6163ed6f17a03629b91e",
  INTERNAL_KYC_MANAGER: "0xdd78fdcd1b38a5360405cef8d91e758ad0f42bf2ced681b803b3c2704b0a32a7",
  /** Required to register a trusted credential issuer via addIssuer. */
  SSI_MANAGER: "0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1",
  /** Mints the receivable. */
  ISSUER: "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f",
  /** Schedules coupons — the bond's defining corporate action. */
  CORPORATE_ACTION: "0xa1acfc499025c99f55059195e6276f639d34a18aad7b8121b9192b7f438c55cd",
  /** Moves the maturity date, e.g. settling a receivable early. */
  MATURITY_MANAGER: "0xc20b7fd7efe1a2c9f69003a21c2c55c79ef84e16252b62599246ff01f6207314",
  /** Redeems holdings once matured. */
  MATURITY_REDEEMER: "0x433f48f8aca23480f6ab07666cbc9131d32a0b4672033453f65e18f4dd390523",
} as const satisfies Record<string, Hex>;

/** The single partition an unpartitioned security uses. */
export const DEFAULT_PARTITION =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

/**
 * Coupon and maturity operations.
 *
 * `rateStatus` distinguishes a fixed rate from one fixed later at the fixing
 * date; 0 is fixed, which is what a receivable's single terminal coupon is.
 */
export const BOND_LIFECYCLE_ABI = [
  {
    type: "function",
    name: "setCoupon",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_newCoupon",
        type: "tuple",
        components: [
          { name: "recordDate", type: "uint256" },
          { name: "executionDate", type: "uint256" },
          { name: "startDate", type: "uint256" },
          { name: "endDate", type: "uint256" },
          { name: "fixingDate", type: "uint256" },
          { name: "rate", type: "uint256" },
          { name: "rateDecimals", type: "uint8" },
          { name: "rateStatus", type: "uint8" },
        ],
      },
    ],
    outputs: [{ name: "couponID_", type: "uint256" }],
  },
  {
    type: "function",
    name: "getCouponCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "updateMaturityDate",
    stateMutability: "nonpayable",
    inputs: [{ name: "_newMaturityDate", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "redeemAtMaturityByPartition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_tokenHolder", type: "address" },
      { name: "_partition", type: "bytes32" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** From contracts/constants/regulation.sol. */
export const REGULATION_TYPE = { NONE: 0, REG_S: 1, REG_D: 2 } as const;
export const REGULATION_SUB_TYPE = { NONE: 0, REG_D_506_B: 1, REG_D_506_C: 2 } as const;

/** Business-logic configuration keys registered on the resolver. */
export const CONFIG_ID = {
  EQUITY: "0x0000000000000000000000000000000000000000000000000000000000000001",
  BOND: "0x0000000000000000000000000000000000000000000000000000000000000002",
} as const satisfies Record<string, Hex>;

export const FACTORY_ABI = [
  {
    type: "function",
    name: "deployBond",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_bondData",
        type: "tuple",
        components: [
          {
            name: "security",
            type: "tuple",
            components: [
              { name: "resolver", type: "address" },
              { name: "maxSupply", type: "uint256" },
              {
                name: "resolverProxyConfiguration",
                type: "tuple",
                components: [
                  { name: "key", type: "bytes32" },
                  { name: "version", type: "uint256" },
                ],
              },
              {
                name: "erc20MetadataInfo",
                type: "tuple",
                components: [
                  { name: "name", type: "string" },
                  { name: "symbol", type: "string" },
                  { name: "isin", type: "string" },
                  { name: "decimals", type: "uint8" },
                ],
              },
              {
                name: "rbacs",
                type: "tuple[]",
                components: [
                  { name: "role", type: "bytes32" },
                  { name: "members", type: "address[]" },
                ],
              },
              { name: "externalPauses", type: "address[]" },
              { name: "externalControlLists", type: "address[]" },
              { name: "externalKycLists", type: "address[]" },
              { name: "compliance", type: "address" },
              { name: "identityRegistry", type: "address" },
              { name: "arePartitionsProtected", type: "bool" },
              { name: "isMultiPartition", type: "bool" },
              { name: "isControllable", type: "bool" },
              { name: "isWhiteList", type: "bool" },
              { name: "clearingActive", type: "bool" },
              { name: "internalKycActivated", type: "bool" },
              { name: "erc20VotesActivated", type: "bool" },
            ],
          },
          {
            name: "bondDetails",
            type: "tuple",
            components: [
              { name: "currency", type: "bytes3" },
              { name: "nominalValue", type: "uint256" },
              { name: "nominalValueDecimals", type: "uint8" },
              { name: "startingDate", type: "uint256" },
              { name: "maturityDate", type: "uint256" },
            ],
          },
          { name: "proceedRecipients", type: "address[]" },
          { name: "proceedRecipientsData", type: "bytes[]" },
        ],
      },
      {
        name: "_factoryRegulationData",
        type: "tuple",
        components: [
          { name: "regulationType", type: "uint8" },
          { name: "regulationSubType", type: "uint8" },
          {
            name: "additionalSecurityData",
            type: "tuple",
            components: [
              { name: "countriesControlListType", type: "bool" },
              { name: "listOfCountries", type: "string" },
              { name: "info", type: "string" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "bondAddress_", type: "address" }],
  },
] as const;

export const RESOLVER_ABI = [
  {
    type: "function",
    name: "getLatestVersionByConfiguration",
    stateMutability: "view",
    inputs: [{ name: "configurationId", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * ISO 6166 check digit.
 *
 * The factory reverts with `WrongISINChecksum` on a bad one, after the gas is
 * spent — so it is computed and validated here, before anything is submitted.
 *
 * Letters convert to numbers (A=10 … Z=35), then a Luhn pass runs over the
 * resulting digit string, doubling every second digit from the right.
 */
export function isinCheckDigit(bodyOf11: string): number {
  const converted = bodyOf11
    .toUpperCase()
    .split("")
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (ch >= "0" && ch <= "9") return ch;
      if (ch >= "A" && ch <= "Z") return String(code - 55); // A=10
      throw new Error(`ISIN body contains an invalid character '${ch}'`);
    })
    .join("");

  let sum = 0;
  let double = true; // the rightmost converted digit is doubled
  for (let i = converted.length - 1; i >= 0; i -= 1) {
    let digit = Number(converted[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** Builds a valid 12-character ISIN from an 11-character body. */
export function completeIsin(bodyOf11: string): string {
  if (bodyOf11.length !== 11) {
    throw new Error(`ISIN body must be 11 characters, got ${bodyOf11.length}`);
  }
  return `${bodyOf11.toUpperCase()}${isinCheckDigit(bodyOf11)}`;
}

export function isValidIsin(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin.toUpperCase())) return false;
  const upper = isin.toUpperCase();
  return isinCheckDigit(upper.slice(0, 11)) === Number(upper.slice(11));
}

/**
 * Which offering exemption the security is issued under.
 *
 * The factory accepts exactly two families (contracts/constants/regulation.sol):
 *
 *   REG_S + NONE                      offerings made outside the United States
 *   REG_D + REG_D_506_B | REG_D_506_C US private placements
 *
 * Anything else — including NONE/NONE — reverts with
 * `RegulationTypeAndSubTypeForbidden`, after the gas is spent. Validated here
 * so that never happens.
 */
export function isValidRegulation(type: number, subType: number): boolean {
  const regS = type === REGULATION_TYPE.REG_S && subType === REGULATION_SUB_TYPE.NONE;
  const regD = type === REGULATION_TYPE.REG_D && subType !== REGULATION_SUB_TYPE.NONE;
  return regS || regD;
}

export type IssueBondInput = {
  name: string;
  symbol: string;
  isin: string;
  decimals?: number;
  /** Three-letter code, e.g. "USD". Stored on chain as bytes3. */
  currency?: string;
  nominalValue: bigint;
  nominalValueDecimals?: number;
  startingDate: Date;
  maturityDate: Date;
  /**
   * Total units, in smallest denomination. MUST be > 0 — the factory rejects
   * zero rather than treating it as uncapped.
   */
  maxSupply: bigint;
  /** Defaults to Reg S: this is a receivable owed to a payee outside the US. */
  regulationType?: number;
  regulationSubType?: number;
};

export type IssueBondResult = {
  bondAddress: Address;
  txHash: Hex;
  configVersion: bigint;
  /** Roles the issuer account holds on the new security. */
  roles: Hex[];
};

export type BondIssuerOptions = {
  chainId: number;
  rpcUrl: string;
  mirrorNodeUrl: string;
  /** Hedera id or EVM address. */
  factoryAddress: string;
  resolverAddress: string;
  issuerPrivateKey: string;
  gasLimit?: bigint;
};

export class BondIssuer {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly resolveAddress: (id: string) => Promise<Address>;

  constructor(private readonly options: BondIssuerOptions) {
    const chain = hederaChain(options.chainId, options.rpcUrl);
    this.account = privateKeyToAccount(options.issuerPrivateKey as Hex);
    this.publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
    this.walletClient = createWalletClient({
      chain,
      transport: http(options.rpcUrl),
      account: this.account,
    });
    const resolver = createAddressResolver(options.mirrorNodeUrl);
    this.resolveAddress = (id) => resolver.toEvmAddress(id);
  }

  get issuerAddress(): Address {
    return this.account.address;
  }

  /** Latest registered version of the bond business logic. */
  async latestBondConfigVersion(): Promise<bigint> {
    const resolver = await this.resolveAddress(this.options.resolverAddress);
    return this.publicClient.readContract({
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: "getLatestVersionByConfiguration",
      args: [CONFIG_ID.BOND],
    });
  }

  async issue(input: IssueBondInput): Promise<IssueBondResult> {
    // Checked before submitting: the factory reverts on a bad checksum, and a
    // revert costs the gas without telling anyone why unless the custom error
    // is decoded.
    const regulationType = input.regulationType ?? REGULATION_TYPE.REG_S;
    const regulationSubType = input.regulationSubType ?? REGULATION_SUB_TYPE.NONE;
    if (!isValidRegulation(regulationType, regulationSubType)) {
      throw new Error(
        `Regulation ${regulationType}/${regulationSubType} is not accepted by the factory. ` +
          "Use REG_S with NONE, or REG_D with a 506 subtype.",
      );
    }

    if (input.maxSupply <= 0n) {
      throw new Error("maxSupply must be greater than zero; the factory rejects an uncapped supply");
    }

    if (!isValidIsin(input.isin)) {
      throw new Error(
        `ISIN '${input.isin}' fails the ISO 6166 checksum. ` +
          `Use completeIsin('${input.isin.slice(0, 11)}') to get a valid one.`,
      );
    }

    const [factory, resolver] = await Promise.all([
      this.resolveAddress(this.options.factoryAddress),
      this.resolveAddress(this.options.resolverAddress),
    ]);

    const version = await this.latestBondConfigVersion();
    const issuer = this.account.address;

    // Every role the platform needs, granted to the issuing account at deploy
    // time. KYC_MANAGER and INTERNAL_KYC_MANAGER matter most: without them the
    // later grantKyc call reverts, and that is the whole point of this bond.
    const rbacs = [
      { role: ROLES.DEFAULT_ADMIN, members: [issuer] },
      { role: ROLES.KYC, members: [issuer] },
      { role: ROLES.KYC_MANAGER, members: [issuer] },
      { role: ROLES.INTERNAL_KYC_MANAGER, members: [issuer] },
      // Without this, addIssuer reverts — and without a registered issuer,
      // grantKyc reverts with AccountIsNotIssuer.
      { role: ROLES.SSI_MANAGER, members: [issuer] },
      // Granted at deploy so the bond's lifecycle — mint, coupon, maturity,
      // redemption — needs no follow-up role grants.
      { role: ROLES.ISSUER, members: [issuer] },
      { role: ROLES.CORPORATE_ACTION, members: [issuer] },
      { role: ROLES.MATURITY_MANAGER, members: [issuer] },
      { role: ROLES.MATURITY_REDEEMER, members: [issuer] },
    ] as const;

    const bondData = {
      security: {
        resolver,
        maxSupply: input.maxSupply,
        resolverProxyConfiguration: { key: CONFIG_ID.BOND, version },
        erc20MetadataInfo: {
          name: input.name,
          symbol: input.symbol,
          isin: input.isin,
          decimals: input.decimals ?? 2,
        },
        rbacs,
        externalPauses: [],
        externalControlLists: [],
        // Empty: compliance runs through INTERNAL KYC on this token, granted
        // with a verifiable credential, rather than an external list contract
        // (D40).
        externalKycLists: [],
        compliance: ZERO_ADDRESS,
        identityRegistry: ZERO_ADDRESS,
        arePartitionsProtected: false,
        isMultiPartition: false,
        isControllable: true,
        isWhiteList: false,
        clearingActive: false,
        // THE setting this whole integration depends on. False here and the
        // token enforces nothing, leaving grantKyc with nothing to gate.
        internalKycActivated: true,
        erc20VotesActivated: false,
      },
      bondDetails: {
        currency: stringToHex(input.currency ?? "USD", { size: 3 }),
        nominalValue: input.nominalValue,
        nominalValueDecimals: input.nominalValueDecimals ?? 2,
        startingDate: BigInt(Math.floor(input.startingDate.getTime() / 1000)),
        maturityDate: BigInt(Math.floor(input.maturityDate.getTime() / 1000)),
      },
      proceedRecipients: [],
      proceedRecipientsData: [],
    } as const;

    const regulationData = {
      regulationType,
      regulationSubType,
      additionalSecurityData: {
        countriesControlListType: false,
        listOfCountries: "",
        info: "",
      },
    } as const;

    const txHash = await this.walletClient.writeContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "deployBond",
      args: [bondData, regulationData],
      chain: this.walletClient.chain,
      account: this.account,
      ...(this.options.gasLimit ? { gas: this.options.gasLimit } : {}),
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`deployBond reverted (tx ${txHash})`);
    }

    // A write transaction's return value is not available to the caller, and
    // decoding BondDeployed would mean reproducing its two nested structs
    // exactly — a signature mismatch there silently yields no match. The new
    // proxy is instead the one address that emitted logs and is not the
    // factory, which is stable regardless of event shape.
    const bondAddress = extractDeployedAddress(receipt.logs, factory);
    if (!bondAddress) {
      throw new Error(
        `deployBond succeeded but no new contract address was found in the logs (tx ${txHash}). ` +
          "Check the mirror node for created_contract_ids.",
      );
    }

    return { bondAddress, txHash, configVersion: version, roles: rbacs.map((r) => r.role) };
  }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function extractDeployedAddress(
  logs: readonly { address: Address }[],
  factory: Address,
): Address | null {
  const factoryLower = factory.toLowerCase();
  for (const log of logs) {
    const emitter = log.address.toLowerCase();
    if (emitter !== factoryLower) return log.address;
  }
  return null;
}
