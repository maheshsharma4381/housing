-- ============================================================================
-- 018 FREE = BASIC MINUS ADS
--   1. Free gets the CA & auditor portal and the asset register; Basic's only
--      difference is no ads. Pro is unchanged.
--   2. require_feature() names the plans that include a feature from
--      subscription_plans instead of a hard-coded "Basic and Pro", so the message
--      stays right when the platform owner edits plan features.
-- ============================================================================

UPDATE subscription_plans SET
    feature_keys = '{ca_portal,asset_register}',
    features_included = '["Billing & UPI collection", "Receipts", "Notices & tickets", "Double-entry books", "CA & auditor portal", "Asset register & depreciation"]'::jsonb,
    description = 'Everything to run the society, including the CA portal. Residents see a few local offers.'
WHERE tier_code = 'free';

UPDATE subscription_plans SET
    features_included = '["Everything in Free", "No ads"]'::jsonb,
    description = 'Everything in Free, without ads.'
WHERE tier_code = 'basic';

CREATE OR REPLACE FUNCTION public.require_feature(p_society_id UUID, p_key TEXT, p_label TEXT)
RETURNS VOID AS $$
DECLARE
    v_names TEXT[];
    v_n INT;
BEGIN
    IF society_has_feature(p_society_id, p_key) THEN
        RETURN;
    END IF;
    SELECT array_agg(name ORDER BY sort_order) INTO v_names
    FROM subscription_plans WHERE is_active AND p_key = ANY(feature_keys);
    v_n := coalesce(array_length(v_names, 1), 0);
    IF v_n = 0 THEN
        RAISE EXCEPTION '% is not part of any current plan', p_label;
    END IF;
    -- "Pro", "Basic and Pro", "Free, Basic and Pro"
    RAISE EXCEPTION '% is part of the % plan — upgrade under Plan & Billing', p_label,
        CASE WHEN v_n = 1 THEN v_names[1]
             ELSE array_to_string(v_names[1:v_n - 1], ', ') || ' and ' || v_names[v_n] END;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
