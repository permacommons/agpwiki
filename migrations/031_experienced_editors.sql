-- Page protection gets a level: admins only (as before), or experienced
-- editors and admins.
ALTER TABLE page_protections
  ADD COLUMN level VARCHAR(16) NOT NULL DEFAULT 'admins',
  ADD CONSTRAINT page_protections_level_check CHECK (level IN ('admins', 'experienced'));

-- Experienced status is computed from a contributor's edits. An admin can
-- give it early or take it away; that decision is kept here until changed.
CREATE TABLE experienced_editor_overrides (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  status VARCHAR(16) NOT NULL CHECK (status IN ('granted', 'revoked')),
  reason TEXT,
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
