import type { Award, Badge, Bundle, Entry, Kind, Override, Probe, ProbePoint, Requirement } from "./model";
import { entryId, listOf, normalizeEntry, overrideKey } from "./model";

/**
 * The catalog of one krai: retired items dropped, only items whose `krai` is that krai, with that
 * krai's overrides applied and every other krai's overrides ignored. Without a krai, every item
 * of every krai is kept and no override is applied. There is no "general" krai: the catalog does
 * not claim which items apply beyond the krai they came from. The result carries no overrides, so consumers (Lilejka, the
 * admin preview) never need to know they exist.
 */
export function resolve(catalog: Bundle, krai: string | null): Bundle {
  const overrides = new Map<string, Override>();
  if (krai) for (const o of catalog.overrides) if (o.krai === krai) overrides.set(o.target, o);
  const find = (kind: string, id: string) => overrides.get(`${kind}:${id}`);
  const visible = (x: { status?: string; krai?: string | null }) =>
    x.status !== "retired" && (!krai || x.krai === krai);

  return {
    schemaVersion: catalog.schemaVersion,
    source: { ...catalog.source, krai },
    categories: catalog.categories,
    editions: catalog.editions.filter((p) => !krai || p.krai === krai),
    badges: catalog.badges
      .filter(visible)
      .map((b) => applyBadge(b, find("badge", b.id)))
      .filter((b): b is Badge => b !== null),
    probes: catalog.probes
      .filter(visible)
      .map((p) => applyProbe(p, find("probe", p.id)))
      .filter((p): p is Probe => p !== null)
      .sort((a, b) => a.order - b.order),
    awards: catalog.awards
      .filter(visible)
      .map((a) => applyAward(a, find("award", a.id)))
      .filter((a): a is Award => a !== null),
    overrides: [],
  };
}

function applyBadge(b: Badge, o: Override | undefined): Badge | null {
  if (!o) return b;
  if (o.hidden) return null;
  return {
    ...b,
    title: o.title ?? b.title,
    requirements: applyRequirements(b.requirements, o),
    notes: o.note ? [...b.notes, o.note] : b.notes,
  };
}

function applyAward(a: Award, o: Override | undefined): Award | null {
  if (!o) return a;
  if (o.hidden) return null;
  return { ...a, title: o.title ?? a.title, requirements: applyRequirements(a.requirements, o) };
}

function applyProbe(p: Probe, o: Override | undefined): Probe | null {
  if (!o) return p;
  if (o.hidden) return null;
  const removed = new Set(o.removePoints);
  const points = (list: ProbePoint[], section: string) => [
    ...list.filter((x) => !removed.has(x.id)),
    ...o.addPoints.filter((x) => (x.section ?? "") === section).map((x) => ({ id: x.id, text: x.text })),
  ];
  return {
    ...p,
    title: o.title ?? p.title,
    points: points(p.points, ""),
    sections: p.sections.map((s) => ({ ...s, points: points(s.points, s.code) })),
  };
}

function applyRequirements(list: Requirement[], o: Override): Requirement[] {
  const removed = new Set(o.removeRequirements);
  return [...list.filter((r) => !removed.has(r.id)), ...o.addRequirements];
}

export interface Change {
  action: "added" | "updated";
  kind: Kind;
  id: string;
  before: Entry | null;
  after: Entry;
}

/**
 * Folds a contribution into the catalog: items and overrides are upserted by id and nothing
 * else is touched, so a krai sends only what it adds or changes. Items without a krai inherit
 * the contribution's source.krai.
 */
export function merge(catalog: Bundle, contribution: Bundle): { catalog: Bundle; changes: Change[] } {
  const defaultKrai = contribution.source?.krai ?? null;
  const changes: Change[] = [];
  const result: Bundle = { ...catalog };

  const kinds: Kind[] = ["category", "edition", "badge", "probe", "award", "override"];
  for (const kind of kinds) {
    const list = [...listOf(catalog, kind)];
    const index = new Map(list.map((e, i) => [entryId(kind, e), i]));
    for (const raw of listOf(contribution, kind)) {
      let entry = normalizeEntry(kind, raw);
      if (kind !== "category" && kind !== "override" && (entry as { krai?: string | null }).krai == null && defaultKrai) {
        entry = { ...entry, krai: defaultKrai } as Entry;
      }
      const id = entryId(kind, entry);
      const at = index.get(id);
      if (at === undefined) {
        index.set(id, list.length);
        list.push(entry);
        changes.push({ action: "added", kind, id, before: null, after: entry });
      } else if (JSON.stringify(list[at]) !== JSON.stringify(entry)) {
        changes.push({ action: "updated", kind, id, before: list[at], after: entry });
        list[at] = entry;
      }
    }
    (result as unknown as Record<string, Entry[]>)[listKey(kind)] = list;
  }
  return { catalog: result, changes };
}

function listKey(kind: Kind): string {
  return { category: "categories", edition: "editions", badge: "badges", probe: "probes", award: "awards", override: "overrides" }[kind];
}

export { overrideKey };
