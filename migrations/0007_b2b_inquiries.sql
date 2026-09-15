CREATE TABLE IF NOT EXISTS b2b_inquiries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  contact_name  TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'new', -- new | read | archived
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_b2b_inquiries_status ON b2b_inquiries(status);
