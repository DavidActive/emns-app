-- Applied after the grants migration. Moves the RLS helper functions out of the API-exposed public schema
-- (Supabase security advisor: SECURITY DEFINER functions must not be callable via /rest/v1/rpc).
-- Existing policies keep working because they reference the functions by OID.
create schema if not exists private;
alter function public.current_org_id() set schema private;
alter function public.current_op_role() set schema private;
alter function public.is_platform_admin() set schema private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;
revoke all on function private.current_org_id(), private.current_op_role(), private.is_platform_admin() from public, anon;
grant execute on function private.current_org_id(), private.current_op_role(), private.is_platform_admin() to authenticated, service_role;
