REVOKE ALL ON FUNCTION public.admin_set_jc_price(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_jc_price(numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_set_jc_redeem_price(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_jc_redeem_price(numeric) TO authenticated, service_role;
