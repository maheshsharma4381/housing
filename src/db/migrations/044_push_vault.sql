-- ============================================================================
-- 044: the phone-notification job reads its URL and secret from Supabase Vault
--      Hosted Supabase refuses ALTER DATABASE postgres SET app.push_url (permission denied), so 030's
--      settings cannot be made there. Save them once in the SQL Editor instead:
--        select vault.create_secret('https://<your-domain>/api/push/send-pending', 'sahvaas_push_url');
--        select vault.create_secret('<the CRON_SECRET from Vercel>', 'sahvaas_cron_secret');
--      The app.* settings still work where they are allowed (self-hosted Postgres).
-- ============================================================================
DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
       AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net')
       AND to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        CREATE EXTENSION IF NOT EXISTS pg_net;
        PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sahvaas-push';
        PERFORM cron.schedule('sahvaas-push', '*/5 * * * *', $cron$
            SELECT net.http_post(
                url := s.url,
                headers := jsonb_build_object('Authorization', 'Bearer ' || coalesce(s.secret, '')))
            FROM (SELECT
                    coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sahvaas_push_url' LIMIT 1),
                             nullif(current_setting('app.push_url', true), '')) AS url,
                    coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sahvaas_cron_secret' LIMIT 1),
                             nullif(current_setting('app.cron_secret', true), '')) AS secret) s
            WHERE coalesce(s.url, '') <> ''
        $cron$);
    END IF;
END
$outer$;
