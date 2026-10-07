-- =====================================================================
-- Migration 2026-10-07_01 - lyrebird.wishlist, 10_DP part 2
-- ADDITIVE ONLY: new nullable/defaulted columns, one CHECK, one partial
-- unique index, comments. Nothing dropped, renamed or rewritten.
-- Schema before: ../snapshots/2026-10-07_lyrebird_schema_before_part2.sql
-- Pre-checks done 2026-10-07: 6 rows, all status 'new', none of the new
-- column names exist, so no existing data can violate the new constraints.
-- Applied with: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1
-- =====================================================================

begin;

-- Request identity. Default 1 = the value the loader already used, so all
-- existing References (WL-<id>-S1) stay valid; nothing is dispatched again.
alter table lyrebird.wishlist
  add column submission integer not null default 1;
alter table lyrebird.wishlist
  add constraint wishlist_submission_check check (submission >= 1);

-- Release group vs release, kept apart. 'mbid' (existing) stays the release GROUP.
alter table lyrebird.wishlist
  add column mb_release_id uuid null,          -- release chosen by 10_DP (written with status queued)
  add column mb_artist_id uuid null,           -- first credited artist
  add column chosen_release_id uuid null,      -- set BY A HUMAN to resolve RELEASE_CHOICE; must belong to the group
  add column reserved_release_group uuid null; -- album reservation held by this row (10_DP), see index below

-- Duplicate-album guard: at most one row can hold the reservation for a
-- release group. 10_DP claims it (guarded PATCH) BEFORE enqueueing; a second
-- row gets a unique violation (23505) and becomes a duplicate. Released (NULL)
-- when the row ends in a non-active result.
create unique index wishlist_reserved_release_group_uniq
  on lyrebird.wishlist (reserved_release_group)
  where reserved_release_group is not null;

comment on column lyrebird.wishlist.mbid is
  'MusicBrainz release GROUP MBID of the validated album (not a specific release).';
comment on column lyrebird.wishlist.submission is
  'Request version. Only a deliberate resubmission increments it; Reference = WL-<id>-S<submission>.';
comment on column lyrebird.wishlist.mb_release_id is
  'MusicBrainz release chosen by 10_DP (Lyrebird_Wishlist MbReleaseId).';
comment on column lyrebird.wishlist.track_count is
  'Total track count of mb_release_id (all media).';
comment on column lyrebird.wishlist.chosen_release_id is
  'Optional, set by a person: the release to use when 10_DP reports RELEASE_CHOICE. Resubmit after setting it.';
comment on column lyrebird.wishlist.reserved_release_group is
  'Album reservation held by this row while it is being queued/downloaded (unique among non-null values).';

commit;

-- Let PostgREST see the new columns.
notify pgrst, 'reload schema';
