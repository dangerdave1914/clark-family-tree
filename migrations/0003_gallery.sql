-- Photo gallery: many photos per person, each tagged with a stage of life.
CREATE TABLE IF NOT EXISTS gallery (id TEXT PRIMARY KEY, person TEXT NOT NULL, photo TEXT NOT NULL, stage TEXT, year TEXT, caption TEXT, added_by TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_gallery_person ON gallery(person);
