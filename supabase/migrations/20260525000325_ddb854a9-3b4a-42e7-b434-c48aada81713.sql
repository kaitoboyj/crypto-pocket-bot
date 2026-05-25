CREATE TABLE IF NOT EXISTS public.bot_users (
  user_id bigint PRIMARY KEY,
  chat_id bigint,
  username text,
  first_name text,
  last_name text,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bot_users ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_bot_users_last_seen ON public.bot_users(last_seen_at DESC);