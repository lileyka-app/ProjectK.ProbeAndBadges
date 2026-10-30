-- Degrees (ступені) become a kind of their own: a member's ladder in УСП and УПС, each form with
-- its badge. The table is rebuilt for the CHECK constraint, as in 0002; rows keep their order.
CREATE TABLE entries_new (
  kind        TEXT NOT NULL CHECK (kind IN ('category', 'edition', 'badge', 'probe', 'degree', 'award', 'override')),
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
