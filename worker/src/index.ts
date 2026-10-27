import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { authenticate, canEditKrai, type User } from "./auth";
import type { Env } from "./env";
import { type Bundle, type Entry, type Kind, type Override, emptyBundle, entryId, entryKrai, KINDS, listOf, normalizeBundle, normalizeEntry } from "./model";
import { publicCatalog } from "./public";
import { type Change, merge } from "./resolve";
import {
  auditStatement,
  bumpRevision,
  changeStatements,
  deleteStatements,
  getSubmission,
  imageStatement,
  loadCatalog,
  loadImages,
  revision,
  sha256Hex,
} from "./store";
import { checkFields, checkImage, error, imageType, isImageName, isKrai, type Issue, MAX_IMAGE_BYTES, validate } from "./validate";

type App = { Bindings: Env; Variables: { user: User } };
const app = new Hono<App>();

// D1 rows are capped at 2 MB and a submission is stored as one row.
const MAX_BUNDLE_BYTES = 1.5 * 1024 * 1024;
const MAX_SUBMISSION_IMAGES = 500;

// ---- public, read-only, cached ------------------------------------------------------------

app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86400 }));

const kraiParam = (c: Context<App>) => {
  const krai = c.req.query("krai")?.toLowerCase() ?? null;
  return krai && isKrai(krai) ? krai : null;
};

/** Short browser/CDN lifetime: the ETag makes revalidation cheap, and edits show up fast. */
async function cachedJson(c: Context<App>, rev: number, krai: string | null, body: string) {
  const etag = `"r${rev}-${krai ?? "all"}-${await shortHash(body)}"`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
    ETag: etag,
  };
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304, headers);
  return c.body(body, 200, headers);
}

async function shortHash(body: string) {
  return (await sha256Hex(new TextEncoder().encode(body))).slice(0, 16);
}

app.get("/health", (c) => c.json({ status: "ready" }));

app.get("/v1/catalog", async (c) => {
  const krai = kraiParam(c);
  const { rev, body } = await publicCatalog(c.env, new URL(c.req.url).origin, krai, c.executionCtx);
  return cachedJson(c, rev, krai, body);
});

app.get("/v1/categories", async (c) => {
  const { rev, parsed } = await publicCatalog(c.env, new URL(c.req.url).origin, null, c.executionCtx);
  return cachedJson(c, rev, null, JSON.stringify(parsed.categories));
});

app.get("/v1/badges", async (c) => {
  const krai = kraiParam(c);
  const { rev, parsed } = await publicCatalog(c.env, new URL(c.req.url).origin, krai, c.executionCtx);
  const { ulad, category, origin, status, family } = c.req.query();
  const q = c.req.query("q")?.toLocaleLowerCase("uk");
  const badges = parsed.badges.filter(
    (b) =>
      (!ulad || b.ulady.includes(ulad)) &&
      (!category || b.categories.includes(category)) &&
      (!origin || b.krai === origin) &&
      (!status || b.status === status) &&
      (!family || b.family === family) &&
      (!q || b.title.toLocaleLowerCase("uk").includes(q)),
  );
  return cachedJson(c, rev, krai, JSON.stringify(badges));
});

for (const [route, list] of [
  ["editions", "editions"],
  ["badges", "badges"],
  ["probes", "probes"],
  ["awards", "awards"],
] as const) {
  app.get(`/v1/${route}/:id`, async (c) => {
    const krai = kraiParam(c);
    const { rev, parsed } = await publicCatalog(c.env, new URL(c.req.url).origin, krai, c.executionCtx);
    const item = (parsed[list] as { id: string }[]).find((x) => x.id === c.req.param("id")!);
    if (!item) return c.json({ error: "not_found" }, 404);
    return cachedJson(c, rev, krai, JSON.stringify(item));
  });
}

app.get("/v1/probes", async (c) => {
  const krai = kraiParam(c);
  const { rev, parsed } = await publicCatalog(c.env, new URL(c.req.url).origin, krai, c.executionCtx);
  const ulad = c.req.query("ulad");
  return cachedJson(c, rev, krai, JSON.stringify(parsed.probes.filter((p) => !ulad || p.ulad === ulad)));
});

