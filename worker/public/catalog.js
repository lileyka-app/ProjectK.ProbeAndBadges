// Public read-only view of the catalog. It reads the same cached `GET /v1/catalog` that Lilejka
// does, so it needs no login and shows only what the API publishes (no retired entries, no
// editor notes). Links are shareable: `?krai=cz#badges/<id>`.

const ULADY = { upp: "УПП", upn: "УПН", upyu: "УПЮ", usp: "УСП", ups: "УПС" };
const GROUPS = {
  "upyu-vidznachennia": "Відзначення УПЮ",
  "usp-vidznachennia": "Відзначення УСП",
  "usp-pozaplastovi": "Відзначення УСП поза Пластом",
  "ups-vidznachennia": "Відзначення УПС",
  "ups-pozaplastovi": "Відзначення УПС поза Пластом",
  khresty: "Хрести",
  lsh: "Лісова Школа",
  shb: "Школа Булавних",
  "kv-upn": "Кадра Виховників УПН",
  "kv-upyu": "Кадра Виховників УПЮ",
  kv: "КВ",
  zb: "Золота Булава",
  kvdch: "КВДЧ",
};
const GENDER = { male: "для пластунів", female: "для пластунок" };
/** Degrees list the senior ulady first: the catalog has them for УСП and УПС, and the УПЮ ones they keep wearing. */
const LADDERS = ["usp", "ups", "upyu", "upn", "upp"];
const KRAI = { ua: "Україна", pl: "Польща", cz: "Чехія", de: "Німеччина", gb: "Велика Британія", us: "США", ca: "Канада", au: "Австралія", ar: "Аргентина" };
const LABEL = { badges: "вмілостей", probes: "проб", degrees: "ступенів", awards: "відзначень" };

const state = { catalog: null, kraiList: null, tab: "badges", krai: "" };
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const md = (text) =>
  esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
const kraiName = (k) => KRAI[k] ?? k;
const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many}`;
const fold = (s) => String(s ?? "").toLocaleLowerCase("uk");

async function load() {
  $("#error").hidden = true;
  const res = await fetch(`/v1/catalog${state.krai ? `?krai=${state.krai}` : ""}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.catalog = await res.json();
  if (!state.kraiList) {
    const all = state.krai ? await (await fetch("/v1/catalog")).json() : state.catalog;
    state.kraiList = [...new Set([...all.badges, ...all.probes, ...(all.degrees ?? []), ...all.awards].map((x) => x.krai).filter(Boolean))].sort();
  }
  const c = state.catalog;
  let summary = `${plural(c.badges.length, "вмілість", "вмілості", "вмілостей")} · ${plural(c.probes.length, "проба", "проби", "проб")} · ${plural(c.degrees.length, "ступінь", "ступені", "ступенів")} · ${plural(c.awards.length, "відзначення", "відзначення", "відзначень")}`;
  if (state.krai) summary += ` краю ${kraiName(state.krai)}`;
  $("#summary").textContent = summary;
  fillFilters();
  render();
  openFromHash();
}

function fillFilters() {
  const c = state.catalog;
  // Only krai that actually have entries; the list comes from the unfiltered catalog.
  const krai = new Set(state.kraiList);
  if (state.krai) krai.add(state.krai);
  $("#krai").innerHTML =
    `<option value="">усі краї</option>` +
    [...krai].map((k) => `<option value="${esc(k)}" ${k === state.krai ? "selected" : ""}>${esc(kraiName(k))}</option>`).join("");

  const keep = (sel, html) => {
    const v = $(sel).value;
    $(sel).innerHTML = html;
    $(sel).value = [...$(sel).options].some((o) => o.value === v) ? v : "";
  };
  keep("#filter-category", `<option value="">усі</option>` + c.categories.map((k) => `<option value="${esc(k.id)}">${esc(k.title)}</option>`).join(""));
  const ulady = new Set([...c.badges.flatMap((b) => b.ulady ?? []), ...c.probes.map((p) => p.ulad), ...c.degrees.flatMap((d) => [d.ulad, ...d.wornIn]), ...c.awards.map((a) => a.ulad)].filter(Boolean));
  keep("#filter-ulad", `<option value="">усі</option>` + Object.keys(ULADY).filter((u) => ulady.has(u)).map((u) => `<option value="${u}">${ULADY[u]}</option>`).join(""));
}

