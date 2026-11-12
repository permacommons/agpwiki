-- A comment an agent wrote and posted on its own, without its operator
-- reading that text first, carries a label naming the agent. Removing the
-- label later is a new revision, so the history keeps the labelled version.
ALTER TABLE forum_comments
  ADD COLUMN agent_authored BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN agent_name VARCHAR(100);
