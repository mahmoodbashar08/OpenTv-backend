-- A MESSAGE TO ONE PERSON, from the dashboard (1.6.5).
--
-- Every other notification carries a kind and ids and no text: every sentence
-- the bell shows is written on the phone from the kind. The owner answering
-- one person (a one-star review about an import, say) is the one kind whose
-- words cannot be generated, so it is the only kind that uses this column.
-- One way on purpose: there is no reply path.
ALTER TABLE notifications ADD COLUMN body TEXT;
