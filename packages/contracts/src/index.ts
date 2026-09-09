// Hedera ATS integration.
//
// The headless surface only: KYC grant/revoke against a deployed security, plus
// the Hedera address plumbing it needs. Issuance runs in the browser through the
// ATS SDK, which has no server-side signer (D42).
//
// Spec: docs/architecture.md §4.5

export {
  AtsComplianceGateway,
  MockComplianceGateway,
  KYC_ABI,
  KYC_STATUS,
  NO_EXPIRY_SECONDS,
  type ComplianceGateway,
  type ComplianceResult,
  type GrantKycInput,
  type AtsGatewayOptions,
} from "./ats/compliance.js";

export {
  hederaChain,
  createAddressResolver,
  hashscanUrl,
  isHederaId,
  HEDERA_TESTNET_CHAIN_ID,
  HEDERA_MAINNET_CHAIN_ID,
  type AddressResolver,
} from "./ats/hedera.js";

export {
  BondIssuer,
  isinCheckDigit,
  completeIsin,
  isValidIsin,
  isValidRegulation,
  FACTORY_ABI,
  RESOLVER_ABI,
  ROLES,
  CONFIG_ID,
  REGULATION_TYPE,
  REGULATION_SUB_TYPE,
  type IssueBondInput,
  type IssueBondResult,
  type BondIssuerOptions,
} from "./ats/bond.js";
