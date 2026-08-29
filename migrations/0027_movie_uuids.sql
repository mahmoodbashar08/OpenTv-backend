-- TV Time's own film ids, and the titles they stand for.
--
-- WHY THIS TABLE EXISTS. A TV Time list references a film by uuid and nothing
-- else -- no title, no TMDB id. The importer can name a uuid only if the same
-- uuid appears in that person's tracking rows, so a list of films they never
-- watched arrives unresolvable: measured on one real export, 14 of a list's 22
-- films appeared NOWHERE else in the file. The information is not in there.
--
-- But the uuid is GLOBAL: it means the same film in everybody's export. So a
-- film one member tracked can name that entry for every member who did not.
-- This is that shared map, and it is the whole difference between importing a
-- list and importing a list with its contents.
--
-- WHAT THIS IS NOT. It holds no profile id, no timestamp of anybody's viewing,
-- and no link back to who supplied a row. "This uuid is Iron Man" is a
-- catalogue fact about TV Time's database, not a fact about a person -- and
-- the moment it carried an owner it would become a watch history, which is the
-- one thing this server refuses to store.
--
-- Contribution is still restricted to community members on the app side, for a
-- reason this schema cannot enforce: the SET of uuids a device uploads is a
-- list of films it tracked. Members already publish their films to their
-- profile, so the mapping tells this server nothing it does not have. Somebody
-- who declined the community never contacts it at all.
CREATE TABLE IF NOT EXISTS movie_uuids (
  -- TV Time's uuid, exactly as it appears in the export.
  uuid       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  -- FIRST WRITER WINS, enforced by the primary key and an INSERT OR IGNORE at
  -- the route. One person with a mangled export cannot rename a film for
  -- everybody, and a later correct answer costs nothing because the first one
  -- was already correct in every case but that.
  created_at TEXT NOT NULL
);