app.get("/v1/editions", async (c) => {
  const krai = kraiParam(c);
  const { rev, parsed } = await publicCatalog(c.env, new URL(c.req.url).origin, krai, c.executionCtx);
  const ulad = c.req.query("ulad");
  return cachedJson(c, rev, krai, JSON.stringify(parsed.editions.filter((p) => !ulad || p.ulad === ulad)));
});

app.get("/v1/awards", async (c) => {
  const krai = kraiParam(c);
  const { rev, parsed } = await publicCatalog(c.env, new URL(c.req.url).origin, krai, c.executionCtx);
  const { group, ulad } = c.req.query();
  return cachedJson(c, rev, krai, JSON.stringify(parsed.awards.filter((a) => (!group || a.group === group) && (!ulad || a.ulad === ulad))));
});

app.get("/v1/images/:name", async (c) => {
  const name = c.req.param("name")!;
  if (!isImageName(name)) return c.json({ error: "not_found" }, 404);

  const cache = caches.default;
  const cached = await cache.match(c.req.raw);
  if (cached) return cached;

  const object = await c.env.IMAGES.get(`images/${name}`);
  if (!object) return c.json({ error: "not_found" }, 404);
  // A versioned URL (?v=<sha>) never changes content, so it may be cached for good.
  const immutable = c.req.query("v") !== undefined;
  const response = new Response(object.body, {
    headers: {
      "Content-Type": imageType(name)!,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      ETag: object.httpEtag,
      "Access-Control-Allow-Origin": "*",
      // An SVG opened directly must not be able to run anything, even if one slipped through.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      "X-Content-Type-Options": "nosniff",
    },
  });
  c.executionCtx.waitUntil(cache.put(c.req.raw, response.clone()));
  return response;
});

// ---- signed-in: Cloudflare Access in front, roles from D1 -----------------------------------

const signedIn = async (c: Context<App>, next: () => Promise<void>) => {
  const user = await authenticate(c.req.raw, c.env);
  if (!user) return c.json({ error: "unauthorized", message: "Sign in through Cloudflare Access with an email that has catalog access." }, 401);
  c.set("user", user);
  await next();
};

const reviewer = async (c: Context<App>, next: () => Promise<void>) => {
  if (c.get("user").role === "contributor") return c.json({ error: "forbidden", message: "Contributors send changes as submissions." }, 403);
  await next();
};

const owner = async (c: Context<App>, next: () => Promise<void>) => {
  if (c.get("user").role !== "owner") return c.json({ error: "forbidden", message: "Only owners can do this." }, 403);
  await next();
};

app.use("/v1/admin/*", signedIn);
app.use("/v1/submissions/*", signedIn);
app.use("/v1/submissions", signedIn);

app.get("/v1/admin/me", (c) => c.json(c.get("user")));

app.get("/v1/admin/catalog", async (c) => {
  const [rev, catalog, images] = await Promise.all([revision(c.env), loadCatalog(c.env), loadImages(c.env)]);
  return c.json({ revision: rev, catalog, images: [...images.values()] });
});

const KIND_ROUTES: Record<string, Kind> = { categories: "category", editions: "edition", badges: "badge", probes: "probe", awards: "award", overrides: "override" };

/** Which of these changes the user may not make, as messages; empty when all are allowed. */
export function forbiddenChanges(user: User, changes: Change[]): string[] {
  if (user.role === "owner") return [];
  if (user.role === "contributor") return ["Contributors send changes as submissions; an editor or owner applies them."];
  const problems: string[] = [];
  for (const ch of changes) {
    if (ch.kind === "category") {
      if (ch.action !== "added") problems.push(`category:${ch.id}: only owners change existing categories.`);
      continue;
    }
    const after = entryKrai(ch.kind, ch.after);
    const before = ch.before ? entryKrai(ch.kind, ch.before) : after;
    if (!canEditKrai(user, after) || !canEditKrai(user, before)) {
      problems.push(`${ch.kind}:${ch.id}: belongs to krai '${before ?? "—"}', you edit ${user.krai.join(", ") || "no krai"}.`);
    }
  }
  return problems;
}

