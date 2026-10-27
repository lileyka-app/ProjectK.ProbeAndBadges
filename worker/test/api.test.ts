import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { call, OWNER, svg } from "./helpers";

const UA_BUNDLE = {
  schemaVersion: 2,
  source: { krai: "ua" },
  categories: [{ id: "mystetska", title: "Мистецька" }],
  badges: [
    { id: "aktorstvo-i", family: "aktorstvo", level: 1, title: "Акторство I", ulady: ["upyu"], categories: ["mystetska"], images: { color: "aktorstvo-i.svg" }, requirements: [{ id: "1", text: "Прочитати п'єсу." }], notes: ["лише для редакторів"] },
  ],
  probes: [
    { id: "probe-1", title: "Перша проба", order: 1, sections: [{ id: "probe-1-a", code: "А", title: "Обов'язки", points: [{ id: "probe-1-a-1", text: "Знає Три Головні Обов'язки." }] }] },
  ],
};

async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Submit, upload images, approve: the path a zip takes through the admin page. */
async function importBundle(bundle: unknown, as: string, images: Record<string, Uint8Array>, approver = as) {
  const created = await call("/v1/submissions", { method: "POST", as, json: bundle });
  expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
  const { id, missingImages } = await json(created);
  expect(missingImages.sort()).toEqual(Object.keys(images).sort());
  for (const [name, bytes] of Object.entries(images)) {
    const res = await call(`/v1/submissions/${id}/images/${name}`, { method: "PUT", as, body: bytes });
    expect(res.status).toBe(200);
  }
  return { id, approve: () => call(`/v1/admin/submissions/${id}/approve`, { method: "POST", as: approver }) };
}

async function addEditor(email: string, role: string, krai: string[]) {
  const res = await call(`/v1/admin/editors/${encodeURIComponent(email)}`, { method: "PUT", as: OWNER, json: { role, krai } });
  expect(res.status).toBe(200);
}

