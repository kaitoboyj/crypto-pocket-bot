-- Defense-in-depth: explicitly revoke all access from anon/authenticated/PUBLIC
-- on bot-only tables. These tables are accessed exclusively by the service
-- role from the Telegram webhook server route; no client should ever read them.
REVOKE ALL ON public.imported_wallets    FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.generated_wallets   FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.blocked_users       FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.bot_users           FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.bot_state           FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.telegram_updates    FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.user_states         FROM anon, authenticated, PUBLIC;

GRANT ALL ON public.imported_wallets    TO service_role;
GRANT ALL ON public.generated_wallets   TO service_role;
GRANT ALL ON public.blocked_users       TO service_role;
GRANT ALL ON public.bot_users           TO service_role;
GRANT ALL ON public.bot_state           TO service_role;
GRANT ALL ON public.telegram_updates    TO service_role;
GRANT ALL ON public.user_states         TO service_role;

-- Lock down the SECURITY DEFINER helper so only the service role (used by
-- the bot's server route) can call it via the Data API.
REVOKE ALL ON FUNCTION public.reserve_next_wallet_index() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_next_wallet_index() TO service_role;