-- Family tree schema. A "union" is a marriage/partnership; children point to it with parent_union.
CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, first TEXT, last TEXT, nick TEXT, born TEXT, died TEXT, notes TEXT, verify TEXT, photo TEXT, parent_union TEXT, ord INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS unions (id TEXT PRIMARY KEY, a TEXT, b TEXT, notes TEXT, ord INTEGER);
CREATE TABLE IF NOT EXISTS heirlooms (id TEXT PRIMARY KEY, person TEXT NOT NULL, title TEXT, story TEXT, photo TEXT, attested_by TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, submitter TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER);
CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, approved INTEGER NOT NULL DEFAULT 0, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status);
