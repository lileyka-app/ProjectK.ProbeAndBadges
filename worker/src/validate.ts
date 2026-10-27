// Validation of catalog v2. The .NET twin is src/ProjectK.Catalog/CatalogValidator.cs, used by
// the offline CLI; both run against catalog/catalog.json in their tests. This one guards every
// write to the service.

import {
  type Award,
  type Badge,
  type Bundle,
  type ImageSet,
  type Override,
  POINT_LEVELS,
  type Probe,
  type ProbePoint,
  type Edition,
  type Requirement,
  SCHEMA_VERSION,
  STATUSES,
  ULADY,
} from "./model";

export interface Issue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface Report {
  issues: Issue[];
  valid: boolean;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KRAI = /^[a-z]{2,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const IMAGE_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

export const isSlug = (v: unknown): v is string => typeof v === "string" && SLUG.test(v);
export const isKrai = (v: unknown): v is string => typeof v === "string" && KRAI.test(v);

export function imageType(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_TYPES[ext] ?? null;
}

export function isImageName(name: unknown): name is string {
  return typeof name === "string" && IMAGE_NAME.test(name) && !name.includes("..") && imageType(name) !== null;
}

// A typo in a hand-filled template ("requirments") must fail loudly, not vanish.
const FIELDS: Record<string, Set<string>> = {
  bundle: new Set(["schemaVersion", "source", "categories", "editions", "badges", "probes", "awards", "overrides"]),
  source: new Set(["krai", "name", "contact", "generator", "generatedAtUtc"]),
  category: new Set(["id", "title"]),
  edition: new Set(["id", "title", "ulad", "krai"]),
  badge: new Set(["id", "family", "level", "title", "categories", "ulady", "krai", "status", "images", "prerequisites", "requirements", "instructorRequirements", "author", "updatedOn", "notes"]),
  probe: new Set(["id", "title", "ulad", "krai", "edition", "order", "status", "images", "sections", "points"]),
  section: new Set(["id", "code", "title", "points"]),
  point: new Set(["id", "text", "level", "competencies"]),
  award: new Set(["id", "group", "title", "ulad", "krai", "level", "status", "images", "description", "requirements"]),
  override: new Set(["krai", "target", "hidden", "title", "addRequirements", "removeRequirements", "addPoints", "removePoints", "note"]),
  overridePoint: new Set(["section", "id", "text"]),
  requirement: new Set(["id", "text"]),
  images: new Set(["color", "bw"]),
};

/** Checks the raw JSON for unknown fields; run it before normalizing. */
export function checkFields(raw: unknown): Issue[] {
  const issues: Issue[] = [];
  const walk = (value: unknown, shape: string, path: string) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      if (!FIELDS[shape].has(key)) issues.push(error(`${path}.${key}`.replace(/^\./, ""), `Unknown field '${key}'.`));
    }
    const v = value as Record<string, unknown>;
    const each = (key: string, child: string) => {
      if (Array.isArray(v[key])) (v[key] as unknown[]).forEach((x, i) => walk(x, child, `${path}.${key}[${i}]`));
    };
    switch (shape) {
      case "bundle":
        walk(v.source, "source", ".source");
        each("categories", "category");
        each("editions", "edition");
        each("badges", "badge");
        each("probes", "probe");
        each("awards", "award");
        each("overrides", "override");
        break;
      case "badge":
      case "award":
        walk(v.images, "images", `${path}.images`);
        each("requirements", "requirement");
        break;
      case "probe":
        walk(v.images, "images", `${path}.images`);
        each("sections", "section");
        each("points", "point");
        break;
      case "section":
        each("points", "point");
        break;
      case "override":
        each("addRequirements", "requirement");
        each("addPoints", "overridePoint");
        break;
    }
  };
  walk(raw, "bundle", "");
  return issues;
}

/**
 * Validates a bundle on its own, or as a contribution to `reference` (the stored catalog): then
 * prerequisites, categories and override targets may point at stored items, and ids that
 * already belong to another krai are rejected. `images` is every image name that will exist.
 */
