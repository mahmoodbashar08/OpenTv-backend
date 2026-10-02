-- Naming a title by its key (the dashboard's Today column, among others) scanned
-- whole tables: ~29k rows a lookup on 2 Oct. One index per table it reads.
CREATE INDEX IF NOT EXISTS idx_profile_titles_key ON profile_titles (target_key);
CREATE INDEX IF NOT EXISTS idx_list_items_key ON list_items (target_key);
CREATE INDEX IF NOT EXISTS idx_shared_list_items_key ON shared_list_items (target_key);
