import { describe, expect, it } from "vitest";
import {
  KYC_ABI,
  KYC_STATUS,
  MockComplianceGateway,
  hashscanUrl,
  hederaChain,
  isHederaId,
} from "../src/index.js";

const SECURITY = "0.0.9213391";
const ACCOUNT = "0xe894a3f95ea13444B669E9243bA4e7c934CDeC0d";

describe("KYC ABI matches the deployed contract", () => {
  // Copied from IKyc.json in @hashgraph/asset-tokenization-contracts 8.0.0.
  // A drifted signature would encode a call the contract rejects, so pin it.
  it("declares grantKyc with the five arguments the contract expects", () => {
    const grant = KYC_ABI.find((f) => f.name === "grantKyc");
    expect(grant?.inputs.map((i) => i.type)).toEqual([
      "address",
      "string",
      "uint256",
      "uint256",
      "address",
    ]);
  });

  it("declares revokeKyc and the status read", () => {
    expect(KYC_ABI.find((f) => f.name === "revokeKyc")?.inputs.map((i) => i.type)).toEqual([
      "address",
    ]);
    const status = KYC_ABI.find((f) => f.name === "getKycStatusFor");
    expect(status?.stateMutability).toBe("view");
    expect(status?.outputs.map((o) => o.type)).toEqual(["uint8"]);
  });
});

describe("hedera chain definition", () => {
  it("describes testnet with a HashScan explorer", () => {
    const chain = hederaChain(296, "https://testnet.hashio.io/api");
    expect(chain.id).toBe(296);
    expect(chain.testnet).toBe(true);
    expect(chain.blockExplorers?.default.url).toContain("testnet");
  });

  it("switches to mainnet at 295", () => {
    expect(hederaChain(295, "https://mainnet.hashio.io/api").testnet).toBe(false);
  });

  it("recognises native entity ids", () => {
    expect(isHederaId("0.0.9213391")).toBe(true);
    expect(isHederaId(ACCOUNT)).toBe(false);
  });

  it("builds explorer links for the demo record", () => {
    expect(hashscanUrl(296, "contract", SECURITY)).toBe(
      "https://hashscan.io/testnet/contract/0.0.9213391",
    );
  });
});

describe("mock gateway", () => {
  it("grants and reports status", async () => {
    const gateway = new MockComplianceGateway();
    expect(await gateway.getKycStatus({ securityId: SECURITY, account: ACCOUNT })).toBe(
      KYC_STATUS.NOT_GRANTED,
    );

    await gateway.grantKyc({
      securityId: SECURITY,
      account: ACCOUNT,
      vcId: "cred-1",
      validFrom: new Date(),
      validTo: null,
    });

    expect(await gateway.getKycStatus({ securityId: SECURITY, account: ACCOUNT })).toBe(
      KYC_STATUS.GRANTED,
    );
  });

  it("never claims to have broadcast", async () => {
    // A caller must be unable to present a mock result as an on-chain grant.
    const result = await new MockComplianceGateway().grantKyc({
      securityId: SECURITY,
      account: ACCOUNT,
      vcId: "cred-1",
      validFrom: new Date(),
      validTo: null,
    });
    expect(result.broadcast).toBe(false);
  });

  it("honours expiry, like the contract does", async () => {
    // Behaving like an allowlist that never lapses would hide the one property
    // the validity window exists to provide (D06).
    const gateway = new MockComplianceGateway();
    await gateway.grantKyc({
      securityId: SECURITY,
      account: ACCOUNT,
      vcId: "cred-expired",
      validFrom: new Date("2020-01-01"),
      validTo: new Date("2021-01-01"),
    });
    expect(await gateway.getKycStatus({ securityId: SECURITY, account: ACCOUNT })).toBe(
      KYC_STATUS.NOT_GRANTED,
    );
  });

  it("revokes", async () => {
    const gateway = new MockComplianceGateway();
    await gateway.grantKyc({
      securityId: SECURITY,
      account: ACCOUNT,
      vcId: "cred-1",
      validFrom: new Date(),
      validTo: null,
    });
    await gateway.revokeKyc({ securityId: SECURITY, account: ACCOUNT });
    expect(await gateway.getKycStatus({ securityId: SECURITY, account: ACCOUNT })).toBe(
      KYC_STATUS.NOT_GRANTED,
    );
  });

  it("keeps grants separate per security", async () => {
    const gateway = new MockComplianceGateway();
    await gateway.grantKyc({
      securityId: SECURITY,
      account: ACCOUNT,
      vcId: "cred-1",
      validFrom: new Date(),
      validTo: null,
    });
    expect(await gateway.getKycStatus({ securityId: "0.0.999999", account: ACCOUNT })).toBe(
      KYC_STATUS.NOT_GRANTED,
    );
  });
});
