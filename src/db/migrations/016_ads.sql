-- ============================================================================
-- 016 SPONSORED CARDS ON THE FREE PLAN (P12)
--   * ad_campaigns: local sponsors (and Sahvaas house cards), targeting by city /
--     pincode, dates, placements, fixed monthly price — platform admin only
--   * Shown only to residents (owner / tenant) of societies on a plan with ads,
--     never during the trial, never to the committee, never on money screens
--     (the app only has slots on the home feed and the notices list)
--   * ad_daily_stats: per campaign, society, day and placement — no user ids
--   * Public storage bucket "ad-creatives" for sponsor images
-- ============================================================================

CREATE TABLE IF NOT EXISTS ad_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sponsor_name VARCHAR(128) NOT NULL,
    title VARCHAR(80) NOT NULL,
    body VARCHAR(160),
    image_path TEXT CHECK (image_path IS NULL OR (image_path !~ '\.\.' AND image_path ~ '^[a-z0-9/_.-]+$')),
    cta_label VARCHAR(32),
    cta_url TEXT CHECK (cta_url IS NULL OR cta_url ~ '^(https://[^\s]+|tel:\+?[0-9]{6,15})$'),
    cities TEXT[] NOT NULL DEFAULT '{}',
    pincodes TEXT[] NOT NULL DEFAULT '{}',
    placements TEXT[] NOT NULL DEFAULT '{home_feed}'
        CHECK (cardinality(placements) > 0 AND placements <@ ARRAY['home_feed', 'notices']::text[]),
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    monthly_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (monthly_price >= 0),
    is_house BOOLEAN NOT NULL DEFAULT false,      -- Sahvaas's own cards (fill empty slots)
    priority INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'ended')),
    notes TEXT,
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT chk_ad_dates CHECK (ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS ad_daily_stats (
    campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    placement VARCHAR(16) NOT NULL,
    impressions INT NOT NULL DEFAULT 0,
    clicks INT NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, society_id, day, placement)
);

ALTER TABLE ad_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_daily_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_campaigns_admin ON ad_campaigns;
DROP POLICY IF EXISTS ad_daily_stats_admin ON ad_daily_stats;
CREATE POLICY ad_campaigns_admin ON ad_campaigns FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
CREATE POLICY ad_daily_stats_admin ON ad_daily_stats FOR SELECT USING (is_platform_admin());

-- Targeting is matched case-insensitively on city and exactly on pincode
CREATE OR REPLACE FUNCTION public.ad_campaigns_normalise()
RETURNS TRIGGER AS $$
BEGIN
    NEW.cities := coalesce(ARRAY(SELECT DISTINCT lower(trim(c)) FROM unnest(NEW.cities) c WHERE trim(c) <> ''), '{}');
    NEW.pincodes := coalesce(ARRAY(SELECT DISTINCT trim(p) FROM unnest(NEW.pincodes) p WHERE trim(p) <> ''), '{}');
    IF EXISTS (SELECT 1 FROM unnest(NEW.pincodes) p WHERE p !~ '^[0-9]{6}$') THEN
        RAISE EXCEPTION 'Pincodes must have 6 digits';
    END IF;
    NEW.updated_at := timezone('utc'::text, now());
    IF TG_OP = 'INSERT' AND auth.uid() IS NOT NULL THEN
        NEW.created_by := auth.uid();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
DROP TRIGGER IF EXISTS trg_ad_campaigns_normalise ON ad_campaigns;
CREATE TRIGGER trg_ad_campaigns_normalise BEFORE INSERT OR UPDATE ON ad_campaigns
    FOR EACH ROW EXECUTE FUNCTION public.ad_campaigns_normalise();

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('ad-creatives', 'ad-creatives', true, 2097152)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "ad creatives: admin write" ON storage.objects;
DROP POLICY IF EXISTS "ad creatives: admin delete" ON storage.objects;
CREATE POLICY "ad creatives: admin write" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (bucket_id = 'ad-creatives' AND public.is_platform_admin());
CREATE POLICY "ad creatives: admin delete" ON storage.objects
    FOR DELETE TO authenticated USING (bucket_id = 'ad-creatives' AND public.is_platform_admin());

