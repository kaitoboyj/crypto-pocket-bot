# Fix wallet balance detection

## Root cause

`src/routes/api/public/telegram/webhook.ts` hardcodes the public Solana RPC:

```
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
```

That endpoint heavily rate-limits (403 / 429) and frequently blocks `getParsedTokenAccountsByOwner`. When any of the three parallel calls throws, `getWalletBalances` returns `{ ok: false }` and the bot shows `(balance unavailable — try again)`. That's why the feature looks broken — it almost always fails silently on the public RPC.

## Plan

1. Store the QuickNode endpoint as a runtime secret `SOLANA_RPC_URL`:
   `https://ancient-convincing-field.solana-mainnet.quiknode.pro/49caaa8b3f247ed213f2807c24ff7011cf07054a/`
2. In `src/routes/api/public/telegram/webhook.ts`:
   - Read `process.env.SOLANA_RPC_URL` (fallback to the public RPC) instead of hardcoding.
   - Build a single module-level `Connection` with `commitment: 'confirmed'` and reuse it.
   - In `getWalletBalances`, wrap each of the 3 RPC calls in its own try/catch so a token-account failure no longer wipes out the SOL balance. Return whatever succeeded; only mark `ok: false` if the SOL call itself fails.
   - Log the actual error (status/message) so future failures are diagnosable in worker logs.
3. Verify by hitting the bot on Telegram (`/generate`, then paste a known funded address) and checking worker logs.

## Out of scope

No UI changes, no DB changes, no other bot features touched.
