-- Fix escrow RPC service-role checks for current PostgREST JWT claim settings.
-- Keep the legacy GUC as a fallback for older PostgREST versions.
do $migration$
declare
  function_signature text;
  function_definition text;
  old_guard text := $old$if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;$old$;
  new_guard text := $new$if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;$new$;
begin
  foreach function_signature in array array[
    'public.confirm_p2p_escrow_order(uuid,jsonb)',
    'public.finalize_p2p_escrow_fill(jsonb)',
    'public.finalize_p2p_escrow_cancel(uuid,jsonb)'
  ] loop
    select pg_get_functiondef(to_regprocedure(function_signature)::oid)
      into function_definition;
    if function_definition is null then
      raise exception 'Required escrow function is missing: %', function_signature;
    end if;
    if position(old_guard in function_definition) = 0 then
      raise exception 'Expected service-role guard not found in %; refusing to change function', function_signature;
    end if;
    execute replace(function_definition, old_guard, new_guard);
  end loop;
end
$migration$;

-- Verify the patched functions still exist and remain executable only by service_role.
do $verification$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'public.confirm_p2p_escrow_order(uuid,jsonb)',
    'public.finalize_p2p_escrow_fill(jsonb)',
    'public.finalize_p2p_escrow_cancel(uuid,jsonb)'
  ] loop
    if position('auth.jwt()' in pg_get_functiondef(to_regprocedure(function_signature)::oid)) = 0 then
      raise exception 'JWT role guard verification failed for %', function_signature;
    end if;
    if has_function_privilege('authenticated', to_regprocedure(function_signature), 'EXECUTE') then
      raise exception 'Authenticated execute privilege unexpectedly granted for %', function_signature;
    end if;
    if not has_function_privilege('service_role', to_regprocedure(function_signature), 'EXECUTE') then
      raise exception 'service_role execute privilege missing for %', function_signature;
    end if;
  end loop;
end
$verification$;

notify pgrst, 'reload schema';
