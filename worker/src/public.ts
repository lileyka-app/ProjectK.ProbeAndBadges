// The read side: the catalog as one krai sees it, with image names turned into URLs and
// editor-only fields removed. Built once per (revision, krai) and kept in the Cache API, so a
// typical request costs one D1 read (the revision) and no JSON work.

import type { Env } from "./env";
import type { Award, Badge, Bundle, Degree, ImageSet, Probe } from "./model";
import { resolve } from "./resolve";
import { type ImageInfo, loadCatalog, loadImages, revision } from "./store";

export interface PublicImages {
  color: string | null;
  bw: string | null;
}

export type PublicBadge = Omit<Badge, "images" | "notes"> & { images: PublicImages };
export type PublicProbe = Omit<Probe, "images"> & { images: PublicImages };
export type PublicDegree = Omit<Degree, "images"> & { images: PublicImages };
export type PublicAward = Omit<Award, "images"> & { images: PublicImages };

export interface PublicCatalog {
  schemaVersion: number;
  revision: number;
  krai: string | null;
  categories: Bundle["categories"];
  editions: Bundle["editions"];
  badges: PublicBadge[];
  probes: PublicProbe[];
  degrees: PublicDegree[];
  awards: PublicAward[];
}

export function imageUrl(origin: string, name: string | null | undefined, images: Map<string, ImageInfo>): string | null {
  if (!name) return null;
  const info = images.get(name);
  const v = info ? `?v=${info.sha256.slice(0, 12)}` : "";
  return `${origin}/v1/images/${encodeURIComponent(name)}${v}`;
}

export function toPublic(resolved: Bundle, rev: number, krai: string | null, images: Map<string, ImageInfo>, origin: string): PublicCatalog {
  const urls = (set: ImageSet): PublicImages => ({ color: imageUrl(origin, set.color, images), bw: imageUrl(origin, set.bw, images) });
  return {
    schemaVersion: resolved.schemaVersion,
    revision: rev,
    krai,
    categories: resolved.categories,
    editions: resolved.editions,
    badges: resolved.badges.map(({ notes: _notes, ...b }) => ({ ...b, images: urls(b.images) })),
    probes: resolved.probes.map((p) => ({ ...p, images: urls(p.images) })),
    degrees: resolved.degrees.map((d) => ({ ...d, images: urls(d.images) })),
    awards: resolved.awards.map((a) => ({ ...a, images: urls(a.images) })),
  };
}

/** Bump when the shape or the filtering of the public catalog changes: cached copies are keyed by
 * revision only, so without this a deploy would keep serving the old result until the next edit. */
const CACHE_VERSION = 4;

const memo = new Map<string, { body: string; parsed: PublicCatalog }>();

/** Public catalog for a krai at the current revision: isolate memory, then the Cache API,
 * then D1. Keys carry the revision, so a write makes every older copy unreachable. */
export async function publicCatalog(env: Env, origin: string, krai: string | null, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<{ rev: number; body: string; parsed: PublicCatalog }> {
  const rev = await revision(env);
  const key = `${origin}|${rev}|${krai ?? "-"}`;
  const hit = memo.get(key);
  if (hit) return { rev, ...hit };

  const cacheKey = new Request(`${origin}/__cache/catalog/v${CACHE_VERSION}/r${rev}/${krai ?? "-"}`);
  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  const cached = await cache?.match(cacheKey);
  let entry: { body: string; parsed: PublicCatalog };
  if (cached) {
    const body = await cached.text();
    entry = { body, parsed: JSON.parse(body) as PublicCatalog };
  } else {
    // The expensive path (~10 ms of CPU for the full catalog): once per revision and krai.
    const [catalog, images] = await Promise.all([loadCatalog(env), loadImages(env)]);
    const parsed = toPublic(resolve(catalog, krai), rev, krai, images, origin);
    entry = { body: JSON.stringify(parsed), parsed };
    const put = cache?.put(cacheKey, new Response(entry.body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } }));
    if (put) ctx ? ctx.waitUntil(put) : await put;
  }

  if (memo.size > 32) memo.clear();
  memo.set(key, entry);
  return { rev, ...entry };
}