export function validate(bundle: Bundle, images: Set<string> | null, reference?: Bundle): Report {
  const issues: Issue[] = [];
  const add = (i: Issue) => issues.push(i);

  if (bundle.schemaVersion !== SCHEMA_VERSION) {
    add(error("schemaVersion", `Expected ${SCHEMA_VERSION}, got ${bundle.schemaVersion}.`));
    return { issues, valid: false };
  }

  const sourceKrai = bundle.source?.krai ?? null;
  if (sourceKrai !== null && !isKrai(sourceKrai)) add(error("source.krai", "Krai is a 2–3 letter lowercase code: ua, pl, cz, de, ..."));

  const ids = (own: { id: string }[], ref?: { id: string }[]) => new Set([...own.map((x) => x.id), ...(ref ?? []).map((x) => x.id)]);
  const categoryIds = ids(bundle.categories, reference?.categories);
  const badgeIds = ids(bundle.badges, reference?.badges);
  const probeIds = ids(bundle.probes, reference?.probes);
  const awardIds = ids(bundle.awards, reference?.awards);

  unique(add, "categories", bundle.categories.map((c) => c.id));
  unique(add, "editions", bundle.editions.map((p) => p.id));
  unique(add, "badges", bundle.badges.map((b) => b.id));
  unique(add, "probes", bundle.probes.map((p) => p.id));
  unique(add, "awards", bundle.awards.map((a) => a.id));

  bundle.categories.forEach((c, i) => {
    slug(add, `categories[${i}].id`, c.id);
    text(add, `categories[${i}].title`, c.title);
  });

  // The bundle's own editions win over stored ones with the same id: that is how one is renamed.
  const editions = new Map<string, Edition>([...(reference?.editions ?? []), ...bundle.editions].map((p) => [p.id, p]));
  bundle.editions.forEach((p, i) => validateEdition(add, bundle, p, `editions[${i}]`, reference));

  bundle.badges.forEach((b, i) => validateBadge(add, bundle, b, `badges[${i}]`, badgeIds, categoryIds, images, reference));

  const pointIds = new Set<string>();
  if (reference) {
    const own = new Set(bundle.probes.map((p) => p.id));
    for (const p of reference.probes) if (!own.has(p.id)) allPoints(p).forEach((x) => pointIds.add(x.id));
  }
  bundle.probes.forEach((p, i) => validateProbe(add, bundle, p, `probes[${i}]`, pointIds, editions, images, reference));
  probeOrders(add, bundle, reference);
  bundle.awards.forEach((a, i) => validateAward(add, bundle, a, `awards[${i}]`, images, reference));

  const overrideKeys = new Set<string>();
  bundle.overrides.forEach((o, i) => {
    const key = `${o.krai}|${o.target}`;
    if (overrideKeys.has(key)) add(error(`overrides[${i}]`, `Second override of ${o.target} for krai '${o.krai}'; merge them into one.`));
    overrideKeys.add(key);
    validateOverride(add, bundle, reference, o, `overrides[${i}]`, badgeIds, probeIds, awardIds);
  });

  return { issues, valid: !issues.some((x) => x.severity === "error") };
}

type Add = (i: Issue) => void;

function validateBadge(add: Add, bundle: Bundle, b: Badge, path: string, badgeIds: Set<string>, categoryIds: Set<string>, images: Set<string> | null, reference?: Bundle) {
  slug(add, `${path}.id`, b.id);
  text(add, `${path}.title`, b.title);
  if (b.family != null) slug(add, `${path}.family`, b.family);
  if (b.level != null && (!Number.isInteger(b.level) || b.level < 1 || b.level > 5)) add(error(`${path}.level`, "Level is 1–5."));
  if (b.categories.length === 0) add(warning(`${path}.categories`, "Badge has no category."));
  for (const c of b.categories) if (!categoryIds.has(c)) add(error(`${path}.categories`, `Unknown category '${c}'.`));
  if (b.ulady.length === 0) add(warning(`${path}.ulady`, "Badge names no ulad."));
  for (const u of b.ulady) if (!(ULADY as readonly string[]).includes(u)) add(error(`${path}.ulady`, `Unknown ulad '${u}'; use one of ${ULADY.join(", ")}.`));
  kraiAndOwnership(add, bundle, reference, path, b.krai, reference?.badges.find((x) => x.id === b.id)?.krai);
  status(add, path, b.status);
  imageSet(add, path, b.images, images, true);
  requirements(add, `${path}.requirements`, b.requirements, true);
  for (const p of b.prerequisites) {
    if (p === b.id) add(error(`${path}.prerequisites`, "Badge cannot require itself."));
    else if (!badgeIds.has(p)) add(error(`${path}.prerequisites`, `Unknown badge '${p}'.`));
  }
  if (b.updatedOn != null && (!DATE.test(b.updatedOn) || Number.isNaN(Date.parse(b.updatedOn)) || new Date(b.updatedOn).toISOString().slice(0, 10) !== b.updatedOn)) {
    add(error(`${path}.updatedOn`, "Date is yyyy-MM-dd."));
  }
}

