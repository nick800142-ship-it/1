CREATE OR REPLACE FUNCTION private.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND (
        p.agency_role IN ('admin', '管理員', 'super_admin')
        OR p.role IN ('admin', 'super_admin')
      )
  )
$function$;

CREATE OR REPLACE FUNCTION private.guard_profile_identity_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() = OLD.id
    AND NOT private.is_admin()
    AND (
      NEW.agency_role IS DISTINCT FROM OLD.agency_role
      OR NEW.role IS DISTINCT FROM OLD.role
      OR NEW.referrer_id IS DISTINCT FROM OLD.referrer_id
      OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
      OR NEW.master_agent_id IS DISTINCT FROM OLD.master_agent_id
    )
  THEN
    RAISE EXCEPTION 'Only an admin may change account roles or agent hierarchy'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_profile_identity_fields ON public.profiles;
CREATE TRIGGER guard_profile_identity_fields
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION private.guard_profile_identity_fields();

DO $migration$
DECLARE
  affected integer;
BEGIN
  UPDATE public.profiles
  SET agency_role = '一般用戶',
      referrer_id = NULL,
      parent_id = NULL,
      master_agent_id = NULL,
      updated_at = now()
  WHERE email = 'awsd124356@gmail.com'
    AND agency_role = '代理';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one subordinate agent to demote, updated %', affected;
  END IF;

  UPDATE public.profiles
  SET referrer_id = NULL,
      parent_id = NULL,
      master_agent_id = NULL,
      updated_at = now()
  WHERE email IN (
    'rwmt11@gmail.com',
    'wuxingxing178@gmail.com',
    'win198907@gmail.com'
  )
    AND agency_role = '一般用戶'
    AND (
      referrer_id IS NOT NULL
      OR parent_id IS NOT NULL
      OR master_agent_id IS NOT NULL
    );
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 3 THEN
    RAISE EXCEPTION 'Expected exactly three ordinary members to unlink, updated %', affected;
  END IF;

  UPDATE public.profiles
  SET agency_role = '總代理',
      role = 'admin',
      referrer_id = NULL,
      parent_id = NULL,
      master_agent_id = NULL,
      updated_at = now()
  WHERE email = 'ga.oceanfamily@gmail.com'
    AND agency_role = 'admin';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one admin account to promote to independent total agent, updated %', affected;
  END IF;
END;
$migration$;

-- Historical commission_logs, jc_ledger, transactions, and settlement records are untouched.
-- Existing five total-agent profiles are untouched; only the approved subordinate accounts change.
-- The role guard prevents authenticated users from self-editing role or hierarchy fields.
COMMIT;

SELECT
  agency_role,
  role,
  count(*) AS profiles,
  count(*) FILTER (WHERE referrer_id IS NOT NULL OR parent_id IS NOT NULL OR master_agent_id IS NOT NULL) AS linked_profiles
FROM public.profiles
GROUP BY agency_role, role
ORDER BY agency_role, role;

SELECT
  email,
  agency_role,
  role,
  referrer_id,
  parent_id,
  master_agent_id
FROM public.profiles
WHERE email IN (
  'ga.oceanfamily@gmail.com',
  'awsd124356@gmail.com',
  'rwmt11@gmail.com',
  'wuxingxing178@gmail.com',
  'win198907@gmail.com'
)
ORDER BY email;