-- ----------------------------------------------------------------------------
-- Eligibility
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.society_shows_ads(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT coalesce((
        SELECT s.is_active AND p.show_ads AND NOT society_in_trial(s.id)
        FROM societies s
        JOIN subscriptions sub ON sub.society_id = s.id
        JOIN subscription_plans p ON p.id = sub.plan_id
        WHERE s.id = p_society_id
    ), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.is_resident_member(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM society_memberships m
        WHERE m.society_id = p_society_id AND m.user_id = auth.uid() AND m.is_active
          AND m.role IN ('resident_owner', 'resident_tenant')
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- No cities and no pincodes = everywhere; otherwise the society's city OR pincode must be listed
CREATE OR REPLACE FUNCTION public.ad_targets_society(p_cities TEXT[], p_pincodes TEXT[], p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM societies s WHERE s.id = p_society_id AND (
            (cardinality(p_cities) = 0 AND cardinality(p_pincodes) = 0)
            OR lower(trim(s.city)) = ANY(p_cities)
            OR trim(s.pincode) = ANY(p_pincodes)
        )
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ad_matches_society(p_campaign ad_campaigns, p_society_id UUID, p_on DATE DEFAULT current_date)
RETURNS BOOLEAN AS $$
    SELECT p_campaign.status = 'live' AND p_on BETWEEN p_campaign.starts_on AND p_campaign.ends_on
       AND ad_targets_society(p_campaign.cities, p_campaign.pincodes, p_society_id)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Up to two cards for this resident's society and slot: sponsors first, house cards fill in
CREATE OR REPLACE FUNCTION public.ads_for_me(p_society_id UUID, p_placement TEXT)
RETURNS TABLE (id UUID, sponsor_name TEXT, title TEXT, body TEXT, image_path TEXT, cta_label TEXT, cta_url TEXT, is_house BOOLEAN) AS $$
BEGIN
    IF NOT is_resident_member(p_society_id) OR NOT society_shows_ads(p_society_id) THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT c.id, c.sponsor_name::text, c.title::text, c.body::text, c.image_path, c.cta_label::text, c.cta_url, c.is_house
    FROM ad_campaigns c
    WHERE p_placement = ANY(c.placements) AND ad_matches_society(c, p_society_id)
    ORDER BY c.is_house, c.priority DESC, random()
    LIMIT 2;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public;

-- Counts only. Ineligible calls are ignored rather than raising (ad blockers, stale tabs).
CREATE OR REPLACE FUNCTION public.record_ad_event(p_campaign_id UUID, p_society_id UUID, p_placement TEXT, p_kind TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    v_c ad_campaigns%ROWTYPE;
BEGIN
    IF p_kind NOT IN ('impression', 'click') THEN
        RETURN false;
    END IF;
    SELECT * INTO v_c FROM ad_campaigns WHERE id = p_campaign_id;
    IF NOT FOUND OR NOT (p_placement = ANY(v_c.placements)) OR NOT ad_matches_society(v_c, p_society_id)
       OR NOT is_resident_member(p_society_id) OR NOT society_shows_ads(p_society_id) THEN
        RETURN false;
    END IF;
    INSERT INTO ad_daily_stats (campaign_id, society_id, day, placement, impressions, clicks)
    VALUES (p_campaign_id, p_society_id, current_date, p_placement,
            CASE WHEN p_kind = 'impression' THEN 1 ELSE 0 END, CASE WHEN p_kind = 'click' THEN 1 ELSE 0 END)
    ON CONFLICT (campaign_id, society_id, day, placement) DO UPDATE SET
        impressions = ad_daily_stats.impressions + EXCLUDED.impressions,
        clicks = ad_daily_stats.clicks + EXCLUDED.clicks;
    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- Platform owner
-- ----------------------------------------------------------------------------
-- Societies (and flats) the campaign's targeting covers right now (works for drafts too)
CREATE OR REPLACE FUNCTION public.ad_reach(p_campaign_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_c ad_campaigns%ROWTYPE;
    v_societies INT;
    v_flats INT;
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    SELECT * INTO v_c FROM ad_campaigns WHERE id = p_campaign_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Campaign not found';
    END IF;
    SELECT count(*), coalesce(sum((SELECT count(*) FROM units u WHERE u.society_id = s.id)), 0)
    INTO v_societies, v_flats
    FROM societies s
    WHERE society_shows_ads(s.id) AND ad_targets_society(v_c.cities, v_c.pincodes, s.id);
    RETURN jsonb_build_object('societies', v_societies, 'flats', v_flats);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_ad_report(p_from DATE, p_to DATE)
RETURNS TABLE (campaign_id UUID, impressions BIGINT, clicks BIGINT, societies BIGINT) AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    RETURN QUERY
    SELECT st.campaign_id, sum(st.impressions)::bigint, sum(st.clicks)::bigint, count(DISTINCT st.society_id)::bigint
    FROM ad_daily_stats st
    WHERE st.day BETWEEN p_from AND p_to
    GROUP BY st.campaign_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.ad_campaigns_normalise() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.society_shows_ads(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_resident_member(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ad_targets_society(TEXT[], TEXT[], UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ad_matches_society(ad_campaigns, UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ads_for_me(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_ad_event(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ad_reach(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_ad_report(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.society_shows_ads(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ads_for_me(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_ad_event(UUID, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ad_reach(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_ad_report(DATE, DATE) TO authenticated;