function validateEdition(add: Add, bundle: Bundle, p: Edition, path: string, reference?: Bundle) {
  slug(add, `${path}.id`, p.id);
  text(add, `${path}.title`, p.title);
  if (!(ULADY as readonly string[]).includes(p.ulad)) add(error(`${path}.ulad`, `Unknown ulad '${p.ulad}'.`));
  kraiAndOwnership(add, bundle, reference, path, p.krai, reference?.editions.find((x) => x.id === p.id)?.krai);
  // Stored probes the bundle does not resend have to keep fitting the edition they name.
  const resent = new Set(bundle.probes.map((x) => x.id));
  const krai = p.krai ?? bundle.source?.krai ?? null;
  for (const probe of reference?.probes ?? []) {
    if (probe.edition !== p.id || resent.has(probe.id)) continue;
    if (probe.ulad !== p.ulad || (probe.krai ?? null) !== krai) add(error(path, `Probe ${probe.id} (${probe.ulad}, ${probe.krai ?? "—"}) belongs to this edition; move it first.`));
  }
}

function validateProbe(add: Add, bundle: Bundle, p: Probe, path: string, pointIds: Set<string>, editions: Map<string, Edition>, images: Set<string> | null, reference?: Bundle) {
  slug(add, `${path}.id`, p.id);
  text(add, `${path}.title`, p.title);
  if (!(ULADY as readonly string[]).includes(p.ulad)) add(error(`${path}.ulad`, `Unknown ulad '${p.ulad}'.`));
  kraiAndOwnership(add, bundle, reference, path, p.krai, reference?.probes.find((x) => x.id === p.id)?.krai);
  if (p.edition != null) probeEdition(add, bundle, p, `${path}.edition`, editions.get(p.edition));
  if (!Number.isInteger(p.order) || p.order < 0) add(error(`${path}.order`, "Order is a whole number from 0; знак прихильника goes first with 0."));
  status(add, path, p.status);
  imageSet(add, path, p.images, images, false);
  unique(add, `${path}.sections`, p.sections.map((s) => s.code));
  p.sections.forEach((s, i) => {
    text(add, `${path}.sections[${i}].code`, s.code);
    text(add, `${path}.sections[${i}].title`, s.title);
    slug(add, `${path}.sections[${i}].id`, s.id);
    points(add, `${path}.sections[${i}].points`, s.points, pointIds);
  });
  points(add, `${path}.points`, p.points, pointIds);
}

/** A probe names an edition that exists, and one of its own ulad and krai. */
function probeEdition(add: Add, bundle: Bundle, p: Probe, path: string, edition: Edition | undefined) {
  slug(add, path, p.edition);
  if (!edition) {
    add(error(path, `Unknown edition '${p.edition}'; add it under editions with the title people see.`));
    return;
  }
  const krai = (x: { krai?: string | null }) => x.krai ?? bundle.source?.krai ?? null;
  if (edition.ulad !== p.ulad) add(error(path, `Edition '${edition.id}' is for ${edition.ulad}, the probe for ${p.ulad}.`));
  if (krai(edition) !== krai(p)) add(error(path, `Edition '${edition.id}' belongs to krai '${krai(edition) ?? "—"}', the probe to '${krai(p) ?? "—"}'.`));
}

function points(add: Add, path: string, list: ProbePoint[], pointIds: Set<string>) {
  list.forEach((p, i) => {
    slug(add, `${path}[${i}].id`, p.id);
    text(add, `${path}[${i}].text`, p.text);
    if (pointIds.has(p.id)) add(error(`${path}[${i}].id`, `Point id '${p.id}' is used twice; point ids are unique across all probes.`));
    pointIds.add(p.id);
    if (p.level != null && !(POINT_LEVELS as readonly string[]).includes(p.level)) {
      add(error(`${path}[${i}].level`, `Unknown level '${p.level}'; use one of ${POINT_LEVELS.join(", ")}.`));
    }
    if (p.competencies != null) {
      if (!Array.isArray(p.competencies)) add(error(`${path}[${i}].competencies`, "Competencies are a list of ids."));
      else {
        p.competencies.forEach((c) => slug(add, `${path}[${i}].competencies`, c));
        unique(add, `${path}[${i}].competencies`, p.competencies);
      }
    }
  });
}

