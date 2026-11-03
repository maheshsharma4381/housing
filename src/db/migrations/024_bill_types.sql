-- ============================================================================
-- 024 BILL TYPES THE CA MAPS TO LEDGERS
--   1. The secretary picks a bill type (expense_categories); the type decides
--      the ledger and the TDS. A society's own row overrides the Sahvaas
--      default with the same key.
--   2. Only the CA / accountant (manage_accounts) writes a society's rows,
--      through set_bill_type / set_bill_type_active; a type points only to
--      an active expense ledger. Everyone reads one merged list (bill_types).
--   3. Re-pointing a type sends new bills to the new ledger. Earlier bills of
--      this financial year move by an adjustment the committee approves
--      (propose_bill_type_move).
--   4. suggest_tds takes the answer to the "Other" question.
-- ============================================================================

-- ============================================================================
-- 1. WHO WRITES BILL TYPES
-- ============================================================================
DROP POLICY IF EXISTS expense_categories_select ON expense_categories;
DROP POLICY IF EXISTS expense_categories_write ON expense_categories;
CREATE POLICY expense_categories_select ON expense_categories
    FOR SELECT USING (
        society_id IS NULL OR is_platform_admin() OR is_committee_viewer(society_id)
        OR has_professional_permission(society_id, 'view_expenses') OR can_manage_accounts(society_id)
    );
-- Sahvaas defaults: platform owner. Society rows: only the RPCs below (SECURITY DEFINER).
CREATE POLICY expense_categories_write ON expense_categories
    FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

CREATE OR REPLACE FUNCTION public.trg_bill_type_ledger()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.society_id IS NOT NULL AND NEW.is_active AND NOT EXISTS (
        SELECT 1 FROM accounts
        WHERE society_id = NEW.society_id AND code = NEW.account_code AND type = 'expense' AND is_active
    ) THEN
        RAISE EXCEPTION 'A bill type can only point to an active expense ledger';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_bill_type_ledger ON expense_categories;
CREATE TRIGGER trg_bill_type_ledger
    BEFORE INSERT OR UPDATE ON expense_categories
    FOR EACH ROW EXECUTE FUNCTION public.trg_bill_type_ledger();

