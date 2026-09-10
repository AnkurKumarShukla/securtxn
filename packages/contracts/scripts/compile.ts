// Compiles contracts/*.sol into a committed TypeScript artifact.
//
//   pnpm --filter @cp/contracts compile
//
// WHY A GENERATED .ts AND NOT A BUILD STEP. Every internal package here is
// consumed as TypeScript source; adding a compile-on-install for one contract
// would make the whole workspace need a build order. Instead the ABI and
// bytecode are generated once, committed, and imported like any other module —
// and because the ABI is emitted `as const`, viem types every call against it.
//
// The compiler version, optimizer settings and EVM target are written into the
// artifact so the deployed bytecode can be reproduced and verified on HashScan
// months later. That matters: a contract nobody can verify is a contract nobody
// can audit.
//
// Spec: docs/architecture.md 4.5

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const CONTRACT = "PaymentHtlc";
const SOURCE = `${CONTRACT}.sol`;

/**
 * `paris` rather than the compiler default.
 *
 * Hedera's EVM tracks upstream but not instantly, and a contract that deploys
 * on one network and reverts on another because of a single opcode is a bad way
 * to find that out during a demo. Paris predates PUSH0 and costs nothing here.
 */
const EVM_VERSION = "paris";

type SolcOutput = {
  errors?: { severity: string; formattedMessage: string }[];
  contracts?: Record<
    string,
    Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>
  >;
};

function main(): void {
  const source = readFileSync(join(root, "contracts", SOURCE), "utf8");

  const input = {
    language: "Solidity",
    sources: { [SOURCE]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: EVM_VERSION,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input))) as SolcOutput;

  // Warnings are printed but do not stop the build; errors do. Treating a
  // warning as fatal would block on things like an unused parameter, and
  // treating an error as a warning would emit an artifact that cannot deploy.
  const errors = output.errors ?? [];
  for (const error of errors) {
    if (error.severity !== "error") console.warn(error.formattedMessage);
  }
  const fatal = errors.filter((e) => e.severity === "error");
  if (fatal.length > 0) {
    for (const error of fatal) console.error(error.formattedMessage);
    throw new Error(`${SOURCE} failed to compile`);
  }

  const compiled = output.contracts?.[SOURCE]?.[CONTRACT];
  if (!compiled) throw new Error(`${CONTRACT} not found in the compiler output`);

  const bytecode = `0x${compiled.evm.bytecode.object}`;
  const version = solc.version();

  writeFileSync(join(root, "src", "htlc", "artifact.ts"), render({ abi: compiled.abi, bytecode, version }));

  console.log(`${CONTRACT}: ${(bytecode.length - 2) / 2} bytes of runtime + constructor code`);
  console.log(`solc ${version}, evm ${EVM_VERSION}, optimizer 200 runs`);
  console.log("wrote src/htlc/artifact.ts");
}

function render(input: { abi: unknown[]; bytecode: string; version: string }): string {
  return `// GENERATED — do not edit. Run: pnpm --filter @cp/contracts compile
//
// Source:   contracts/${SOURCE}
// Compiler: solc ${input.version}
// Settings: optimizer enabled, 200 runs, evmVersion ${EVM_VERSION}

/** ABI of the deployed escrow. \`as const\` so viem types every call from it. */
export const PAYMENT_HTLC_ABI = ${JSON.stringify(input.abi, null, 2)} as const;

/** Creation bytecode. No constructor arguments — the escrow holds no config. */
export const PAYMENT_HTLC_BYTECODE = "${input.bytecode}" as const;

/** Recorded so a deployment can be reproduced and verified byte for byte. */
export const PAYMENT_HTLC_COMPILER = {
  version: "${input.version}",
  evmVersion: "${EVM_VERSION}",
  optimizer: { enabled: true, runs: 200 },
} as const;
`;
}

main();
