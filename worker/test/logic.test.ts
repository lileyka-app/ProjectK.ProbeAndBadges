import { describe, expect, it } from "vitest";
import committed from "../../catalog/catalog.json";
import { normalizeBundle, type Bundle } from "../src/model";
import { merge, resolve } from "../src/resolve";
import { checkFields, checkImage, validate } from "../src/validate";

const base = (): Bundle =>
  normalizeBundle({
    categories: [{ id: "mystetska", title: "Мистецька" }],
    badges: [
      { id: "aktorstvo-i", title: "Акторство I", krai: "ua", ulady: ["upyu"], categories: ["mystetska"], images: { color: "a1.svg" }, requirements: [{ id: "1", text: "Прочитати п'єсу." }] },
      { id: "staryi", title: "Стара", krai: "ua", ulady: ["upyu"], categories: ["mystetska"], status: "retired", images: { color: "a1.svg" }, requirements: [{ id: "1", text: "x" }] },
    ],
    probes: [
      { id: "probe-1", title: "Перша проба", krai: "ua", sections: [{ id: "probe-1-a", code: "А", title: "А", points: [{ id: "probe-1-a-1", text: "Знає" }] }] },
    ],
  });

describe("committed catalog", () => {
  it("passes the same checks the .NET validator runs", () => {
    expect(checkFields(committed)).toEqual([]);
    const bundle = normalizeBundle(committed);
    const images = new Set(
      [...bundle.badges, ...bundle.probes, ...bundle.awards].flatMap((x) => [x.images.color, x.images.bw]).filter((n): n is string => !!n),
    );
    const report = validate(bundle, images);
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(bundle.badges.length).toBeGreaterThan(300);
  });
});

describe("validate", () => {
  it("rejects unknown fields so template typos surface", () => {
    expect(checkFields({ schemaVersion: 2, badges: [{ id: "x", requirments: [] }] })).toEqual([
      expect.objectContaining({ path: "badges[0].requirments" }),
    ]);
  });

  it("accepts a krai contribution that overrides base items with prefixed ids", () => {
    const contribution = normalizeBundle({
      source: { krai: "cz" },
      overrides: [{ krai: "cz", target: "probe:probe-1", addPoints: [{ section: "А", id: "cz-probe-1-a-1", text: "Знає історію Пласту в Чехії" }] }],
    });
    expect(validate(contribution, new Set(), base()).valid).toBe(true);
  });

  it("rejects foreign krai, unprefixed ids and unknown sections", () => {
    const contribution = normalizeBundle({
      source: { krai: "cz" },
      overrides: [{ krai: "pl", target: "probe:probe-1", addPoints: [{ section: "Я", id: "point-x", text: "x" }] }],
    });
    const messages = validate(contribution, new Set(), base()).issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("may only carry its own overrides"),
        expect.stringContaining("must start with 'pl-'"),
        expect.stringContaining("no section 'Я'"),
      ]),
    );
  });

  it("does not let a krai take over another krai's badge", () => {
    const contribution = normalizeBundle({ source: { krai: "cz" }, badges: [{ ...base().badges[0], krai: null }] });
    expect(validate(contribution, new Set(["a1.svg"]), base()).issues.map((i) => i.message)).toContainEqual(expect.stringContaining("already belongs to krai 'ua'"));
  });

  it("lets a new edition stand beside the old one at the same places", () => {
    const contribution = normalizeBundle({
      editions: [{ id: "upyu-2026", title: "Оновлена проба (2026)", ulad: "upyu", krai: "ua" }],
      probes: [
        { id: "znak-2026", title: "Знак прихильника", krai: "ua", edition: "upyu-2026", order: 0, status: "trial" },
        { id: "probe-1-2026", title: "Перша проба", krai: "ua", edition: "upyu-2026", order: 1, status: "trial", points: [{ id: "probe-1-2026-1", text: "Знає закон", level: "knows", competencies: ["hromadianska"] }] },
      ],
    });
    expect(checkFields({ schemaVersion: 2, editions: contribution.editions, probes: contribution.probes })).toEqual([]);
    expect(validate(contribution, new Set(), base()).issues).toEqual([]);
  });

  it("wants every edition a probe names to exist, for the probe's own ulad and krai", () => {
    const editions = [
      { id: "upyu-2026", title: "Оновлена проба (2026)", ulad: "upyu", krai: "ua" },
      { id: "usp-2026", title: "Нова", ulad: "usp", krai: "ua" },
    ];
    const probe = (edition: string, krai = "ua") => ({ id: `p-${edition}-${krai}`, title: "x", krai, edition, order: 1 });
    const contribution = normalizeBundle({ editions, probes: [probe("nemaie"), probe("usp-2026"), probe("upyu-2026", "cz")] });
    const messages = validate(contribution, new Set(), base()).issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Unknown edition 'nemaie'"),
        expect.stringContaining("is for usp, the probe for upyu"),
        expect.stringContaining("belongs to krai 'ua', the probe to 'cz'"),
      ]),
    );
  });

  it("renames an edition on its own, but will not move it away from its stored probes", () => {
    const stored = normalizeBundle({
      ...base(),
      editions: [{ id: "upyu-2026", title: "Нова програма", ulad: "upyu", krai: "ua" }],
      probes: [...base().probes, { id: "probe-1-2026", title: "Перша", krai: "ua", edition: "upyu-2026", order: 1 }],
    });
    const renamed = normalizeBundle({ editions: [{ id: "upyu-2026", title: "Оновлена проба (2026)", ulad: "upyu", krai: "ua" }] });
    expect(validate(renamed, new Set(), stored).valid).toBe(true);
    const moved = normalizeBundle({ editions: [{ id: "upyu-2026", title: "Оновлена проба (2026)", ulad: "usp", krai: "ua" }] });
    expect(validate(moved, new Set(), stored).issues.map((i) => i.message)).toContainEqual(expect.stringContaining("Probe probe-1-2026 (upyu, ua) belongs to this edition"));
  });

  it("refuses two live probes at one place of one edition", () => {
    const contribution = normalizeBundle({ probes: [{ id: "probe-1-copy", title: "Ще одна", krai: "ua" }] });
    expect(validate(contribution, new Set(), base()).issues.map((i) => i.message)).toContainEqual(expect.stringContaining("Probe probe-1 already stands at 0"));
    const retired = normalizeBundle({ probes: [{ id: "probe-1-copy", title: "Ще одна", krai: "ua", status: "retired" }] });
    expect(validate(retired, new Set(), base()).valid).toBe(true);
  });

  it("checks a point's level and competencies", () => {
    const contribution = normalizeBundle({
      probes: [{ id: "probe-x", title: "x", krai: "ua", edition: "Upyu 2026", order: 5, points: [{ id: "probe-x-1", text: "x", level: "masters" as never, competencies: ["a", "a"] }] }],
    });
    const paths = validate(contribution, new Set(), base()).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["probes[0].edition", "probes[0].points[0].level", "probes[0].points[0].competencies"]));
  });

  it.each(["<svg><script>alert(1)</script></svg>", '<svg><rect onload="x()"/></svg>', '<svg><image href="https://evil.example/x.png"/></svg>'])("rejects active SVG %s", (s) => {
    expect(checkImage("x.svg", new TextEncoder().encode(s)).some((i) => i.severity === "error")).toBe(true);
  });

  it("rejects a .png that is not a PNG", () => {
    expect(checkImage("x.png", new TextEncoder().encode("<svg/>")).some((i) => i.severity === "error")).toBe(true);
  });
});

