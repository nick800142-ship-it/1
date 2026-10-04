-- Only expose placements updated on or after the 2026-10-04 11:57 Asia/Taipei rollout.
-- Historical rows remain in the database and ledgers; this changes list visibility only.
CREATE OR REPLACE FUNCTION public.list_visible_private_placements()
RETURNS SETOF public.private_placements
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT p.*
  FROM public.private_placements AS p
  WHERE p.is_delisted = false
    AND p.updated_at >= TIMESTAMPTZ '2026-10-04 11:57:00+08'
  ORDER BY p.created_at;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_private_placements()
RETURNS SETOF public.private_placements
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.*
  FROM public.private_placements AS p
  WHERE p.updated_at >= TIMESTAMPTZ '2026-10-04 11:57:00+08'
  ORDER BY p.created_at;
END;
$function$;

COMMENT ON FUNCTION public.list_visible_private_placements() IS
  'Lists non-delisted placements updated since 2026-10-04 11:57 Asia/Taipei.';
COMMENT ON FUNCTION public.admin_list_private_placements() IS
  'Admin-only placement list, restricted to rows updated since 2026-10-04 11:57 Asia/Taipei.';

NOTIFY pgrst, 'reload schema';