describe("catalog service", () => {
  beforeEach(async () => {
    // Storage is shared between tests in a file; start each from an empty catalog.
    await env.DB.batch(["entries", "images", "editors", "submissions", "audit"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    const objects = await env.IMAGES.list();
    if (objects.objects.length) await env.IMAGES.delete(objects.objects.map((o) => o.key));
    const { approve } = await importBundle(UA_BUNDLE, OWNER, { "aktorstvo-i.svg": svg("A1") });
    expect((await approve()).status).toBe(200);
  });

  it("serves the imported catalog publicly, with image URLs and without editor notes", async () => {
    const res = await call("/v1/catalog");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("public");
    const body = await json(res);
    expect(body.revision).toBeGreaterThan(0);
    const badge = body.badges[0];
    expect(badge.krai).toBe("ua");
    expect(badge.notes).toBeUndefined();
    expect(badge.images.color).toMatch(/^https:\/\/catalog\.example\/v1\/images\/aktorstvo-i\.svg\?v=[0-9a-f]{12}$/);

    const image = await call(new URL(badge.images.color).pathname + new URL(badge.images.color).search);
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(image.headers.get("Cache-Control")).toContain("immutable");
    expect(image.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("answers 304 to a matching ETag", async () => {
    const first = await call("/v1/badges/aktorstvo-i");
    const again = await call("/v1/badges/aktorstvo-i", { headers: { "If-None-Match": first.headers.get("ETag")! } });
    expect(again.status).toBe(304);
  });

  it("keeps admin routes behind Access: no token, a forged token and an unknown email all get 401", async () => {
    expect((await call("/v1/admin/me")).status).toBe(401);
    expect((await call("/v1/admin/me", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } })).status).toBe(401);
    expect((await call("/v1/admin/me", { as: "stranger@example.com" })).status).toBe(401);
    expect(await json(await call("/v1/admin/me", { as: OWNER }))).toEqual({ email: OWNER, role: "owner", krai: [] });
  });

  // Overrides are stored, but a krai's view holds only its own items, so an override on another
  // krai's item does not reach the public API until the override design is revisited.
  it("stores a krai editor's overrides without changing the public catalog", async () => {
    await addEditor("praha@example.com", "editor", ["cz"]);
    const { approve } = await importBundle(
      {
        schemaVersion: 2,
        source: { krai: "cz" },
        overrides: [{ krai: "cz", target: "probe:probe-1", addPoints: [{ section: "А", id: "cz-probe-1-a-1", text: "Знає історію Пласту в Чехії." }] }],
      },
      "praha@example.com",
      {},
    );
    expect((await approve()).status).toBe(200);

    const stored = await json(await call("/v1/admin/catalog", { as: "praha@example.com" }));
    expect(stored.catalog.overrides.map((o: { target: string }) => o.target)).toEqual(["probe:probe-1"]);
    expect(await json(await call("/v1/probes?krai=cz"))).toEqual([]);
    const all = await json(await call("/v1/probes/probe-1"));
    expect(all.sections[0].points).toHaveLength(1);
  });

  it("does not let a krai editor change another krai's badge", async () => {
    await addEditor("praha@example.com", "editor", ["cz"]);
    const res = await call("/v1/admin/entries/badges/aktorstvo-i", {
      method: "PUT",
      as: "praha@example.com",
      json: { ...UA_BUNDLE.badges[0], krai: "ua", title: "Перейменовано" },
    });
    expect(res.status).toBe(403);
    expect((await json(await call("/v1/badges/aktorstvo-i"))).title).toBe("Акторство I");
  });

  it("queues a contributor's zip until an editor of that krai approves it", async () => {
    await addEditor("helper@example.com", "contributor", []);
    await addEditor("praha@example.com", "editor", ["cz"]);
    const bundle = {
      schemaVersion: 2,
      source: { krai: "cz" },
      badges: [{ id: "cz-hokej-i", title: "Хокей I", ulady: ["upyu"], categories: ["mystetska"], images: { color: "cz-hokej-i.svg" }, requirements: [{ id: "1", text: "Зіграє матч." }] }],
    };
    const { id } = await importBundle(bundle, "helper@example.com", { "cz-hokej-i.svg": svg("H") });

    expect((await call(`/v1/admin/submissions/${id}/approve`, { method: "POST", as: "helper@example.com" })).status).toBe(403);
    expect((await call("/v1/badges/cz-hokej-i")).status).toBe(404);

    const approved = await call(`/v1/admin/submissions/${id}/approve`, { method: "POST", as: "praha@example.com" });
    expect(approved.status).toBe(200);
    const badge = await json(await call("/v1/badges/cz-hokej-i"));
    expect(badge.krai).toBe("cz");
    expect((await call(new URL(badge.images.color).pathname)).status).toBe(200);
  });

  it("rejects an invalid submission with the issues listed", async () => {
    const res = await call("/v1/submissions", {
      method: "POST",
      as: OWNER,
      json: { schemaVersion: 2, badges: [{ id: "Bad Id", title: "", requirments: [] }] },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).issues[0].message).toContain("Unknown field 'requirments'");
  });

  it("refuses an SVG with a script", async () => {
    const res = await call("/v1/admin/images/evil.svg", { method: "PUT", as: OWNER, body: new TextEncoder().encode("<svg><script>alert(1)</script></svg>") });
    expect(res.status).toBe(422);
    expect(await env.IMAGES.get("images/evil.svg")).toBeNull();
  });

  it("retires a badge instead of deleting it, and logs who did it", async () => {
    expect((await call("/v1/admin/entries/badges/aktorstvo-i", { method: "DELETE", as: OWNER })).status).toBe(200);
    expect((await call("/v1/badges/aktorstvo-i")).status).toBe(404);
    const stored = await json(await call("/v1/admin/catalog", { as: OWNER }));
    expect(stored.catalog.badges[0].status).toBe("retired");
    const audit = await json(await call("/v1/admin/audit", { as: OWNER }));
    expect(audit[0]).toMatchObject({ actor: OWNER, action: "retire:updated", kind: "badge", entry_id: "aktorstvo-i" });
  });

  it("edits a single badge and bumps the public revision", async () => {
    const before = (await json(await call("/v1/catalog"))).revision;
    const res = await call("/v1/admin/entries/badges/aktorstvo-i", {
      method: "PUT",
      as: OWNER,
      json: { ...UA_BUNDLE.badges[0], krai: "ua", requirements: [{ id: "1", text: "Прочитати дві п'єси." }] },
    });
    expect(res.status).toBe(200);
    const after = await json(await call("/v1/catalog"));
    expect(after.revision).toBeGreaterThan(before);
    expect(after.badges[0].requirements[0].text).toBe("Прочитати дві п'єси.");
  });

  it("names an edition, serves it to its krai, and keeps it while probes belong to it", async () => {
    const edition = { id: "upyu-2026", title: "Оновлена проба (2026)", ulad: "upyu", krai: "ua" };
    const probe = { id: "probe-1-2026", title: "Перша проба", krai: "ua", edition: "upyu-2026", order: 1, status: "trial" };
    expect((await call("/v1/admin/entries/probes/probe-1-2026", { method: "PUT", as: OWNER, json: probe })).status).toBe(422);
    expect((await call("/v1/admin/entries/editions/upyu-2026", { method: "PUT", as: OWNER, json: edition })).status).toBe(200);
    expect((await call("/v1/admin/entries/probes/probe-1-2026", { method: "PUT", as: OWNER, json: probe })).status).toBe(200);

    expect((await json(await call("/v1/catalog?krai=ua"))).editions).toEqual([edition]);
    expect((await json(await call("/v1/catalog?krai=pl"))).editions).toEqual([]);
    expect(await json(await call("/v1/editions/upyu-2026"))).toEqual(edition);

    expect((await call("/v1/admin/entries/editions/upyu-2026", { method: "DELETE", as: OWNER })).status).toBe(409);
  });
});