-- ============================================================================
-- 2. THE MERGED LIST
--    One row per key: the society's own row (active or not), else the active default.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.society_bill_types(p_society_id UUID)
RETURNS SETOF expense_categories AS $$
    SELECT DISTINCT ON (c.key) c.*
    FROM expense_categories c
    WHERE c.society_id = p_society_id OR (c.society_id IS NULL AND c.is_active)
    ORDER BY c.key, c.society_id NULLS LAST
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.bill_types(p_society_id UUID)
RETURNS JSONB AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id) OR can_view_expenses(p_society_id)
            OR can_manage_accounts(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s accounts';
    END IF;
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                   'key', t.key, 'label', t.label, 'account_code', t.account_code, 'ledger_name', a.name,
                   'tds_nature', t.tds_nature, 'asset_account_code', t.asset_account_code,
                   'asset_threshold', t.asset_threshold, 'sort_order', t.sort_order,
                   'is_custom', NOT EXISTS (SELECT 1 FROM expense_categories d WHERE d.society_id IS NULL AND d.key = t.key),
                   'is_active', t.is_active
               ) ORDER BY t.sort_order, t.label)
        FROM society_bill_types(p_society_id) t
        LEFT JOIN accounts a ON a.society_id = p_society_id AND a.code = t.account_code
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. THE CA MAPS, ADDS AND TURNS OFF BILL TYPES
-- ============================================================================
-- p_key NULL: a new type, keyed from its name. Otherwise: the society's own row for that type.
CREATE OR REPLACE FUNCTION public.set_bill_type(
    p_society_id UUID, p_key TEXT, p_label TEXT, p_account_code TEXT, p_tds_nature TEXT
)
RETURNS TEXT AS $$
DECLARE
    v_label TEXT := trim(coalesce(p_label, ''));
    v_key TEXT;
    v_base TEXT;
    v_n INT := 1;
    v_default expense_categories%ROWTYPE;
    v_own expense_categories%ROWTYPE;
    v_old JSONB;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    IF length(v_label) < 2 OR length(v_label) > 96 THEN
        RAISE EXCEPTION 'A bill type name needs 2 to 96 characters';
    END IF;
    IF coalesce(p_tds_nature, '') NOT IN ('none', 'goods', 'contract', 'professional', 'technical', 'rent_building', 'rent_machinery') THEN
        RAISE EXCEPTION 'Unknown TDS type %', p_tds_nature;
    END IF;

    IF p_key IS NULL THEN
        v_base := left(trim(BOTH '_' FROM regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g')), 40);
        IF v_base = '' THEN
            v_base := 'bill_type';
        END IF;
        v_key := v_base;
        WHILE EXISTS (SELECT 1 FROM expense_categories WHERE key = v_key AND (society_id IS NULL OR society_id = p_society_id)) LOOP
            v_n := v_n + 1;
            v_key := v_base || '_' || v_n;
        END LOOP;
    ELSE
        v_key := p_key;
        SELECT * INTO v_default FROM expense_categories WHERE society_id IS NULL AND key = v_key;
        SELECT * INTO v_own FROM expense_categories WHERE society_id = p_society_id AND key = v_key;
        IF v_default.id IS NULL AND v_own.id IS NULL THEN
            RAISE EXCEPTION 'Unknown bill type %', p_key;
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM society_bill_types(p_society_id) t WHERE lower(t.label) = lower(v_label) AND t.key <> v_key) THEN
        RAISE EXCEPTION 'A bill type named % already exists', v_label;
    END IF;

    IF v_own.id IS NOT NULL THEN
        v_old := jsonb_build_object('label', v_own.label, 'account_code', v_own.account_code, 'tds_nature', v_own.tds_nature);
        UPDATE expense_categories
        SET label = v_label, account_code = p_account_code, tds_nature = p_tds_nature
        WHERE id = v_own.id;
    ELSE
        IF v_default.id IS NOT NULL THEN
            v_old := jsonb_build_object('label', v_default.label, 'account_code', v_default.account_code, 'tds_nature', v_default.tds_nature);
        END IF;
        INSERT INTO expense_categories (society_id, key, label, account_code, asset_account_code, asset_threshold, tds_nature, sort_order)
        VALUES (p_society_id, v_key, v_label, p_account_code, v_default.asset_account_code, v_default.asset_threshold,
                p_tds_nature, coalesce(v_default.sort_order, 800));
    END IF;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (p_society_id, auth.uid(), CASE WHEN p_key IS NULL THEN 'bill_type.created' ELSE 'bill_type.updated' END,
            'bill_type', v_key, v_old,
            jsonb_build_object('label', v_label, 'account_code', p_account_code, 'tds_nature', p_tds_nature));
    RETURN v_key;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_bill_type_active(p_society_id UUID, p_key TEXT, p_active BOOLEAN)
RETURNS VOID AS $$
DECLARE
    v_own expense_categories%ROWTYPE;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    IF EXISTS (SELECT 1 FROM expense_categories WHERE society_id IS NULL AND key = p_key) THEN
        RAISE EXCEPTION 'Sahvaas''s standard bill types cannot be turned off';
    END IF;
    SELECT * INTO v_own FROM expense_categories WHERE society_id = p_society_id AND key = p_key;
    IF v_own.id IS NULL THEN
        RAISE EXCEPTION 'Unknown bill type %', p_key;
    END IF;
    IF v_own.is_active IS DISTINCT FROM coalesce(p_active, false) THEN
        UPDATE expense_categories SET is_active = coalesce(p_active, false) WHERE id = v_own.id;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(),
                CASE WHEN coalesce(p_active, false) THEN 'bill_type.activated' ELSE 'bill_type.deactivated' END,
                'bill_type', p_key, jsonb_build_object('label', v_own.label));
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. MOVING THIS YEAR'S EARLIER BILLS (committee approval)
--    What sits on each expense ledger for this type this financial year: the
--    bills' own postings plus earlier approved moves. Everything not on the
--    type's current ledger becomes one adjustment proposal.
-- ============================================================================
ALTER TABLE adjustment_proposals ADD COLUMN IF NOT EXISTS bill_type_key VARCHAR(48);