function single(kind: Kind, entry: Entry): Bundle {
  const bundle = emptyBundle();
  listOf(bundle, kind).push(entry);
  return bundle;
}

app.put("/v1/admin/entries/:kind/:id", reviewer, async (c) => {
  const kind = KIND_ROUTES[c.req.param("kind")!];
  if (!kind) return c.json({ error: "not_found" }, 404);
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return c.json({ error: "bad_request", message: "Body is the item as JSON." }, 400);

  const fieldIssues = checkFields(single(kind, raw as Entry));
  if (fieldIssues.length) return c.json({ error: "invalid", issues: fieldIssues }, 422);
  const entry = normalizeEntry(kind, raw);
  if (entryId(kind, entry) !== c.req.param("id")!) return c.json({ error: "bad_request", message: "The id in the path and in the body differ." }, 400);

  const [catalog, images] = await Promise.all([loadCatalog(c.env), loadImages(c.env)]);
  const contribution = single(kind, entry);
  contribution.source = { krai: entryKrai(kind, entry) };
  const report = validate(contribution, new Set(images.keys()), catalog);
  if (!report.valid) return c.json({ error: "invalid", issues: report.issues }, 422);

  const { changes } = merge(catalog, contribution);
  const forbidden = forbiddenChanges(c.get("user"), changes);
  if (forbidden.length) return c.json({ error: "forbidden", message: forbidden.join("\n") }, 403);
  if (!changes.length) return c.json({ status: "unchanged", issues: report.issues });

  await c.env.DB.batch([...changeStatements(c.env, changes, c.get("user").email, "edit"), bumpRevision(c.env)]);
  return c.json({ status: changes[0].action, issues: report.issues });
});

/** Badges, probes and awards are retired, not deleted: Lilejka may hold progress against
 * them. Categories, editions and overrides are deleted outright, once nothing points at them. */
app.delete("/v1/admin/entries/:kind/:id", reviewer, async (c) => {
  const kind = KIND_ROUTES[c.req.param("kind")!];
  if (!kind) return c.json({ error: "not_found" }, 404);
  const id = c.req.param("id")!;
  const catalog = await loadCatalog(c.env);
  const existing = listOf(catalog, kind).find((e) => entryId(kind, e) === id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const user = c.get("user");

  if (kind === "category") {
    if (user.role !== "owner") return c.json({ error: "forbidden", message: "Only owners delete categories." }, 403);
    if (catalog.badges.some((b) => b.categories.includes(id))) return c.json({ error: "in_use", message: "Badges still use this category." }, 409);
  }
  if (kind === "edition") {
    if (!canEditKrai(user, entryKrai(kind, existing))) return c.json({ error: "forbidden" }, 403);
    // Retired probes count too: saving one again would fail on the edition it names.
    if (catalog.probes.some((p) => p.edition === id)) return c.json({ error: "in_use", message: "Probes still belong to this edition." }, 409);
  }
  if (kind === "override" && !canEditKrai(user, (existing as Override).krai)) return c.json({ error: "forbidden" }, 403);

  if (kind === "category" || kind === "edition" || kind === "override") {
    await c.env.DB.batch([...deleteStatements(c.env, kind, id, existing, user.email), bumpRevision(c.env)]);
    return c.json({ status: "deleted" });
  }

  const retired = { ...existing, status: "retired" } as Entry;
  const changes: Change[] = [{ action: "updated", kind, id, before: existing, after: retired }];
  const forbidden = forbiddenChanges(user, changes);
  if (forbidden.length) return c.json({ error: "forbidden", message: forbidden.join("\n") }, 403);
  await c.env.DB.batch([...changeStatements(c.env, changes, user.email, "retire"), bumpRevision(c.env)]);
  return c.json({ status: "retired" });
});

async function readImageBody(c: Context<App>): Promise<Uint8Array | Response> {
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (length > MAX_IMAGE_BYTES) return c.json({ error: "too_large" }, 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) return c.json({ error: "too_large" }, 413);
  return bytes;
}

/** Direct upload for a single edit. Replacing an image that already exists with other content
 * changes it for every item that uses it, so only owners may do that. */
app.put("/v1/admin/images/:name", reviewer, async (c) => {
  const name = c.req.param("name")!;
  const bytes = await readImageBody(c);
  if (bytes instanceof Response) return bytes;
  const issues = checkImage(name, bytes);
  if (issues.some((i) => i.severity === "error")) return c.json({ error: "invalid", issues }, 422);

  const sha256 = await sha256Hex(bytes);
  const existing = (await loadImages(c.env)).get(name);
  if (existing?.sha256 === sha256) return c.json({ status: "unchanged", name, sha256 });
  if (existing && c.get("user").role !== "owner") {
    return c.json({ error: "conflict", message: `An image named ${name} already exists; upload under a new name.` }, 409);
  }

  const contentType = imageType(name)!;
  await c.env.IMAGES.put(`images/${name}`, bytes, { httpMetadata: { contentType } });
  const now = new Date().toISOString();
  await c.env.DB.batch([
    imageStatement(c.env, { name, sha256, contentType, size: bytes.length }, c.get("user").email),
    auditStatement(c.env, now, c.get("user").email, existing ? "image:replaced" : "image:added", "image", name, existing ?? null, { sha256 }, null),
    bumpRevision(c.env),
  ]);
  return c.json({ status: existing ? "replaced" : "added", name, sha256, issues });
});

app.get("/v1/admin/export", reviewer, async (c) => {
  const [catalog, images] = await Promise.all([loadCatalog(c.env), loadImages(c.env)]);
  return c.json({ catalog, images: [...images.values()] });
});

app.get("/v1/admin/audit", reviewer, async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const { results } = await c.env.DB.prepare("SELECT seq, at, actor, action, kind, entry_id, submission FROM audit ORDER BY seq DESC LIMIT ?").bind(limit).all();
  return c.json(results);
});

