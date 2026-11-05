-- ============================================================================
-- 038: Loose ends (Phase 9)
--   1. Mobiles typed with a 0 after the country code (+91 0 98765 43210)
--   2. Waiting join requests and owner invites close once the person has joined
--   3. Bills name the bank the CA receives into
--   4. A deactivated society sends no notifications
-- ============================================================================

-- ============================================================================
-- 1. MOBILES WITH A 0 AFTER +91
-- ============================================================================
-- from 032_mobile_login.sql; + "+91 0 98765 43210" / "0091 098765 43210": the trunk 0 after 91 is dropped
CREATE OR REPLACE FUNCTION public.normalize_mobile(p TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN d IS NULL THEN NULL
        WHEN intl AND d ~ '^910[0-9]{10}$' THEN '91' || substr(d, 4)
        WHEN intl THEN CASE WHEN length(d) BETWEEN 8 AND 15 THEN d END
        WHEN length(d) < 10 THEN NULL
        WHEN length(d) = 10 THEN '91' || d
        WHEN length(d) = 11 AND left(d, 1) = '0' THEN '91' || substr(d, 2)
        ELSE d
    END
    FROM (SELECT ltrim(coalesce(p, '')) ~ '^(\+|00)' AS intl,
                 nullif(regexp_replace(regexp_replace(ltrim(coalesce(p, '')), '^00', ''), '[^0-9]', '', 'g'), '') AS d) x
$$ LANGUAGE sql IMMUTABLE;

-- Numbers already saved by the old rule (13 digits: 91, 0, then the mobile)
UPDATE unit_owner_contacts SET owner_mobile = '91' || substr(owner_mobile, 4) WHERE owner_mobile ~ '^910[0-9]{10}$';
UPDATE unit_ownerships SET owner_mobile = '91' || substr(owner_mobile, 4) WHERE owner_mobile ~ '^910[0-9]{10}$';
UPDATE join_requests SET mobile = '91' || substr(mobile, 4) WHERE mobile ~ '^910[0-9]{10}$';

-- The pending-invite index is built on normalize_mobile: two invites that now name the same mobile
-- for the same flat keep only the newest, then the index is rebuilt with the new rule
UPDATE member_invites mi SET status = 'revoked'
WHERE mi.status = 'pending' AND mi.mobile IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM member_invites o
      WHERE o.status = 'pending' AND o.mobile IS NOT NULL AND o.society_id = mi.society_id
        AND normalize_mobile(o.mobile) = normalize_mobile(mi.mobile)
        AND coalesce(o.unit_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(mi.unit_id, '00000000-0000-0000-0000-000000000000'::uuid)
        AND (o.created_at, o.id) > (mi.created_at, mi.id));
REINDEX INDEX uq_member_invite_pending_mobile;
