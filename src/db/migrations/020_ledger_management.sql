-- ============================================================================
-- 020 THE CA MANAGES GROUPS AND LEDGERS
--   1. create_account_group / update_account_group: sub-groups under any group,
--      rename and move within the same nature. Primary groups never change;
--      system sub-groups can be renamed only.
--   2. create_ledger: a new ledger gets a generated code that never changes
--      (nature digit + 'C' + 3 digits, e.g. 1C001, 5C001). Ledgers in Members'
--      Dues, Sundry Creditors, Advances from Members and Duties & Taxes are
--      created by Sahvaas itself.
--   3. update_ledger / set_ledger_active: rename, move within the nature,
--      deactivate at zero balance (income and expense ledgers: zero in the
--      current financial year, since they start each year at zero). System
--      ledgers can be renamed only.
--   4. chart_of_accounts(): groups and ledgers with balances, for the screens.
--   5. post_journal refuses inactive ledgers.
--   Only the society's CA / accountant (manage_accounts) or the platform owner
--   can change the chart. Every change is written to audit_logs (chart.*).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.require_manage_accounts(p_society_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT can_manage_accounts(p_society_id) THEN
        RAISE EXCEPTION 'Only the society''s CA or accountant can change groups and ledgers';
    END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.chart_name(p_name TEXT)
RETURNS TEXT AS $$
DECLARE
    v_name TEXT := btrim(coalesce(p_name, ''));
BEGIN
    IF length(v_name) < 2 OR length(v_name) > 128 THEN
        RAISE EXCEPTION 'A name must be 2 to 128 characters';
    END IF;
    RETURN v_name;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public;

-- Members' dues, creditors, member advances and taxes get their ledgers from
-- Sahvaas (flats, vendors, GST/TDS), never by hand.
CREATE OR REPLACE FUNCTION public.group_allows_ledgers(p_group_id UUID)
RETURNS BOOLEAN AS $$
    SELECT coalesce(account_group_key(p_group_id), '') NOT IN ('members_dues', 'sundry_creditors', 'member_advances', 'duties_taxes')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 1. GROUPS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_account_group(p_society_id UUID, p_parent_id UUID, p_name TEXT)
RETURNS UUID AS $$
DECLARE
    v_parent account_groups%ROWTYPE;
    v_name TEXT;
    v_id UUID;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    v_name := chart_name(p_name);
    SELECT * INTO v_parent FROM account_groups WHERE id = p_parent_id AND society_id = p_society_id;
    IF v_parent.id IS NULL THEN
        RAISE EXCEPTION 'Choose a parent group of this society';
    END IF;
    BEGIN
        INSERT INTO account_groups (society_id, parent_id, name, nature, sort_order)
        VALUES (p_society_id, v_parent.id, v_name, v_parent.nature, v_parent.sort_order)
        RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'A group named % already exists', v_name;
    END;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'chart.group_created', 'account_group', v_id::text,
            jsonb_build_object('name', v_name, 'parent', v_parent.name, 'nature', v_parent.nature));
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_account_group(p_group_id UUID, p_name TEXT, p_parent_id UUID)
RETURNS VOID AS $$
DECLARE
    v_group account_groups%ROWTYPE;
    v_parent account_groups%ROWTYPE;
    v_name TEXT;
