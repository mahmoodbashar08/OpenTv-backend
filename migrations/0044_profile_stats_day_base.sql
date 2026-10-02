-- The totals as they stood when the day's first sync arrived, so the dashboard
-- can say what CHANGED today ("+3 episodes") instead of printing the whole
-- library as if it were today's doing. Counts only, like the totals themselves:
-- still no titles, still no watch history.
ALTER TABLE profile_stats ADD COLUMN day_base_episodes INTEGER;
ALTER TABLE profile_stats ADD COLUMN day_base_movies INTEGER;