// ---- editors ---------------------------------------------------------------------------------

app.get("/v1/admin/editors", owner, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT email, role, krai, created_at, created_by FROM editors ORDER BY email").all();
  return c.json(results);
});

app.put("/v1/admin/editors/:email", owner, async (c) => {
  const email = decodeURIComponent(c.req.param("email")!).trim().toLowerCase();
  const body = (await c.req.json().catch(() => ({}))) as { role?: string; krai?: string[] };
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return c.json({ error: "bad_request", message: "Not an email." }, 400);
  if (!["owner", "editor", "contributor"].includes(body.role ?? "")) return c.json({ error: "bad_request", message: "role is owner, editor or contributor." }, 400);
  const krai = (body.krai ?? []).map((k) => k.toLowerCase());
  if (!krai.every(isKrai)) return c.json({ error: "bad_request", message: "krai is a list of 2–3 letter codes." }, 400);
  if (body.role === "editor" && krai.length === 0) return c.json({ error: "bad_request", message: "An editor needs at least one krai." }, 400);
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO editors (email, role, krai, created_at, created_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, krai = excluded.krai`,
    ).bind(email, body.role, krai.join(","), now, c.get("user").email),
    auditStatement(c.env, now, c.get("user").email, "editor:set", "editor", email, null, { role: body.role, krai }, null),
  ]);
  return c.json({ email, role: body.role, krai });
});

app.delete("/v1/admin/editors/:email", owner, async (c) => {
  const email = decodeURIComponent(c.req.param("email")!).toLowerCase();
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM editors WHERE email = ?").bind(email),
    auditStatement(c.env, now, c.get("user").email, "editor:removed", "editor", email, null, null, null),
  ]);
  return c.json({ status: "deleted" });
});

// ---- submissions: a zip (unpacked by the admin page) or any change sent for review -----------

interface SubmissionState {
  report: { issues: Issue[]; valid: boolean };
  missingImages: string[];
  changes: { action: string; kind: Kind; id: string }[];
}

function referencedImages(bundle: Bundle): Set<string> {
  const names = new Set<string>();
  for (const item of [...bundle.badges, ...bundle.probes, ...bundle.awards]) {
    if (item.images.color) names.add(item.images.color);
    if (item.images.bw) names.add(item.images.bw);
  }
  return names;
}

/** Checks a submission against the catalog as it is now, given the images already stored and
 * the ones uploaded with the submission. */
function assess(catalog: Bundle, bundle: Bundle, stored: Set<string>, uploaded: Set<string>): SubmissionState {
  const available = new Set([...stored, ...uploaded]);
  const missingImages = [...referencedImages(bundle)].filter((n) => !available.has(n));
  const report = validate(bundle, new Set([...available, ...missingImages]), catalog);
  const { changes } = merge(catalog, bundle);
  return { report, missingImages, changes: changes.map(({ action, kind, id }) => ({ action, kind, id })) };
}

app.post("/v1/submissions", async (c) => {
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_BUNDLE_BYTES) return c.json({ error: "too_large", message: "catalog.json is limited to 1.5 MB; split the submission." }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid", issues: [error("catalog.json", "Not valid JSON.")] }, 422);
  }
  const fieldIssues = checkFields(raw);
  if (fieldIssues.length) return c.json({ error: "invalid", issues: fieldIssues }, 422);

  const user = c.get("user");
  const bundle = normalizeBundle(raw);
  if (!bundle.source?.krai && user.role !== "owner" && user.krai.length === 1) bundle.source = { ...bundle.source, krai: user.krai[0] };

  const [catalog, images] = await Promise.all([loadCatalog(c.env), loadImages(c.env)]);
  const state = assess(catalog, bundle, new Set(images.keys()), new Set());
  if (!state.report.valid) return c.json({ error: "invalid", ...state }, 422);
  if (state.missingImages.length > MAX_SUBMISSION_IMAGES) return c.json({ error: "too_large", message: `At most ${MAX_SUBMISSION_IMAGES} images per submission.` }, 413);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO submissions (id, status, krai, bundle_json, images_json, created_at, created_by) VALUES (?, 'pending', ?, ?, '{}', ?, ?)").bind(
      id,
      bundle.source?.krai ?? null,
      JSON.stringify(bundle),
      now,
      user.email,
    ),
    auditStatement(c.env, now, user.email, "submission:created", null, null, null, { changes: state.changes.length }, id),
  ]);
  return c.json({ id, status: "pending", ...state }, 201);
});

async function loadOwnSubmission(c: Context<App>) {
  const row = await getSubmission(c.env, c.req.param("id")!);
  const user = c.get("user");
  if (!row || (row.created_by !== user.email && user.role === "contributor")) return null;
  return row;
}

app.get("/v1/submissions/:id", async (c) => {
  const row = await loadOwnSubmission(c);
  if (!row) return c.json({ error: "not_found" }, 404);
  const [catalog, images] = await Promise.all([loadCatalog(c.env), loadImages(c.env)]);
  const uploaded = JSON.parse(row.images_json) as Record<string, string>;
  const state = row.status === "pending" ? assess(catalog, JSON.parse(row.bundle_json) as Bundle, new Set(images.keys()), new Set(Object.keys(uploaded))) : null;
  return c.json({ id: row.id, status: row.status, krai: row.krai, createdAt: row.created_at, createdBy: row.created_by, reviewedAt: row.reviewed_at, reviewedBy: row.reviewed_by, note: row.note, uploadedImages: Object.keys(uploaded), ...state });
});

app.put("/v1/submissions/:id/images/:name", async (c) => {
  const row = await loadOwnSubmission(c);
  if (!row || row.status !== "pending") return c.json({ error: "not_found" }, 404);
  const name = c.req.param("name")!;
  const bytes = await readImageBody(c);
  if (bytes instanceof Response) return bytes;
  const issues = checkImage(name, bytes);
  if (issues.some((i) => i.severity === "error")) return c.json({ error: "invalid", issues }, 422);

  const uploaded = JSON.parse(row.images_json) as Record<string, string>;
  if (!(name in uploaded) && Object.keys(uploaded).length >= MAX_SUBMISSION_IMAGES) return c.json({ error: "too_large" }, 413);
  const sha256 = await sha256Hex(bytes);
  await c.env.IMAGES.put(`pending/${row.id}/${name}`, bytes, { httpMetadata: { contentType: imageType(name)! } });
  uploaded[name] = sha256;
  await c.env.DB.prepare("UPDATE submissions SET images_json = ? WHERE id = ?").bind(JSON.stringify(uploaded), row.id).run();
  return c.json({ name, sha256, issues });
});

app.get("/v1/admin/submissions", reviewer, async (c) => {
  const status = c.req.query("status") ?? "pending";
  const { results } = await c.env.DB.prepare("SELECT id, status, krai, created_at, created_by, reviewed_at, reviewed_by, note FROM submissions WHERE status = ? ORDER BY created_at DESC LIMIT 100").bind(status).all();
  return c.json(results);
});

app.post("/v1/admin/submissions/:id/approve", reviewer, async (c) => {
  const user = c.get("user");
  const row = await getSubmission(c.env, c.req.param("id")!);
  if (!row || row.status !== "pending") return c.json({ error: "not_found" }, 404);

  const bundle = JSON.parse(row.bundle_json) as Bundle;
  const uploaded = JSON.parse(row.images_json) as Record<string, string>;
  const [catalog, images] = await Promise.all([loadCatalog(c.env), loadImages(c.env)]);
  const state = assess(catalog, bundle, new Set(images.keys()), new Set(Object.keys(uploaded)));
  if (!state.report.valid || state.missingImages.length) return c.json({ error: "invalid", ...state }, 422);

  const { changes } = merge(catalog, bundle);
  const forbidden = forbiddenChanges(user, changes);
  const replaced = Object.entries(uploaded).filter(([name, sha]) => images.has(name) && images.get(name)!.sha256 !== sha);
  if (replaced.length && user.role !== "owner") forbidden.push(...replaced.map(([n]) => `images/${n}: an image with this name already exists; only owners replace images.`));
  if (forbidden.length) return c.json({ error: "forbidden", message: forbidden.join("\n") }, 403);

  // Images first: if the D1 batch fails after this, the copies are harmless extras.
  const imageRows: D1PreparedStatement[] = [];
  for (const [name, sha256] of Object.entries(uploaded)) {
    if (images.get(name)?.sha256 === sha256) continue;
    const object = await c.env.IMAGES.get(`pending/${row.id}/${name}`);
    if (!object) return c.json({ error: "missing_image", message: `images/${name} was not uploaded.` }, 409);
    const bytes = await object.arrayBuffer();
    await c.env.IMAGES.put(`images/${name}`, bytes, { httpMetadata: { contentType: imageType(name)! } });
    imageRows.push(imageStatement(c.env, { name, sha256, contentType: imageType(name)!, size: bytes.byteLength }, row.created_by));
  }

  const now = new Date().toISOString();
  await c.env.DB.batch([
    ...changeStatements(c.env, changes, user.email, "submission", row.id),
    ...imageRows,
    c.env.DB.prepare("UPDATE submissions SET status = 'applied', reviewed_at = ?, reviewed_by = ? WHERE id = ?").bind(now, user.email, row.id),
    auditStatement(c.env, now, user.email, "submission:applied", null, null, null, { changes: changes.length, images: imageRows.length }, row.id),
    bumpRevision(c.env),
  ]);
  c.executionCtx.waitUntil(deletePending(c.env, row.id, Object.keys(uploaded)));
  return c.json({ status: "applied", changes: changes.map(({ action, kind, id }) => ({ action, kind, id })), images: imageRows.length });
});

app.post("/v1/admin/submissions/:id/reject", reviewer, async (c) => {
  const row = await getSubmission(c.env, c.req.param("id")!);
  if (!row || row.status !== "pending") return c.json({ error: "not_found" }, 404);
  const { note } = (await c.req.json().catch(() => ({}))) as { note?: string };
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE submissions SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, note = ? WHERE id = ?").bind(now, c.get("user").email, note ?? null, row.id),
    auditStatement(c.env, now, c.get("user").email, "submission:rejected", null, null, null, { note }, row.id),
  ]);
  c.executionCtx.waitUntil(deletePending(c.env, row.id, Object.keys(JSON.parse(row.images_json))));
  return c.json({ status: "rejected" });
});

async function deletePending(env: Env, id: string, names: string[]) {
  if (names.length) await env.IMAGES.delete(names.map((n) => `pending/${id}/${n}`));
}

app.get("/", (c) => c.redirect("/admin/"));
app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal", message: "Something went wrong; the change was not saved." }, 500);
});

export { KINDS };
export default app;
