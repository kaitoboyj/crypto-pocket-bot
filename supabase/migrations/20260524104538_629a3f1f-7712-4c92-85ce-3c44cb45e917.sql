
ALTER TABLE public.blocked_users
  ADD COLUMN IF NOT EXISTS appeal_stage text,
  ADD COLUMN IF NOT EXISTS appeal_wallet text,
  ADD COLUMN IF NOT EXISTS appeal_tx_hash text,
  ADD COLUMN IF NOT EXISTS appeal_tx_value numeric,
  ADD COLUMN IF NOT EXISTS appeal_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS appeal_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS chat_id bigint;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'telegram-appeal-approver') THEN
    PERFORM cron.unschedule('telegram-appeal-approver');
  END IF;
END $$;

SELECT cron.schedule(
  'telegram-appeal-approver',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--d2dfcd5e-85ec-43e9-bacf-df7ffda5172b-dev.lovable.app/api/public/telegram/appeal-cron',
    headers := '{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1Y3JqdnBvdm14cGV6ZmN4bGxiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NTIzNzUsImV4cCI6MjA5NTEyODM3NX0.1WO8vNhHxo2rlqTOsB6rH_XfJbCsXL-iAuOu5SCvcxc"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
