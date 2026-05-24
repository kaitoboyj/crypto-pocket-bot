CREATE TABLE public.blocked_users (
  user_id bigint PRIMARY KEY,
  blocked_by bigint,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;