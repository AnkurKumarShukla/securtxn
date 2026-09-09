# @cp/contracts

Hedera Asset Tokenization Studio integration.

```
src/
  deployReceivable.ts   Factory deploy for a verified invoice
  config/networks.ts    testnet | mainnet
  modules/              Control List, Pause, Lock configuration
scripts/deploy-testnet.ts
```

The Control List module points at `GET /internal/identity-registry/:address` in
`@cp/api`. That hook is the real integration point: it makes this platform's KYC
data the compliance backend ERC-3643 actually calls out to, rather than a
cosmetic add-on. Verify SDK method signatures against the installed package
version before wiring — §4.5 gives conceptual shape, not verified signatures.
