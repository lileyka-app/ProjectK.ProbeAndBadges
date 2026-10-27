-- Editions are called "edition", not "program": a probe's `program` field becomes `edition` and
-- the kind 'program' becomes 'edition'. The table is rebuilt for the CHECK constraint, as in 0002.
CREATE TABLE entries_new (
  kind        TEXT NOT NULL CHECK (kind IN ('category', 'edition', 'badge', 'probe', 'award', 'override')),
  id          TEXT NOT NULL,           -- item id; "<krai>|<target>" for overrides
  krai        TEXT,
  json        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
INSERT INTO entries_new (kind, id, krai, json, updated_at, updated_by)
  SELECT
    CASE kind WHEN 'program' THEN 'edition' ELSE kind END,
    id,
    krai,
    CASE
      WHEN kind = 'probe' AND json_type(json, '$.program') IS NOT NULL
        THEN json_remove(json_set(json, '$.edition', json_extract(json, '$.program')), '$.program')
      ELSE json
    END,
    updated_at,
    updated_by
  FROM entries ORDER BY rowid;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;
