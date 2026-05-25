CREATE TABLE page_protections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL,
  protected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  protected_by UUID,
  reason TEXT,

  CONSTRAINT page_protections_page_fkey FOREIGN KEY (page_id) REFERENCES pages(id),
  CONSTRAINT page_protections_protected_by_fkey FOREIGN KEY (protected_by) REFERENCES users(id),
  CONSTRAINT page_protections_page_unique UNIQUE (page_id)
);

CREATE INDEX idx_page_protections_protected_at ON page_protections (protected_at DESC);

CREATE TABLE admin_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(64) NOT NULL,
  actor_user_id UUID,
  target_type VARCHAR(64) NOT NULL,
  target_id UUID,
  target_rev_id UUID,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT admin_events_actor_user_fkey FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT admin_events_event_type_check CHECK (char_length(event_type) <= 64),
  CONSTRAINT admin_events_target_type_check CHECK (char_length(target_type) <= 64)
);

CREATE INDEX idx_admin_events_created_at ON admin_events (created_at DESC);
CREATE INDEX idx_admin_events_target ON admin_events (target_type, target_id);
