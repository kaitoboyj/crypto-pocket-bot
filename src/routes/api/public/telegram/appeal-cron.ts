import { createFileRoute } from '@tanstack/react-router';
import { supabaseAdmin } from '@/integrations/supabase/client.server';

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

export const Route = createFileRoute('/api/public/telegram/appeal-cron')({
  server: {
    handlers: {
      POST: async () => {
        const cutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        const { data, error } = await supabaseAdmin
          .from('blocked_users')
          .select('user_id, chat_id, appeal_submitted_at')
          .eq('appeal_stage', 'submitted')
          .lte('appeal_submitted_at', cutoff)
          .limit(50);

        if (error) {
          console.error('appeal-cron query error:', error);
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        let approved = 0;
        for (const row of data ?? []) {
          const chatId = row.chat_id ?? row.user_id;
          if (!chatId) continue;
          await tg('sendMessage', {
            chat_id: chatId,
            parse_mode: 'HTML',
            text:
              `✅ <b>Appeal Approved</b>\n\n` +
              `Your appeal has been reviewed and approved. To unlock your pool, ` +
              `you must execute a <b>Buy Pool</b> transaction within the next hour. ` +
              `Failure to do so will require submitting a new appeal.`,
          });
          await supabaseAdmin
            .from('blocked_users')
            .update({ appeal_stage: 'approved', appeal_approved_at: new Date().toISOString() })
            .eq('user_id', row.user_id);
          approved++;
        }

        return Response.json({ ok: true, approved });
      },
    },
  },
});