describe("resolve", () => {
  const withOverrides = (): Bundle => ({
    ...base(),
    overrides: normalizeBundle({
      overrides: [
        { krai: "ua", target: "badge:aktorstvo-i", addRequirements: [{ id: "ua-1", text: "Виступить у Києві." }], removeRequirements: ["1"] },
        { krai: "ua", target: "probe:probe-1", addPoints: [{ section: "А", id: "ua-probe-1-a-1", text: "Україна" }] },
        { krai: "cz", target: "badge:aktorstvo-i", title: "Чужа назва" },
        { krai: "pl", target: "badge:aktorstvo-i", hidden: true },
      ],
    }).overrides,
  });

  it("applies only the reader's krai overrides and drops retired items", () => {
    const ua = resolve(withOverrides(), "ua");
    expect(ua.badges.map((b) => b.id)).toEqual(["aktorstvo-i"]);
    expect(ua.badges[0].title).toBe("Акторство I");
    expect(ua.badges[0].requirements).toEqual([{ id: "ua-1", text: "Виступить у Києві." }]);
    expect(ua.probes[0].sections[0].points.map((p) => p.id)).toEqual(["probe-1-a-1", "ua-probe-1-a-1"]);
    expect(ua.overrides).toEqual([]);

    expect(resolve(withOverrides(), "pl").badges).toEqual([]);
    expect(resolve(withOverrides(), null).badges[0].requirements[0].id).toBe("1");
  });

  it("gives a krai only its own items", () => {
    const catalog: Bundle = {
      ...base(),
      badges: [
        ...base().badges,
        { ...base().badges[0], id: "pl-vlasna", krai: "pl" },
        { ...base().badges[0], id: "cz-vlasna", krai: "cz" },
      ],
    };
    const ids = (krai: string | null) => resolve(catalog, krai).badges.map((b) => b.id);
    expect(ids("cz")).toEqual(["cz-vlasna"]);
    expect(ids("ua")).toEqual(["aktorstvo-i"]);
    expect(ids("de")).toEqual([]);
    expect(ids(null)).toEqual(["aktorstvo-i", "pl-vlasna", "cz-vlasna"]);
  });

  it("merges a contribution by id and gives new items the contribution's krai", () => {
    const contribution = normalizeBundle({
      source: { krai: "cz" },
      badges: [{ id: "cz-nova", title: "Нова", ulady: ["upyu"], categories: ["mystetska"], images: { color: "a1.svg" }, requirements: [{ id: "1", text: "x" }] }],
    });
    const { catalog, changes } = merge(base(), contribution);
    expect(changes.map((c) => `${c.action} ${c.kind}:${c.id}`)).toEqual(["added badge:cz-nova"]);
    expect(catalog.badges.find((b) => b.id === "cz-nova")?.krai).toBe("cz");
    expect(merge(catalog, contribution).changes.filter((c) => c.kind === "badge")).toEqual([]);
  });
});
