-- Migration 008 — pgcrypto lives in the `extensions` schema on Supabase (2026-09-22).
--
-- WHY: begin_resolution() (004) calls digest() and select_due_watches() (007)
-- calls hmac(); both functions pin search_path = public for SECURITY DEFINER
-- safety, which hides extensions.digest/hmac. The self-test caught it:
-- "function digest(text, unknown) does not exist". Additive fix: widen the
-- search_path on exactly the functions that need pgcrypto. A fresh database
-- replays 004/007 unchanged and then this file.

begin;

alter function public.begin_resolution(uuid, uuid, text, integer, uuid, text) set search_path = public, extensions;
alter function public.select_due_watches() set search_path = public, extensions;

commit;
