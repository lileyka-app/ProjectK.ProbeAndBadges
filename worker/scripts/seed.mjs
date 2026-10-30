// Loads catalog/ (the converted v2 catalog with its images) into D1 and R2 in one go.
//   node scripts/seed.mjs --local     # into `wrangler dev` storage
//   node scripts/seed.mjs --remote    # into the deployed D1 database and R2 bucket
// Meant for the first fill of an empty catalog: it goes straight to storage instead of through
// the API, because validating the whole catalog in one request would exceed the Free plan's
// CPU limit. Run `npm run db:migrate:<local|remote>` first. Existing rows with the same ids are
// overwritten; nothing else is touched.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv.includes("--remote") ? "--remote" : "--local";
const root = fileURLToPath(new URL("../../catalog/", import.meta.url));
// Wrangler's own entry point run with this Node: no npx, so it works the same on Windows.
const wranglerBin = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
const bucket = "projectk-catalog";
const actor = "seed";
const now = new Date().toISOString();
const types = { svg: "image/svg+xml", png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" };

const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

const lists = {
  category: catalog.categories,
  edition: catalog.editions ?? [],
  badge: catalog.badges,
  probe: catalog.probes,
  degree: catalog.degrees ?? [],
  award: catalog.awards,
  override: catalog.overrides ?? [],
};
const sql = [];
for (const [kind, items] of Object.entries(lists)) {
  for (const item of items ?? []) {
    const id = kind === "override" ? `${item.krai}|${item.target}` : item.id;
    const krai = kind === "category" ? null : (item.krai ?? null);
    sql.push(
      `INSERT INTO entries (kind, id, krai, json, updated_at, updated_by) VALUES (${q(kind)}, ${q(id)}, ${q(krai)}, ${q(JSON.stringify(item))}, ${q(now)}, ${q(actor)})
       ON CONFLICT (kind, id) DO UPDATE SET krai = excluded.krai, json = excluded.json, updated_at = excluded.updated_at, updated_by = excluded.updated_by;`,
    );
  }
}

const images = readdirSync(join(root, "images"));
for (const name of images) {
  const bytes = readFileSync(join(root, "images", name));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const type = types[name.split(".").pop().toLowerCase()];
  sql.push(
    `INSERT INTO images (name, sha256, content_type, size, uploaded_at, uploaded_by) VALUES (${q(name)}, ${q(sha)}, ${q(type)}, ${bytes.length}, ${q(now)}, ${q(actor)})
     ON CONFLICT (name) DO UPDATE SET sha256 = excluded.sha256, content_type = excluded.content_type, size = excluded.size, uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by;`,
  );
}
sql.push(`INSERT INTO audit (at, actor, action) VALUES (${q(now)}, ${q(actor)}, 'seed');`);
sql.push("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision';");

const file = join(mkdtempSync(join(tmpdir(), "catalog-seed-")), "seed.sql");
writeFileSync(file, sql.join("\n"));
const wrangler = (args) => execFileSync(process.execPath, [wranglerBin, ...args], { stdio: "inherit" });

console.log(`Uploading ${images.length} images to R2 (${target.slice(2)})…`);
if (target === "--local") {
  // Straight into the storage `wrangler dev` uses; one CLI process per file takes minutes here.
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy({ remoteBindings: false });
  for (const name of images) {
    const type = types[name.split(".").pop().toLowerCase()];
    await proxy.env.IMAGES.put(`images/${name}`, readFileSync(join(root, "images", name)), { httpMetadata: { contentType: type } });
  }
  await proxy.dispose();
} else {
  // Wrangler has no bulk upload: one process per file, eight at a time.
  const run = promisify(execFile);
  const queue = [...images];
  let done = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let name = queue.shift(); name; name = queue.shift()) {
        const type = types[name.split(".").pop().toLowerCase()];
        await run(process.execPath, [wranglerBin, "r2", "object", "put", `${bucket}/images/${name}`, "--file", join(root, "images", name), "--content-type", type, "--remote"]);
        if (++done % 25 === 0) console.log(`  ${done}/${images.length}`);
      }
    }),
  );
}

console.log(`Writing ${sql.length} rows to D1 (${target.slice(2)})…`);
wrangler(["d1", "execute", "catalog", target, "--file", file]);
console.log("Done.");
