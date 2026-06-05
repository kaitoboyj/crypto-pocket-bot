## Goal

Rebrand this cloned bot to "Vi", swap in new Telegram credentials so it runs fully separately from the original bot, clear any old webhook, register a fresh webhook on this project's stable URL, and confirm every existing feature still works.

## 1. Rebrand "Alpha Sniper" / "Alpha" / "Angels" → "Vi"

Only one user-facing string in the codebase references the old brand:

- `src/routes/api/public/telegram/webhook.ts:661` — welcome message
  - Before: `👋 Welcome {username} to Alpha Sniper Trading Bot!`
  - After:  `👋 Welcome {username} to Vi!`

No other "Alpha", "Angels", or "Sniper" strings exist in `src/` or `supabase/`. Bot display name / @handle on Telegram itself is set via BotFather (outside the code) — I'll remind you to rename it there too.

## 2. Rotate credentials (you provide values via the secure secret prompt)

I'll request updates to the existing secrets so the cloned bot uses its own identity and posts to its own group:

- `TELEGRAM_BOT_TOKEN` — new bot's token from BotFather
- `TELEGRAM_GROUP_CHAT_ID` — new admin notification group chat ID

For the admin user ID (the Telegram user allowed to run `/block`, `/blocksend`, `/send`, `/checkblock`): tell me whether it's currently a hardcoded constant or stored as a secret. If hardcoded in `webhook.ts`, I'll replace it inline; if it's a secret, I'll request an update for it. (I'll grep `isAdmin` during build mode to confirm.)

Because the token changes, this bot becomes a completely separate Telegram bot from the original — they can both run simultaneously without interfering.

## 3. Clear old webhooks + register a new one

Using the new `TELEGRAM_BOT_TOKEN` directly against `api.telegram.org` (this project uses the raw bot-token pattern, not the Lovable Telegram connector):

1. `POST /deleteWebhook?drop_pending_updates=true` — removes any webhook the original/cloned bot still has registered, and discards stale queued updates so the new bot starts clean.
2. `POST /setWebhook` with:
   - `url`: `https://project--d2dfcd5e-85ec-43e9-bacf-df7ffda5172b.lovable.app/api/public/telegram/webhook` (stable published URL — won't change if the project is renamed and isn't an `id-preview--` URL that can redirect through auth)
   - `allowed_updates`: `["message","callback_query"]`
   - `max_connections`: 40
3. `POST /getWebhookInfo` — confirm the URL is set, `pending_update_count` is 0, and `last_error_message` is empty.

Note: "the bot never goes offline" — Telegram bots using webhooks don't have an "online" state to maintain. As long as the webhook URL is reachable and returns 200, Telegram keeps delivering updates indefinitely. The published Lovable URL is always-on, so once the webhook is set, the bot stays responsive 24/7. No polling worker is needed.

## 4. Verify every feature end-to-end

After the webhook is live I'll run a smoke check by tailing server logs while you send each command, OR I can drive the checks via the Telegram API directly if you give the go-ahead. Features to confirm:

- `/start` → welcome message (now says "Vi") + main menu buttons
- Admin notifications → group receives "🔘 Button: …" / "💬 Text input" events
- 🧪 Generate Wallet → returns address + private key, increments derivation index
- ♻️ Generate New Phrase → rotates the mnemonic in `bot_state`
- Wallet import flow → accepts seed phrase / private key and stores in `imported_wallets`
- Check Token / contract-address detection → user pastes a contract, bot responds
- Wallet balance lookup → user pastes a wallet address, bot responds with balance
- Appeal flow → ⛑ Appeal button → wallet/tx prompts → 20-min cron approval
- Admin commands: `/block`, `/blocksend`, `/send` (incl. ✏️ Enter user ID manually, ✍️ Custom Message, 🔕 Silent Broadcast), `/checkblock`

If any feature is broken, I'll fix it in the same pass (no scope expansion beyond the existing feature set).

## 5. Files / actions

- `src/routes/api/public/telegram/webhook.ts` — line 661 rebrand, plus admin-ID swap if hardcoded
- Secrets: update `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID` (and admin ID secret if applicable) via the secure prompt
- Sandbox shell calls to Telegram: `deleteWebhook` → `setWebhook` → `getWebhookInfo`
- No database migrations, no new tables, no new commands

## What I will NOT do

- Won't touch the original bot's token, webhook, or group — they stay untouched so the original keeps running.
- Won't add long-polling, a keep-alive worker, or any "uptime monitor" — webhooks don't need them on Lovable's always-on URL.
- Won't change any existing command behavior, RLS, or schema.

## Confirm before I switch to build mode

1. Ready to paste the new `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID`, and admin user ID when I prompt?
2. Did you already create the new bot in BotFather (so the token exists) and add it to the new admin group with permission to post?