CREATE OR REPLACE FUNCTION public.propose_bill_type_move(p_society_id UUID, p_key TEXT)
RETURNS JSONB AS $$
DECLARE
    v_type expense_categories;
    v_fy DATE := fy_start_of(current_date);
    v_target TEXT;
    v_target_name TEXT;
    v_lines JSONB;
    v_total NUMERIC;
    v_result JSONB;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    v_type := resolve_expense_category(p_society_id, p_key);
    IF v_type.id IS NULL THEN
        RAISE EXCEPTION 'Unknown bill type %', p_key;
    END IF;
    IF EXISTS (SELECT 1 FROM adjustment_proposals
               WHERE society_id = p_society_id AND bill_type_key = p_key AND status = 'pending') THEN
        RAISE EXCEPTION 'A move for this bill type is already waiting for the committee';
    END IF;
    v_target := v_type.account_code;
    SELECT name INTO v_target_name FROM accounts WHERE society_id = p_society_id AND code = v_target;

    WITH sitting AS (
        SELECT a.code::text AS code, l.amount
        FROM journal_entries j
        JOIN expenses e ON e.id = j.reference_event_id AND e.society_id = p_society_id AND e.category = p_key
        JOIN ledger_entries l ON l.journal_entry_id = j.id
        JOIN accounts a ON a.id = l.account_id AND a.type = 'expense'
        WHERE j.society_id = p_society_id
          AND j.reference_event_type IN ('expense.approved', 'expense.voided', 'expense.paid')
          AND l.date >= v_fy
        UNION ALL
        SELECT x ->> 'code', (x ->> 'amount')::numeric
        FROM adjustment_proposals p, jsonb_array_elements(p.lines) x
        WHERE p.society_id = p_society_id AND p.bill_type_key = p_key AND p.status = 'approved' AND p.entry_date >= v_fy
    ), net AS (
        SELECT code, sum(amount) AS amount FROM sitting
        WHERE code <> v_target
        GROUP BY code
        HAVING sum(amount) <> 0
    )
    SELECT jsonb_agg(jsonb_build_object('code', code, 'amount', -amount) ORDER BY code), sum(amount)
    INTO v_lines, v_total
    FROM net;

    IF v_lines IS NULL OR coalesce(v_total, 0) = 0 THEN
        RAISE EXCEPTION 'Earlier bills of this type are already in %', coalesce(v_target_name, v_target);
    END IF;
    v_lines := jsonb_build_array(jsonb_build_object('code', v_target, 'amount', v_total)) || v_lines;

    v_result := propose_adjustment(p_society_id, current_date,
                                   'Move earlier ' || v_type.label || ' bills to ' || coalesce(v_target_name, v_target), v_lines);
    UPDATE adjustment_proposals SET bill_type_key = p_key WHERE id = (v_result ->> 'id')::uuid;
    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. TDS FOR "OTHER" BILLS (body from 013)
