-- Editions of the probe programme become entries of their own (kind 'program'), so the admin
-- names them and Lilejka only shows the name. SQLite cannot change a CHECK constraint in place,
-- so the table is rebuilt; rows keep their order, which loadCatalog reads by rowid.
CREATE TABLE entries_new (
  kind        TEXT NOT NULL CHECK (kind IN ('category', 'program', 'badge', 'probe', 'award', 'override')),
  id          TEXT NOT NULL,           -- item id; "<krai>|<target>" for overrides
  krai        TEXT,
  json        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
INSERT INTO entries_new (kind, id, krai, json, updated_at, updated_by)
  SELECT kind, id, krai, json, updated_at, updated_by FROM entries ORDER BY rowid;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;
