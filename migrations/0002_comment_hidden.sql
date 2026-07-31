-- Step 3 — comments. One column, and the reasoning is worth the file.
--
-- Auto-hide must be REVERSIBLE by a moderator (`moderation_actions.action`
-- includes `restore`), and reusing `deleted_at` would make an author's own
-- deletion indistinguishable from an automatic hide — a moderator restoring a
-- comment would then also be un-deleting comments their authors chose to
-- remove.
--
-- Every thread read filters `deleted_at IS NULL AND hidden_at IS NULL`.

ALTER TABLE comments ADD COLUMN hidden_at TEXT;