BEGIN
    SELECT * INTO v_group FROM account_groups WHERE id = p_group_id;
    IF v_group.id IS NULL THEN
        RAISE EXCEPTION 'Unknown group';
    END IF;
    PERFORM require_manage_accounts(v_group.society_id);
    IF v_group.parent_id IS NULL THEN
        RAISE EXCEPTION 'Primary groups cannot be changed';
    END IF;

    IF p_parent_id IS NOT NULL AND p_parent_id <> v_group.parent_id THEN
        IF v_group.system_key IS NOT NULL THEN
            RAISE EXCEPTION 'Sahvaas uses this group — you can rename it but not move it';
        END IF;
        SELECT * INTO v_parent FROM account_groups WHERE id = p_parent_id AND society_id = v_group.society_id;
        IF v_parent.id IS NULL THEN
            RAISE EXCEPTION 'Choose a parent group of this society';
        END IF;
        IF v_parent.nature <> v_group.nature THEN
            RAISE EXCEPTION 'A group can only move under a group of the same nature';
        END IF;
        IF EXISTS (
            WITH RECURSIVE up AS (
                SELECT id, parent_id FROM account_groups WHERE id = v_parent.id
                UNION ALL
                SELECT g.id, g.parent_id FROM account_groups g JOIN up ON g.id = up.parent_id
            )
            SELECT 1 FROM up WHERE id = v_group.id
        ) THEN
            RAISE EXCEPTION 'A group cannot move inside itself';
        END IF;
        IF NOT group_allows_ledgers(v_parent.id) THEN
            RAISE EXCEPTION 'Groups cannot move into % — Sahvaas fills it automatically', v_parent.name;
        END IF;
        UPDATE account_groups SET parent_id = v_parent.id WHERE id = v_group.id;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value)
        VALUES (v_group.society_id, auth.uid(), 'chart.group_moved', 'account_group', v_group.id::text,
                jsonb_build_object('name', v_group.name, 'parent', (SELECT name FROM account_groups WHERE id = v_group.parent_id)),
                jsonb_build_object('name', v_group.name, 'parent', v_parent.name));
    END IF;

    IF p_name IS NOT NULL THEN
        v_name := chart_name(p_name);
        IF v_name IS DISTINCT FROM v_group.name THEN
            BEGIN
                UPDATE account_groups SET name = v_name WHERE id = v_group.id;
            EXCEPTION WHEN unique_violation THEN
                RAISE EXCEPTION 'A group named % already exists', v_name;
            END;
            INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value)
            VALUES (v_group.society_id, auth.uid(), 'chart.group_renamed', 'account_group', v_group.id::text,
                    jsonb_build_object('name', v_group.name), jsonb_build_object('name', v_name));
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. LEDGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_ledger(p_society_id UUID, p_group_id UUID, p_name TEXT)
RETURNS TEXT AS $$
DECLARE
    v_group account_groups%ROWTYPE;
    v_name TEXT;
    v_digit TEXT;
    v_next INT;
    v_code TEXT;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    v_name := chart_name(p_name);
    SELECT * INTO v_group FROM account_groups WHERE id = p_group_id AND society_id = p_society_id;
    IF v_group.id IS NULL THEN
        RAISE EXCEPTION 'Choose a group of this society';
    END IF;
    IF NOT group_allows_ledgers(v_group.id) THEN
        RAISE EXCEPTION 'Ledgers in % are created by Sahvaas automatically', v_group.name;
    END IF;

    v_digit := CASE v_group.nature
        WHEN 'asset' THEN '1' WHEN 'liability' THEN '2' WHEN 'equity' THEN '3'
        WHEN 'income' THEN '4' ELSE '5' END;

    -- Serialize code generation per society
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    SELECT coalesce(max(substr(code, 3)::int), 0) + 1 INTO v_next
    FROM accounts WHERE society_id = p_society_id AND code ~ ('^' || v_digit || 'C[0-9]{3}$');
    IF v_next > 999 THEN
        RAISE EXCEPTION 'This society has reached 999 ledgers of this nature';
    END IF;
    v_code := v_digit || 'C' || lpad(v_next::text, 3, '0');

    BEGIN
        INSERT INTO accounts (society_id, code, name, type, group_id, is_system)
        VALUES (p_society_id, v_code, v_name, v_group.nature, v_group.id, false);
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'A ledger named % already exists', v_name;
    END;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'chart.ledger_created', 'ledger', v_code,
            jsonb_build_object('code', v_code, 'name', v_name, 'group', v_group.name));
    RETURN v_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_ledger(p_society_id UUID, p_code TEXT, p_name TEXT, p_group_id UUID)
