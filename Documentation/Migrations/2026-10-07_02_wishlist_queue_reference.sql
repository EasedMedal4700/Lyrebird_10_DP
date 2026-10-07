-- =====================================================================
-- Migration 2026-10-07_02 - lyrebird.wishlist, readable queue references
-- ADDITIVE ONLY: one nullable column, one CHECK, one comment.
-- Nothing dropped, renamed or rewritten. Existing rows get NULL.
-- Schema before: ../snapshots/2026-10-07_wishlist_before_queue_reference.sql
-- Applied with: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1
-- =====================================================================

begin;

-- The queue Reference of the CURRENT submission, persisted by the 10_DP loader
-- BEFORE the Lyrebird_Validate item is added and reused unchanged by retries,
-- recovery and the Lyrebird_Wishlist item:
--   '<artist> - <album> | WL-<id>-S<submission>'
-- A value whose suffix belongs to an older submission is replaced by the loader
-- after a deliberate resubmission. Orchestrator allows at most 128 characters
-- (verified 2026-10-07; the workflows count UTF-16 units, which is never less
-- than the character count checked here).
alter table lyrebird.wishlist
  add column queue_reference text null;
alter table lyrebird.wishlist
  add constraint wishlist_queue_reference_check
  check (queue_reference is null or char_length(queue_reference) between 1 and 128);

comment on column lyrebird.wishlist.queue_reference is
  'Orchestrator queue Reference of the current submission: ''<artist> - <album> | WL-<id>-S<submission>'' (max 128). Written once per submission by 10_DP before enqueueing; never edit by hand.';

commit;

-- Let PostgREST see the new column.
notify pgrst, 'reload schema';