-- ============================================================================
DROP FUNCTION IF EXISTS public.suggest_tds(UUID, UUID, TEXT, NUMERIC, DATE, UUID);
CREATE OR REPLACE FUNCTION public.suggest_tds(
    p_society_id UUID,
    p_vendor_id UUID,
    p_category TEXT,
    p_taxable NUMERIC,
    p_invoice_date DATE DEFAULT NULL,
    p_expense_id UUID DEFAULT NULL,
    p_tds_nature TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_date DATE := coalesce(p_invoice_date, current_date);
    v_taxable NUMERIC := round(coalesce(p_taxable, 0), 2);
    v_cat expense_categories;
    v_rule tds_rules%ROWTYPE;
    v_vendor vendors%ROWTYPE;
    v_pan TEXT;
    v_entity TEXT;
    v_rate NUMERIC;
    v_rate_source TEXT;
    v_fy_start DATE;
    v_prior NUMERIC := 0;
    v_prior_untaxed NUMERIC := 0;
    v_base NUMERIC;
    v_reason TEXT := 'below_limits';
    v_applies BOOLEAN := false;
    v_amount NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can work out TDS';
    END IF;

    v_cat := resolve_expense_category(p_society_id, p_category);
    IF v_cat.id IS NULL THEN
        RETURN jsonb_build_object('applies', false, 'amount', 0, 'rate', 0, 'nature', 'none', 'reason', 'no_category');
    END IF;
    -- 024: an "Other" bill's TDS type is the secretary's answer to one plain question
    IF v_cat.key = 'other' AND p_tds_nature IS NOT NULL THEN
        IF p_tds_nature NOT IN ('contract', 'professional', 'goods') THEN
            RAISE EXCEPTION 'Choose work, professional or goods for an Other bill';
        END IF;
        v_cat.tds_nature := p_tds_nature;
    END IF;
    IF v_cat.tds_nature IN ('none', 'goods') THEN
        RETURN jsonb_build_object('applies', false, 'amount', 0, 'rate', 0, 'nature', v_cat.tds_nature,
                                  'reason', CASE WHEN v_cat.tds_nature = 'goods' THEN 'goods' ELSE 'no_tds' END);
    END IF;

    SELECT * INTO v_rule FROM tds_rules
    WHERE nature = v_cat.tds_nature AND is_active AND effective_from <= v_date
    ORDER BY effective_from DESC LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('applies', false, 'amount', 0, 'rate', 0, 'nature', v_cat.tds_nature, 'reason', 'no_rule');
    END IF;

    IF p_vendor_id IS NOT NULL THEN
        SELECT * INTO v_vendor FROM vendors WHERE id = p_vendor_id AND society_id = p_society_id;
    END IF;
    v_pan := vendor_pan(v_vendor.pan, v_vendor.gstin);
    v_entity := pan_entity(v_pan);

    -- The vendor's total for the Indian financial year (April-March) of the invoice
    v_fy_start := make_date(extract(year FROM v_date)::int - CASE WHEN extract(month FROM v_date) < 4 THEN 1 ELSE 0 END, 4, 1);
    IF v_vendor.id IS NOT NULL THEN
        SELECT coalesce(sum(subtotal), 0), coalesce(sum(subtotal) FILTER (WHERE tds_amount = 0), 0)
        INTO v_prior, v_prior_untaxed
        FROM expenses
        WHERE society_id = p_society_id AND vendor_id = v_vendor.id
          AND status NOT IN ('voided', 'rejected', 'draft')
          AND coalesce(invoice_date, created_at::date) >= v_fy_start
          AND coalesce(invoice_date, created_at::date) < (v_fy_start + interval '1 year')::date
          AND (p_expense_id IS NULL OR id <> p_expense_id);
    END IF;

    v_base := v_taxable;
    IF v_rule.single_bill_limit IS NOT NULL AND v_taxable > v_rule.single_bill_limit THEN
        v_applies := true;
        v_reason := 'single_bill';
    END IF;
    IF v_rule.annual_limit IS NOT NULL AND v_prior + v_taxable > v_rule.annual_limit THEN
        IF NOT v_applies THEN
            v_reason := 'annual_total';
            -- Crossing the yearly limit: TDS also covers this year's earlier bills that had none
            v_base := v_taxable + v_prior_untaxed;
        END IF;
        v_applies := true;
    END IF;

    IF v_vendor.tds_override_rate IS NOT NULL
       AND (v_vendor.tds_override_valid_till IS NULL OR v_vendor.tds_override_valid_till >= v_date) THEN
        v_rate := v_vendor.tds_override_rate;
        v_rate_source := 'certificate';
    ELSIF v_pan IS NULL THEN
        SELECT coalesce((value ->> 'rate')::numeric, 20) INTO v_rate FROM platform_settings WHERE key = 'tds_no_pan_rate';
        v_rate := coalesce(v_rate, 20);
        v_rate_source := 'no_pan';
    ELSE
        v_rate := CASE WHEN v_entity = 'individual' THEN v_rule.rate_individual ELSE v_rule.rate_other END;
        v_rate_source := v_entity;
    END IF;

    IF v_applies THEN
        v_amount := least(round(v_base * v_rate / 100, 0), v_taxable);
    END IF;

    RETURN jsonb_build_object(
        'applies', v_applies,
        'nature', v_cat.tds_nature,
        'section', v_rule.section_label,
        'label', v_rule.label,
        'rate', CASE WHEN v_applies THEN v_rate ELSE 0 END,
        'amount', v_amount,
        'base', CASE WHEN v_applies THEN v_base ELSE 0 END,
        'rule_id', v_rule.id,
        'pan', v_pan,
        'entity', v_entity,
        'rate_source', v_rate_source,
        'reason', v_reason,
        'fy_total', v_prior + v_taxable,
        'single_limit', v_rule.single_bill_limit,
        'annual_limit', v_rule.annual_limit
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.trg_bill_type_ledger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.society_bill_types(UUID) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.bill_types(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_bill_type(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_bill_type_active(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.propose_bill_type_move(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.suggest_tds(UUID, UUID, TEXT, NUMERIC, DATE, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bill_types(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_bill_type(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_bill_type_active(UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_bill_type_move(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_tds(UUID, UUID, TEXT, NUMERIC, DATE, UUID, TEXT) TO authenticated;