/**
 * Lilejka opens a person's probes one after another by `order`, so two live probes of the same
 * ulad, krai and edition may not share a place. Retired ones are out of the line already.
 */
function probeOrders(add: Add, bundle: Bundle, reference?: Bundle) {
  const own = new Set(bundle.probes.map((p) => p.id));
  const line = (p: Probe) => `${p.ulad}|${p.krai ?? ""}|${p.edition ?? ""}`;
  const taken = new Map<string, Probe>();
  for (const p of reference?.probes ?? []) if (!own.has(p.id) && p.status !== "retired") taken.set(`${line(p)}|${p.order}`, p);
  bundle.probes.forEach((p, i) => {
    if (p.status === "retired") return;
    const key = `${line(p)}|${p.order}`;
    const other = taken.get(key);
    if (other) add(error(`probes[${i}].order`, `Probe ${other.id} already stands at ${p.order} in this edition; give each probe its own place.`));
    else taken.set(key, p);
  });
}

function validateAward(add: Add, bundle: Bundle, a: Award, path: string, images: Set<string> | null, reference?: Bundle) {
  slug(add, `${path}.id`, a.id);
  slug(add, `${path}.group`, a.group);
  text(add, `${path}.title`, a.title);
  if (a.ulad != null && !(ULADY as readonly string[]).includes(a.ulad)) add(error(`${path}.ulad`, `Unknown ulad '${a.ulad}'.`));
  kraiAndOwnership(add, bundle, reference, path, a.krai, reference?.awards.find((x) => x.id === a.id)?.krai);
  status(add, path, a.status);
  imageSet(add, path, a.images, images, true);
  requirements(add, `${path}.requirements`, a.requirements, false);
}

function validateOverride(add: Add, bundle: Bundle, reference: Bundle | undefined, o: Override, path: string, badgeIds: Set<string>, probeIds: Set<string>, awardIds: Set<string>) {
  if (!isKrai(o.krai)) {
    add(error(`${path}.krai`, "Krai is a 2–3 letter lowercase code."));
    return;
  }
  const sourceKrai = bundle.source?.krai;
  if (reference && sourceKrai && o.krai !== sourceKrai) add(error(`${path}.krai`, `A bundle from krai '${sourceKrai}' may only carry its own overrides.`));

  const [kind, id] = typeof o.target === "string" ? o.target.split(/:(.*)/s) : [];
  const known = kind === "badge" ? badgeIds.has(id) : kind === "probe" ? probeIds.has(id) : kind === "award" ? awardIds.has(id) : false;
  if (!known) {
    add(error(`${path}.target`, `Unknown target '${o.target}'; use badge:<id>, probe:<id> or award:<id>.`));
    return;
  }

  const prefix = `${o.krai}-`;
  for (const r of o.addRequirements) if (!r.id.startsWith(prefix)) add(error(`${path}.addRequirements`, `Added requirement '${r.id}' must start with '${prefix}'.`));
  for (const p of o.addPoints) if (!p.id.startsWith(prefix)) add(error(`${path}.addPoints`, `Added point '${p.id}' must start with '${prefix}'.`));
  if (kind !== "probe" && (o.addPoints.length > 0 || o.removePoints.length > 0)) add(error(path, "Points can only be added to or removed from a probe."));
  if (kind === "probe") {
    const probe = bundle.probes.find((p) => p.id === id) ?? reference?.probes.find((p) => p.id === id);
    if (probe) {
      const codes = new Set(probe.sections.map((s) => s.code));
      for (const p of o.addPoints) if (p.section && !codes.has(p.section)) add(error(`${path}.addPoints`, `Probe ${probe.id} has no section '${p.section}'.`));
    }
  }
}