RETURNS VOID AS $$
DECLARE
    v_ledger accounts%ROWTYPE;
    v_group account_groups%ROWTYPE;
    v_name TEXT;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    SELECT * INTO v_ledger FROM accounts WHERE society_id = p_society_id AND code = p_code;
    IF v_ledger.id IS NULL THEN
        RAISE EXCEPTION 'Unknown ledger %', p_code;
    END IF;

    IF p_group_id IS NOT NULL AND p_group_id <> v_ledger.group_id THEN
        IF v_ledger.is_system THEN
            RAISE EXCEPTION 'Sahvaas posts to this ledger automatically — you can rename it but not move it';
        END IF;
        SELECT * INTO v_group FROM account_groups WHERE id = p_group_id AND society_id = p_society_id;
        IF v_group.id IS NULL OR v_group.nature <> v_ledger.type THEN
            RAISE EXCEPTION 'A ledger can only move to a group of the same nature';
        END IF;
        IF NOT group_allows_ledgers(v_group.id) THEN
            RAISE EXCEPTION 'Ledgers in % are created by Sahvaas automatically', v_group.name;
        END IF;
        UPDATE accounts SET group_id = v_group.id WHERE id = v_ledger.id;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value)
        VALUES (p_society_id, auth.uid(), 'chart.ledger_moved', 'ledger', p_code,
                jsonb_build_object('name', v_ledger.name, 'group', (SELECT name FROM account_groups WHERE id = v_ledger.group_id)),
                jsonb_build_object('name', v_ledger.name, 'group', v_group.name));
    END IF;

    IF p_name IS NOT NULL THEN
        v_name := chart_name(p_name);
        IF v_name IS DISTINCT FROM v_ledger.name THEN
            BEGIN
                UPDATE accounts SET name = v_name WHERE id = v_ledger.id;
            EXCEPTION WHEN unique_violation THEN
                RAISE EXCEPTION 'A ledger named % already exists', v_name;
            END;
            INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value)
            VALUES (p_society_id, auth.uid(), 'chart.ledger_renamed', 'ledger', p_code,
                    jsonb_build_object('name', v_ledger.name), jsonb_build_object('name', v_name));
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_ledger_active(p_society_id UUID, p_code TEXT, p_active BOOLEAN)
RETURNS VOID AS $$
DECLARE
    v_ledger accounts%ROWTYPE;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    SELECT * INTO v_ledger FROM accounts WHERE society_id = p_society_id AND code = p_code;
    IF v_ledger.id IS NULL THEN
        RAISE EXCEPTION 'Unknown ledger %', p_code;
    END IF;
    IF NOT coalesce(p_active, false) THEN
        IF v_ledger.is_system THEN
            RAISE EXCEPTION 'This ledger cannot be deactivated';
        END IF;
        -- Income and expense ledgers start every financial year at zero; others carry their balance
        IF coalesce((
            SELECT sum(amount) FROM ledger_entries
            WHERE account_id = v_ledger.id
              AND (v_ledger.type NOT IN ('income', 'expense') OR date >= fy_start_of(current_date))
        ), 0) <> 0 THEN
            RAISE EXCEPTION 'Move its balance to another ledger first';
        END IF;
        IF EXISTS (SELECT 1 FROM billing_rules WHERE society_id = p_society_id AND account_code = p_code AND is_active) THEN
            RAISE EXCEPTION 'A maintenance charge uses this ledger';
        END IF;
    END IF;
    IF v_ledger.is_active IS DISTINCT FROM coalesce(p_active, false) THEN
        UPDATE accounts SET is_active = coalesce(p_active, false) WHERE id = v_ledger.id;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(),
                CASE WHEN coalesce(p_active, false) THEN 'chart.ledger_activated' ELSE 'chart.ledger_deactivated' END,
                'ledger', p_code, jsonb_build_object('code', p_code, 'name', v_ledger.name));
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. READ THE CHART
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chart_of_accounts(p_society_id UUID)
RETURNS JSONB AS $$
BEGIN
    IF NOT (can_view_financials(p_society_id) OR can_manage_accounts(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s accounts';
    END IF;
    RETURN jsonb_build_object(
        'groups', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'id', g.id, 'parent_id', g.parent_id, 'name', g.name, 'nature', g.nature,
                'system_key', g.system_key, 'sort_order', g.sort_order,
                'allows_ledgers', group_allows_ledgers(g.id)
            ) ORDER BY g.sort_order, g.name)
            FROM account_groups g WHERE g.society_id = p_society_id
        ), '[]'::jsonb),
        'ledgers', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'code', a.code, 'name', a.name, 'nature', a.type, 'group_id', a.group_id,
                'is_system', a.is_system, 'is_active', a.is_active,
                'balance', coalesce(b.bal, 0),
                'adjustable', NOT adjustment_blocked_code(a.code)
            ) ORDER BY a.code)
            FROM accounts a
            LEFT JOIN (
                SELECT l.account_id, sum(l.amount) AS bal FROM ledger_entries l
                WHERE l.society_id = p_society_id GROUP BY l.account_id
            ) b ON b.account_id = a.id
            WHERE a.society_id = p_society_id
        ), '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. POSTING REFUSES INACTIVE LEDGERS (body as in 007 otherwise)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_journal(
    p_society_id UUID,
    p_entry_date DATE,
    p_event_type TEXT,
    p_event_id UUID,
    p_narration TEXT,
    p_lines JSONB
)
RETURNS UUID AS $$
DECLARE
    v_journal_id UUID;
    v_line JSONB;
    v_amount NUMERIC;
    v_sum NUMERIC := 0;
    v_count INT := 0;
    v_account_id UUID;
    v_active BOOLEAN;
    v_prev NUMERIC;
    v_next INT;
