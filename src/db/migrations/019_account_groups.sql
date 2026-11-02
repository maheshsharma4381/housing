-- ============================================================================
-- 019 GROUPS FOR EVERY LEDGER (Tally-style chart of accounts)
--   1. account_groups: 7 fixed primary groups and 7 system sub-groups per
--      society. Every ledger (an `accounts` row) sits in a group whose nature
--      matches the ledger's type. Codes never change.
--   2. accounts gains group_id (backfilled for existing societies), is_active
--      and updated_at; ledger names are unique per society.
--   3. A ledger with postings can no longer be deleted: ledger_entries no longer
--      cascades from accounts (deleting a society still works).
--   4. New professional permission manage_accounts and can_manage_accounts().
--   5. RLS: no client writes to accounts; groups are readable by whoever can
--      read the chart.
-- ============================================================================

-- ============================================================================
-- 1. GROUPS
-- ============================================================================
CREATE TABLE IF NOT EXISTS account_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES account_groups(id),
    name VARCHAR(128) NOT NULL,
    nature VARCHAR(16) NOT NULL CHECK (nature IN ('asset', 'liability', 'equity', 'income', 'expense')),
    system_key VARCHAR(32),
    sort_order INT NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_account_group_system_key UNIQUE (society_id, system_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_group_name ON account_groups (society_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_account_groups_parent ON account_groups (parent_id);

CREATE OR REPLACE FUNCTION public.ensure_account_groups(p_society_id UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO account_groups (society_id, name, nature, system_key, sort_order)
    SELECT p_society_id, g.name, g.nature, g.key, g.sort
    FROM (VALUES
        ('capital_funds', 'Capital & Funds', 'equity', 10),
        ('current_liabilities', 'Current Liabilities', 'liability', 20),
        ('fixed_assets', 'Fixed Assets', 'asset', 30),
        ('investments', 'Investments', 'asset', 40),
        ('current_assets', 'Current Assets', 'asset', 50),
        ('income', 'Income', 'income', 60),
        ('expenses', 'Expenses', 'expense', 70)
    ) AS g(key, name, nature, sort)
    ON CONFLICT DO NOTHING;

    INSERT INTO account_groups (society_id, parent_id, name, nature, system_key, sort_order)
    SELECT p_society_id, p.id, g.name, p.nature, g.key, g.sort
    FROM (VALUES
        ('sundry_creditors', 'Sundry Creditors', 'current_liabilities', 21),
        ('duties_taxes', 'Duties & Taxes', 'current_liabilities', 22),
        ('member_advances', 'Advances from Members', 'current_liabilities', 23),
        ('bank_accounts', 'Bank Accounts', 'current_assets', 51),
        ('cash_in_hand', 'Cash-in-Hand', 'current_assets', 52),
        ('members_dues', 'Members'' Dues', 'current_assets', 53),
        ('loans_advances', 'Loans & Advances', 'current_assets', 54)
    ) AS g(key, name, parent_key, sort)
    JOIN account_groups p ON p.society_id = p_society_id AND p.system_key = g.parent_key
    ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Nearest system_key walking up from the group itself
CREATE OR REPLACE FUNCTION public.account_group_key(p_group_id UUID)
RETURNS TEXT AS $$
    WITH RECURSIVE up AS (
        SELECT id, parent_id, system_key, 0 AS depth FROM account_groups WHERE id = p_group_id
        UNION ALL
        SELECT g.id, g.parent_id, g.system_key, up.depth + 1
        FROM account_groups g JOIN up ON g.id = up.parent_id
        WHERE up.system_key IS NULL AND up.depth < 32
    )
    SELECT system_key FROM up WHERE system_key IS NOT NULL ORDER BY depth LIMIT 1
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.default_account_group(p_society_id UUID, p_code TEXT, p_type TEXT)
RETURNS UUID AS $$
    SELECT id FROM account_groups
    WHERE society_id = p_society_id
      AND system_key = CASE
          WHEN p_code = '1000' THEN 'bank_accounts'
          WHEN p_code = '1100' THEN 'cash_in_hand'
          WHEN p_code = '1200' THEN 'members_dues'
          WHEN p_code IN ('1300', '1400') THEN 'loans_advances'
          WHEN p_code ~ '^15\d\d$' THEN 'fixed_assets'
          WHEN p_code = '2000' THEN 'sundry_creditors'
          WHEN p_code IN ('2100', '2200') THEN 'duties_taxes'
          WHEN p_code = '2300' THEN 'member_advances'
          WHEN p_type = 'asset' THEN 'current_assets'
          WHEN p_type = 'liability' THEN 'current_liabilities'
          WHEN p_type = 'equity' THEN 'capital_funds'
          WHEN p_type = 'income' THEN 'income'
          WHEN p_type = 'expense' THEN 'expenses'
      END
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. LEDGER COLUMNS AND THE GROUP RULE
-- ============================================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES account_groups(id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_accounts_group ON accounts (group_id);

CREATE OR REPLACE FUNCTION public.trg_account_group()
RETURNS TRIGGER AS $$
DECLARE
    v_group account_groups%ROWTYPE;
BEGIN
    IF NEW.group_id IS NULL THEN
        PERFORM ensure_account_groups(NEW.society_id);
        NEW.group_id := default_account_group(NEW.society_id, NEW.code, NEW.type);
    END IF;
    SELECT * INTO v_group FROM account_groups WHERE id = NEW.group_id;
    IF v_group.id IS NULL OR v_group.society_id <> NEW.society_id OR v_group.nature <> NEW.type THEN
        RAISE EXCEPTION 'Ledger nature must match its group';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        NEW.updated_at := timezone('utc'::text, now());
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_account_group ON accounts;
CREATE TRIGGER trg_account_group
    BEFORE INSERT OR UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION public.trg_account_group();

-- Backfill existing societies
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM societies LOOP
        PERFORM ensure_account_groups(r.id);
    END LOOP;
END $$;
UPDATE accounts SET group_id = default_account_group(society_id, code, type) WHERE group_id IS NULL;
ALTER TABLE accounts ALTER COLUMN group_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_name ON accounts (society_id, lower(name));

-- ============================================================================
-- 3. A LEDGER WITH POSTINGS CANNOT BE DELETED
--    NO ACTION (not RESTRICT) so a society delete, which cascades both
--    accounts and ledger_entries in one statement, still passes.
-- ============================================================================
DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.ledger_entries'::regclass
          AND confrelid = 'public.accounts'::regclass
          AND contype = 'f'
    LOOP
        EXECUTE format('ALTER TABLE ledger_entries DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;
ALTER TABLE ledger_entries ADD CONSTRAINT fk_ledger_entries_account
    FOREIGN KEY (account_id) REFERENCES accounts(id);

-- ============================================================================
-- 4. PERMISSION
-- ============================================================================
CREATE OR REPLACE FUNCTION public.valid_professional_permissions(p JSONB)
RETURNS BOOLEAN AS $$
    SELECT jsonb_typeof(p) = 'array'
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(p) AS x(perm)
           WHERE perm NOT IN (
               'view_reports', 'view_ledger', 'view_bills', 'view_payments', 'view_expenses',
               'view_bank_reconciliation', 'view_documents', 'view_units', 'audit_gst', 'view_audit_logs',
               'manage_accounts'
           )
       )
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.can_manage_accounts(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin() OR has_professional_permission(p_society_id, 'manage_accounts')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. RLS
-- ============================================================================
DROP POLICY IF EXISTS accounts_admin_write ON accounts;
DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts
    FOR SELECT USING (
        is_platform_admin() OR is_society_admin(society_id)
        OR can_view_financials(society_id) OR can_manage_accounts(society_id)
    );

ALTER TABLE account_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_groups_select ON account_groups;
CREATE POLICY account_groups_select ON account_groups
    FOR SELECT USING (
        is_platform_admin() OR is_society_admin(society_id)
        OR can_view_financials(society_id) OR can_manage_accounts(society_id)
    );

REVOKE ALL ON FUNCTION public.ensure_account_groups(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_group_key(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.default_account_group(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_account_group() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_manage_accounts(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_accounts(UUID) TO authenticated;
