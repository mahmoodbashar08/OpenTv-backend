-- Two orders, because a profile shows two shelves of the same titles.
--
-- `profile_titles` had one `rank` and the read ordered `favourite DESC, rank`.
-- That produces ONE order, and the owner's profile has two: the Shows shelf is
-- most-recently-watched first, and the Favourite shows shelf is the order they
-- dragged their favourites into. Sorting favourites to the front of the main
-- shelf is not a third opinion about ordering — it is simply wrong for that
-- shelf, and it is what made a public profile list its titles in a different
-- order from the owner's own.
--
-- So `rank` now means POSITION IN THE MAIN SHELF and `fav_rank` position among
-- the favourites. Either may be NULL: a hearted show that has never been
-- watched is absent from the main shelf, and most titles are not favourites.
--
-- The read drops `favourite DESC` in the same commit, and every client
-- re-publishes — PUBLISH_REVISION in mobile/src/community-publish.ts is bumped
-- alongside. Until a phone syncs again its rows have fav_rank NULL, which sorts
-- its favourites by name: stable, and corrected on that phone's next launch.

ALTER TABLE profile_titles ADD COLUMN fav_rank INTEGER;