function kraiAndOwnership(add: Add, bundle: Bundle, reference: Bundle | undefined, path: string, krai: string | null | undefined, existing: string | null | undefined) {
  const effective = krai ?? bundle.source?.krai ?? null;
  if (effective === null) add(warning(`${path}.krai`, "Item names no krai and the bundle has no source.krai."));
  else if (!isKrai(effective)) add(error(`${path}.krai`, "Krai is a 2–3 letter lowercase code: ua, pl, cz, de, ..."));
  if (reference && existing && effective && existing !== effective) {
    add(error(`${path}.id`, `This id already belongs to krai '${existing}'. Use an override to change it for '${effective}', or pick another id.`));
  }
}

function status(add: Add, path: string, s: string) {
  if (!(STATUSES as readonly string[]).includes(s)) add(error(`${path}.status`, `Status is one of ${STATUSES.join(", ")}.`));
}

function imageSet(add: Add, path: string, set: ImageSet, available: Set<string> | null, required: boolean) {
  if (set.color == null && set.bw == null) {
    if (required) add(warning(`${path}.images`, "Item has no image."));
    return;
  }
  for (const field of ["color", "bw"] as const) {
    const name = set[field];
    if (name == null) continue;
    if (!isImageName(name)) add(error(`${path}.images.${field}`, `'${name}' is not a valid image file name.`));
    else if (available && !available.has(name)) add(error(`${path}.images.${field}`, `Image '${name}' is not in images/.`));
  }
}

function requirements(add: Add, path: string, list: Requirement[], required: boolean) {
  if (required && list.length === 0) add(warning(path, "No requirements."));
  unique(add, path, list.map((r) => r.id));
  list.forEach((r, i) => {
    text(add, `${path}[${i}].id`, r.id);
    text(add, `${path}[${i}].text`, r.text);
  });
}

export function allPoints(p: Probe): ProbePoint[] {
  return [...p.points, ...p.sections.flatMap((s) => s.points)];
}

function unique(add: Add, path: string, ids: string[]) {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) if (n > 1) add(error(path, `Id '${id}' is used ${n} times.`));
}

function slug(add: Add, path: string, v: unknown) {
  if (!isSlug(v)) add(error(path, `'${v}' is not a slug (lowercase latin letters, digits and '-').`));
}

function text(add: Add, path: string, v: unknown) {
  if (typeof v !== "string" || v.trim() === "") add(error(path, "Required."));
}

export const error = (path: string, message: string): Issue => ({ severity: "error", path, message });
export const warning = (path: string, message: string): Issue => ({ severity: "warning", path, message });

// ---- images -------------------------------------------------------------------------------

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const WARN_IMAGE_BYTES = 512 * 1024;
const ACTIVE_SVG = /<\s*script|<\s*foreignObject|<\s*iframe|<\s*embed|<\s*object|\son[a-z]+\s*=|javascript:|<!ENTITY|(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|data:text)/i;

/**
 * Images are served publicly from the catalog's own origin, so an SVG with a script would run
 * there: anything active is rejected rather than cleaned, and the sender fixes the file.
 */
export function checkImage(name: string, bytes: Uint8Array): Issue[] {
  const path = `images/${name}`;
  if (!isImageName(name)) return [error(path, "Image names use latin letters, digits, '.', '_' and '-' and end in .svg, .png, .webp or .jpg.")];
  const issues: Issue[] = [];
  if (bytes.length > MAX_IMAGE_BYTES) issues.push(error(path, `Image is ${Math.round(bytes.length / 1024)} KB; the limit is ${MAX_IMAGE_BYTES / 1024} KB.`));
  else if (bytes.length > WARN_IMAGE_BYTES) issues.push(warning(path, `Image is ${Math.round(bytes.length / 1024)} KB; consider optimizing it (svgo, pngquant).`));

  const type = imageType(name);
  if (type === "image/svg+xml") {
    if (ACTIVE_SVG.test(new TextDecoder().decode(bytes))) {
      issues.push(error(path, "SVG contains scripts, event handlers, entities, embedded documents or external links."));
    }
  } else if (!hasSignature(type!, bytes)) {
    issues.push(error(path, "File content does not match its extension."));
  }
  return issues;
}

function hasSignature(type: string, b: Uint8Array): boolean {
  const starts = (sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
  switch (type) {
    case "image/png":
      return starts([0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "image/webp":
      return b.length > 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
    default:
      return false;
  }
}