function visible() {
  const q = fold($("#search").value.trim());
  const category = $("#filter-category").value;
  const ulad = $("#filter-ulad").value;
  const status = $("#filter-status").value;
  const texts = (x) => [x.title, x.id, ...(x.requirements ?? []).map((r) => r.text), ...(x.points ?? []).map((p) => p.text), ...(x.sections ?? []).flatMap((s) => s.points.map((p) => p.text))];
  return state.catalog[state.tab]
    .filter(
      (x) =>
        (!q || texts(x).some((t) => fold(t).includes(q))) &&
        (state.tab !== "badges" || !category || x.categories?.includes(category)) &&
        (!ulad || (x.ulady ?? [x.ulad, ...(x.wornIn ?? [])]).includes(ulad)) &&
        (!status || x.status === status),
    )
    .sort((a, b) => (state.tab === "degrees" ? LADDERS.indexOf(a.ulad) - LADDERS.indexOf(b.ulad) : 0) || (a.order ?? 0) - (b.order ?? 0) || (a.group ?? "").localeCompare(b.group ?? "") || (a.level ?? 0) - (b.level ?? 0) || a.title.localeCompare(b.title, "uk"));
}

function subtitle(x) {
  if (state.tab === "probes") return ULADY[x.ulad] ?? x.ulad;
  if (state.tab === "awards") return GROUPS[x.group] ?? x.group;
  if (state.tab === "degrees") return [ULADY[x.ulad] ?? x.ulad, ...x.wornIn.map((u) => `носять і в ${ULADY[u] ?? u}`)].join(" · ");
  const cats = (x.categories ?? []).map((id) => state.catalog.categories.find((k) => k.id === id)?.title).filter(Boolean);
  return [cats.join(", "), x.krai && x.krai !== "ua" ? kraiName(x.krai) : "", x.status === "trial" ? "апробаційна" : ""].filter(Boolean).join(" · ");
}

function render() {
  $("#field-category").hidden = state.tab !== "badges";
  $("#field-status").hidden = state.tab !== "badges";
  const list = visible();
  $("#items").innerHTML = list
    .map(
      (x) => `<li><button data-id="${esc(x.id)}">
        ${x.images?.color ? `<img class="art" loading="lazy" alt="" src="${esc(x.images.color)}">` : `<span class="noimg"></span>`}
        <span><span class="t">${esc(x.title)}</span><span class="s">${esc(subtitle(x))}</span></span>
      </button></li>`,
    )
    .join("");
  $("#count").textContent = `${list.length} з ${state.catalog[state.tab].length} ${LABEL[state.tab]}`;
  $("#empty").hidden = list.length > 0;
  $("#items").hidden = list.length === 0;
}

