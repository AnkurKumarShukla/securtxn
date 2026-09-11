// Creates a test stablecoin on Hedera testnet and funds both demo accounts.
//
// WHY THIS EXISTS. Circle's faucet never delivered USDC to the treasury — the
// account's entire transfer history is its original HBAR funding — and the
// money leg cannot be demonstrated without a token the treasury actually holds.
// This issues one we control.
//
// BE PRECISE ABOUT WHAT IT IS. `stUSDC` is OUR token, not Circle's USDC. The
// mechanics it demonstrates are identical — an HTS fungible token moving
// between KYC'd Hedera accounts, through the escrow contract — but nothing here
// should be described as "transferring USDC".
//
//   node packages/contracts/scripts/create-stusdc.mjs

import {
  AccountId,
  Client,
  PrivateKey,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
  TransferTransaction,
} from "@hashgraph/sdk";

const operatorId = AccountId.fromString(process.env.HEDERA_OPERATOR_ID);
const operatorKey = PrivateKey.fromStringECDSA(process.env.HEDERA_OPERATOR_KEY);

// Who receives a starting balance. The payee is funded too so the demo can show
// a balance changing rather than appearing from zero.
const PAYEE = process.env.STUSDC_PAYEE ?? "0.0.10481594";

const DECIMALS = 6; // same as USDC, so amounts read the way people expect
const INITIAL = 1_000_000; // whole tokens, all minted to the treasury
const TO_PAYEE = 25; // a visible starting balance for the receiving side

const client = Client.forTestnet().setOperator(operatorId, operatorKey);

console.log(`operator/treasury : ${operatorId.toString()}`);
console.log(`payee             : ${PAYEE}`);

const create = await new TokenCreateTransaction()
  .setTokenName("Stable Test USD")
  .setTokenSymbol("stUSDC")
  .setTokenType(TokenType.FungibleCommon)
  .setDecimals(DECIMALS)
  .setInitialSupply(INITIAL * 10 ** DECIMALS)
  .setTreasuryAccountId(operatorId)
  // Finite and capped: an unbounded test token invites someone to mint their
  // way to a number that means nothing.
  .setSupplyType(TokenSupplyType.Finite)
  .setMaxSupply(INITIAL * 10 ** DECIMALS)
  .setSupplyKey(operatorKey.publicKey)
  // Deliberately NO kyc or freeze key. The compliance gate this product
  // demonstrates is the ATS bond's; putting a second, different gate on the
  // cash leg would muddle which control is being shown.
  .setAdminKey(operatorKey.publicKey)
  .freezeWith(client)
  .sign(operatorKey);

const createReceipt = await (await create.execute(client)).getReceipt(client);
const tokenId = createReceipt.tokenId;
const num = Number(tokenId.toString().split(".").pop());
const evm = `0x${num.toString(16).padStart(40, "0")}`;

console.log(`\ntoken id   : ${tokenId.toString()}`);
console.log(`evm address: ${evm}`);
console.log(`supply     : ${INITIAL} stUSDC (${DECIMALS} decimals), all at the treasury`);

// Both accounts have unlimited auto-association, so this needs no association
// step. A receiver without free slots would reject the transfer.
const transfer = await new TransferTransaction()
  .addTokenTransfer(tokenId, operatorId, -TO_PAYEE * 10 ** DECIMALS)
  .addTokenTransfer(tokenId, AccountId.fromString(PAYEE), TO_PAYEE * 10 ** DECIMALS)
  .freezeWith(client)
  .sign(operatorKey);

const transferReceipt = await (await transfer.execute(client)).getReceipt(client);
console.log(`\nsent ${TO_PAYEE} stUSDC to the payee: ${transferReceipt.status.toString()}`);

console.log(`\nAdd to .env:`);
console.log(`TOKEN_ADDRESSES={"STUSDC":"${evm}","USDC":"0x0000000000000000000000000000000000068cda"}`);

client.close();
