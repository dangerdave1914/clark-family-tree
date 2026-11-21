-- Device diagnostics: what happened while painting on a phone (no family data).
CREATE TABLE IF NOT EXISTS diag (id TEXT PRIMARY KEY, at INTEGER, ua TEXT, data TEXT);