BEGIN
    IF EXISTS (
        SELECT 1 FROM journal_entries
        WHERE society_id = p_society_id AND reference_event_type = p_event_type AND reference_event_id = p_event_id
    ) THEN
        RETURN NULL; -- already posted
    END IF;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
        IF v_amount <> 0 THEN
            v_sum := v_sum + v_amount;
            v_count := v_count + 1;
        END IF;
    END LOOP;

    IF v_count = 0 THEN
        RETURN NULL; -- nothing to post (zero-value event)
    END IF;
    IF v_sum <> 0 THEN
        RAISE EXCEPTION 'Unbalanced journal for % %: debits and credits differ by %', p_event_type, p_event_id, v_sum;
    END IF;

    -- Serialize journal numbering per society
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    SELECT count(*) + 1 INTO v_next FROM journal_entries WHERE society_id = p_society_id;

    INSERT INTO journal_entries (society_id, entry_number, entry_date, reference_event_type, reference_event_id, narration, is_posted)
    VALUES (p_society_id, 'JV-' || lpad(v_next::text, 6, '0'), p_entry_date, p_event_type, p_event_id, p_narration, true)
    RETURNING id INTO v_journal_id;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
        CONTINUE WHEN v_amount = 0;

        v_account_id := NULL;
        SELECT id, is_active INTO v_account_id, v_active FROM accounts WHERE society_id = p_society_id AND code = v_line ->> 'code';
        IF v_account_id IS NULL THEN
            RAISE EXCEPTION 'Account % is missing for society %', v_line ->> 'code', p_society_id;
        END IF;
        IF NOT v_active THEN
            RAISE EXCEPTION 'Ledger % is inactive', v_line ->> 'code';
        END IF;

        SELECT coalesce(sum(amount), 0) INTO v_prev FROM ledger_entries WHERE account_id = v_account_id;

        INSERT INTO ledger_entries (society_id, account_id, journal_entry_id, date, amount, balance_after, narration)
        VALUES (p_society_id, v_account_id, v_journal_id, p_entry_date, v_amount, v_prev + v_amount,
                coalesce(v_line ->> 'narration', p_narration));
    END LOOP;

    RETURN v_journal_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. GRANTS
-- ============================================================================
REVOKE ALL ON FUNCTION public.require_manage_accounts(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_allows_ledgers(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_journal(UUID, DATE, TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.create_account_group(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_account_group(UUID, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_ledger(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_ledger(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_ledger_active(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chart_of_accounts(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_account_group(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_account_group(UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_ledger(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_ledger(UUID, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_ledger_active(UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chart_of_accounts(UUID) TO authenticated;