function detailHtml(kind, x) {
  const own = (id) => state.krai && id.startsWith(`${state.krai}-`);
  const reqs = (list, numbered) =>
    `<ol class="reqs">${list
      .map((r, i) => `<li class="${own(r.id) ? "added" : ""}"><span class="n">${esc(numbered ? i + 1 : r.id)}.</span><span>${md(r.text)}</span></li>`)
      .join("")}</ol>`;
  const cats = (x.categories ?? []).map((id) => state.catalog.categories.find((k) => k.id === id)?.title ?? id);
  const tags = [
    x.krai ? `<span class="tag">${esc(kraiName(x.krai))}</span>` : "",
    x.status === "trial" ? `<span class="tag info">апробаційна</span>` : "",
    x.level ? `<span class="tag">рівень ${x.level}</span>` : "",
    ...(x.ulady ?? (x.ulad ? [x.ulad] : [])).map((u) => `<span class="tag">${ULADY[u] ?? esc(u)}</span>`),
    ...cats.map((c) => `<span class="tag">${esc(c)}</span>`),
    x.group ? `<span class="tag">${esc(GROUPS[x.group] ?? x.group)}</span>` : "",
    x.gender ? `<span class="tag">${GENDER[x.gender] ?? esc(x.gender)}</span>` : "",
    ...(x.wornIn ?? []).map((u) => `<span class="tag">носять і в ${ULADY[u] ?? esc(u)}</span>`),
  ].join("");

  let body = "";
  if (kind === "badges") {
    const prereqs = (x.prerequisites ?? []).map((id) => {
      const p = state.catalog.badges.find((b) => b.id === id);
      return p ? `<a href="#badges/${encodeURIComponent(id)}">${esc(p.title)}</a>` : esc(id);
    });
    body = `${prereqs.length ? `<div class="section-title">Спершу здобути</div><p>${prereqs.join(", ")}</p>` : ""}
      <div class="section-title">Вимоги</div>${reqs(x.requirements)}
      ${x.instructorRequirements ? `<div class="section-title">Інструктор</div><p>${md(x.instructorRequirements)}</p>` : ""}
      ${x.author || x.updatedOn ? `<p class="meta">${x.author ? `Розробив: ${esc(x.author)}. ` : ""}${x.updatedOn ? `Оновлено ${esc(x.updatedOn)}.` : ""}</p>` : ""}`;
  } else if (kind === "probes") {
    body = x.sections.map((s) => `<h3 class="sec">${esc(s.code)}. ${esc(s.title)}</h3>${reqs(s.points, true)}`).join("") + (x.points.length ? reqs(x.points, true) : "");
  } else {
    body = `${x.description ? `<p>${md(x.description)}</p>` : ""}${x.requirements?.length ? `<div class="section-title">Вимоги</div>${reqs(x.requirements)}` : ""}`;
  }
  const img = x.images?.color ?? x.images?.bw;
  return `<div class="head${img ? "" : " noimg"}">
      ${img ? `<div><img class="art" alt="" src="${esc(img)}"></div>` : ""}
      <div><h2 id="detail-title">${esc(x.title)}</h2><div class="tags">${tags}</div></div>
    </div>${body}
    <div class="modal-actions">${kind === "probes" || kind === "degrees" ? "" : `<a class="btn" href="${esc(posvidkaUrl(kind, x.id))}">Посвідка</a>`}<button class="btn btn-secondary close" type="button">Закрити</button></div>`;
}

function posvidkaUrl(kind, id) {
  const q = new URLSearchParams({ kind, id });
  if (state.krai) q.set("krai", state.krai);
  return `/posvidka?${q}`;
}

function openFromHash() {
  const [kind, id] = decodeURIComponent(location.hash.slice(1)).split("/");
  const dialog = $("#detail");
  const x = state.catalog?.[kind]?.find((i) => i.id === id);
  if (!x) {
    if (dialog.open) dialog.close();
    return;
  }
  if (kind !== state.tab) showTab(kind);
  $("#detail-body").innerHTML = detailHtml(kind, x);
  $("#detail-body").scrollTop = 0;
  if (!dialog.open) dialog.showModal();
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  render();
}

function setUrl(hash) {
  const url = new URL(location.href);
  if (state.krai) url.searchParams.set("krai", state.krai);
  else url.searchParams.delete("krai");
  url.hash = hash;
  history.pushState(null, "", url);
}

$("#tabs").addEventListener("click", (e) => e.target.dataset.tab && showTab(e.target.dataset.tab));
for (const sel of ["#search", "#filter-category", "#filter-ulad", "#filter-status"]) $(sel).addEventListener("input", render);
$("#items").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-id]");
  if (!button) return;
  setUrl(`${state.tab}/${encodeURIComponent(button.dataset.id)}`);
  openFromHash();
});
$("#detail").addEventListener("click", (e) => {
  if (e.target === $("#detail") || e.target.closest(".close")) $("#detail").close();
});
$("#detail").addEventListener("close", () => location.hash && setUrl(""));
$("#krai").addEventListener("change", (e) => {
  state.krai = e.target.value;
  setUrl(location.hash.slice(1));
  load().catch(fail);
});
window.addEventListener("hashchange", openFromHash);
window.addEventListener("popstate", openFromHash);

function fail(e) {
  $("#summary").textContent = "";
  $("#error-body").textContent = `Каталог не завантажився (${e.message}). Спробуй за хвилину.`;
  $("#error").hidden = false;
}

$("#reset").addEventListener("click", () => {
  for (const sel of ["#search", "#filter-category", "#filter-ulad", "#filter-status"]) $(sel).value = "";
  render();
});

state.krai = new URLSearchParams(location.search).get("krai")?.toLowerCase().replace(/[^a-z]/g, "").slice(0, 3) ?? "";
load().catch(fail);
