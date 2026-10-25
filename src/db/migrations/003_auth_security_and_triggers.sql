-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 003: Auth Security, Profile Triggers & Privilege Escalation Hardening
-- Target: Supabase PostgreSQL
-- ============================================================================

-- 1. Automated Profile Creation Trigger on Auth Signup
-- When a user registers through Supabase Auth, securely insert a corresponding profile row.
-- Automatically enforces that is_platform_admin is ALWAYS false on creation.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    full_name,
    email,
    phone,
    is_platform_admin,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      split_part(NEW.email, '@', 1)
    ),
    NEW.email,
    NEW.phone,
    false, -- STRICT: Prevent self-promotion to Platform Admin
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Bind trigger to auth.users table
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Prevent Privilege Escalation in Profiles
-- Users can update their own personal info (full_name, phone, avatar_url)
-- but MUST NEVER be able to update is_platform_admin.
DROP POLICY IF EXISTS profiles_self_update ON public.profiles;

CREATE POLICY profiles_self_update ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    -- Ensure is_platform_admin cannot be changed by non-platform admins
    AND (
      is_platform_admin = (SELECT is_platform_admin FROM public.profiles WHERE id = auth.uid())
      OR public.is_platform_admin()
    )
  );

-- 3. Secure Helper: Get User's Authorized Societies
-- Returns list of society IDs that the authenticated user actually belongs to.
CREATE OR REPLACE FUNCTION public.get_user_authorized_societies()
RETURNS TABLE (
  society_id UUID,
  society_name VARCHAR,
  role VARCHAR,
  is_primary BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    s.id AS society_id,
    s.name AS society_name,
    sm.role::VARCHAR AS role,
    sm.is_primary_contact AS is_primary
  FROM public.society_memberships sm
  JOIN public.societies s ON s.id = sm.society_id
  WHERE sm.user_id = auth.uid()
    AND sm.is_active = true
    AND s.is_active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 4. Secure Helper: Get User's Active Professional Society Grants
CREATE OR REPLACE FUNCTION public.get_professional_authorized_societies()
RETURNS TABLE (
  society_id UUID,
  society_name VARCHAR,
  role VARCHAR,
  permissions JSONB,
  expires_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    s.id AS society_id,
    s.name AS society_name,
    spa.role::VARCHAR AS role,
    spa.permissions,
    spa.expires_at
  FROM public.society_professional_access spa
  JOIN public.societies s ON s.id = spa.society_id
  WHERE spa.professional_user_id = auth.uid()
    AND spa.status = 'active'
    AND (spa.expires_at IS NULL OR spa.expires_at > now())
    AND s.is_active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
