// Admin page for the catalog. Plain modules, no build step: the Worker serves this folder as
// static assets, Cloudflare Access signs the user in before it loads, and every call below goes
// to the same origin with that session.

const KINDS = {
  badge: { plural: "badges", list: "badges", label: "Вмілість" },
  probe: { plural: "probes", list: "probes", label: "Проба" },
  edition: { plural: "editions", list: "editions", label: "Редакція проб" },
  degree: { plural: "degrees", list: "degrees", label: "Ступінь" },
  award: { plural: "awards", list: "awards", label: "Відзначення" },
};
const GENDER = { male: "чоловіча форма", female: "жіноча форма" };
const ULADY = { upp: "УПП", upn: "УПН", upyu: "УПЮ", usp: "УСП", ups: "УПС" };
const STATUS = { approved: "затверджена", trial: "апробаційна", retired: "виведена" };
const POINT_LEVEL = { knows: "знає", can: "вміє", practises: "практикує" };

const state = {
  me: null,
  catalog: null,
  images: new Map(),
  tab: "badge",
  selected: null,
  previewKrai: "",
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Requirement texts are markdown from the old parser: bold, italics, line breaks, "- " lists. */
function md(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
}

async function api(path, { method = "GET", json, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: "same-origin" };
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw Object.assign(new Error(data?.message ?? data?.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

const imageSrc = (name) => (name ? `/v1/images/${encodeURIComponent(name)}?v=${state.images.get(name)?.sha256.slice(0, 12) ?? ""}` : "");
const items = (kind) => state.catalog[KINDS[kind].list];
const findItem = (kind, id) => items(kind).find((x) => x.id === id);
/** The name people see for a probe's edition; probes without one are the звичайна проба. */
const editionTitle = (id) => (id ? (findItem("edition", id)?.title ?? id) : "звичайна проба");
const canEdit = (krai) => state.me.role === "owner" || (state.me.role === "editor" && state.me.krai.includes(krai));

// ---- boot ------------------------------------------------------------------------------------

async function boot() {
  try {
    state.me = await api("/v1/admin/me");
  } catch (e) {
    $("#detail").innerHTML = `<div class="card"><h2>Немає доступу</h2><p>Ви увійшли, але ця адреса не має доступу до каталогу. Попросіть власника каталогу додати вас у «Редактори».</p></div>`;
    return;
  }
  $("#me").textContent = `${state.me.email} · ${{ owner: "власник", editor: `редактор ${state.me.krai.join(", ")}`, contributor: "дописувач" }[state.me.role]}`;
  if (state.me.role !== "owner") document.querySelectorAll("[data-owner]").forEach((b) => b.remove());
  if (state.me.role === "editor" && state.me.krai.length) state.previewKrai = state.me.krai[0];

  await reload();
  wire();
  showTab("badge");
}

async function reload() {
  const data = await api("/v1/admin/catalog");
  state.catalog = data.catalog;
  state.images = new Map(data.images.map((i) => [i.name, i]));

  const krai = new Set([...state.me.krai]);
  for (const kind of Object.keys(KINDS)) for (const x of items(kind)) if (x.krai) krai.add(x.krai);
  for (const o of state.catalog.overrides) krai.add(o.krai);
  const options = [...krai].sort().map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join("");
  $("#preview-krai").innerHTML = `<option value="">усі (без доповнень)</option>${options}`;
  $("#preview-krai").value = state.previewKrai;
  $("#filter-krai").innerHTML = `<option value="">усі краї</option>${options}`;
}

function wire() {
  $("#tabs").addEventListener("click", (e) => e.target.dataset.tab && showTab(e.target.dataset.tab));
  $("#search").addEventListener("input", renderList);
  $("#filter-krai").addEventListener("change", renderList);
  $("#filter-status").addEventListener("change", renderList);
  $("#preview-krai").addEventListener("change", (e) => {
    state.previewKrai = e.target.value;
    if (state.selected) renderDetail();
  });
  $("#new-item").addEventListener("click", () => {
    state.selected = { kind: state.tab, id: null };
    renderDetail("edit");
  });
  $("#zip").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) importZip(file);
  });
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const catalogTab = tab in KINDS;
  $("#catalog-view").hidden = !catalogTab;
  for (const v of ["submissions", "editors", "audit"]) $(`#${v}-view`).hidden = tab !== v;
  if (catalogTab) {
    $("#new-item").hidden = state.me.role === "contributor";
    state.selected = null;
    $("#detail").innerHTML = `<p class="muted empty">Оберіть запис зліва, створіть новий або завантажте zip з <code>catalog.json</code> і текою <code>images/</code>.</p>`;
    renderList();
  } else if (tab === "submissions") renderSubmissions();
  else if (tab === "editors") renderEditors();
  else if (tab === "audit") renderAudit();
}

// ---- list ------------------------------------------------------------------------------------

function renderList() {
  const q = $("#search").value.trim().toLocaleLowerCase("uk");
  const krai = $("#filter-krai").value;
  const status = $("#filter-status").value;
  const list = items(state.tab).filter(
    (x) =>
      (!q || x.title.toLocaleLowerCase("uk").includes(q) || x.id.includes(q)) &&
      (!krai || x.krai === krai) &&
      (!status || x.status === status),
  );
  $("#items").innerHTML = list
    .map(
      (x) => `<li data-id="${esc(x.id)}" class="${state.selected?.id === x.id ? "active" : ""}">
        ${x.images?.color ? `<img class="art" loading="lazy" alt="" src="${imageSrc(x.images.color)}">` : `<span style="width:32px"></span>`}
        <div><div class="t">${esc(x.title)}</div><div class="s">${esc(x.id)} · ${esc(x.krai ?? "—")}${x.status && x.status !== "approved" ? ` · ${STATUS[x.status]}` : ""}</div></div>
      </li>`,
    )
    .join("");
  $("#count").textContent = `${list.length} з ${items(state.tab).length}`;
  $("#items").onclick = (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    state.selected = { kind: state.tab, id: li.dataset.id };
    document.querySelectorAll("#items li").forEach((x) => x.classList.toggle("active", x === li));
    renderDetail();
  };
}

// ---- detail ----------------------------------------------------------------------------------

async function renderDetail(view = "preview") {
  const { kind, id } = state.selected;
  const raw = id ? findItem(kind, id) : null;
  const editable = raw ? canEdit(raw.krai) : state.me.role !== "contributor";
  const krai = state.previewKrai;
  const overrideKey = raw && krai ? `${krai}|${kind}:${raw.id}` : null;
  const override = overrideKey ? state.catalog.overrides.find((o) => `${o.krai}|${o.target}` === overrideKey) : null;

  const tabs = [
    ["preview", "Прев'ю"],
    ["api", "JSON з API"],
    ...(editable || !raw ? [["edit", raw ? "Редагувати" : "Створити"]] : []),
    ...(raw && krai && canEdit(krai) ? [["override", `Доповнення краю ${krai}${override ? " ●" : ""}`]] : []),
  ];
  if (!raw) view = "edit";

  $("#detail").innerHTML = `
    <div class="subtabs">${tabs.map(([k, l]) => `<button data-view="${k}" class="${k === view ? "active" : ""}">${esc(l)}</button>`).join("")}</div>
    <div id="view"></div>`;
  $("#detail .subtabs").onclick = (e) => e.target.dataset.view && renderDetail(e.target.dataset.view);

  const target = $("#view");
  if (view === "preview" || view === "api") {
    target.innerHTML = `<p class="muted">Завантажую…</p>`;
    let published = null;
    try {
      published = await api(`/v1/${KINDS[kind].plural}/${encodeURIComponent(id)}${krai ? `?krai=${krai}` : ""}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    if (view === "api") {
      target.innerHTML = published
        ? `<p class="muted">Рівно те, що отримує Лілейка з <code>GET /v1/${KINDS[kind].plural}/${esc(id)}${krai ? `?krai=${esc(krai)}` : ""}</code>.</p><pre class="json">${esc(JSON.stringify(published, null, 2))}</pre>`
        : `<p class="muted">API цього запису не віддає: він виведений або не належить краю ${esc(krai)}.</p>`;
    } else {
      target.innerHTML = previewHtml(kind, published ?? raw, !published);
      target.querySelectorAll("[data-goto]").forEach((a) =>
        a.addEventListener("click", (e) => {
          e.preventDefault();
          state.selected = { kind: "badge", id: a.dataset.goto };
          renderDetail();
        }),
      );
    }
  } else if (view === "edit") {
    renderEdit(target, kind, raw);
  } else if (view === "override") {
    renderOverride(target, kind, raw, krai, override);
  }
}

function previewHtml(kind, x, unpublished) {
  const img = (url) => (url ? (url.startsWith("http") || url.startsWith("/") ? url : imageSrc(url)) : "");
  const color = img(x.images?.color);
  const bw = img(x.images?.bw);
  const cats = (x.categories ?? []).map((c) => state.catalog.categories.find((k) => k.id === c)?.title ?? c);
  const prereqs = (x.prerequisites ?? []).map((p) => `<a href="#" data-goto="${esc(p)}">${esc(findItem("badge", p)?.title ?? p)}</a>`);
  // Requirement ids are short ("1", "cz-1") and shown; probe point ids are long, so points are
  // numbered in order and the id sits in the tooltip.
  const reqs = (list, numbered = false) =>
    `<ol class="reqs">${list
      .map((r, i) => {
        const level = r.level ? ` <span class="tag">${esc(POINT_LEVEL[r.level] ?? r.level)}</span>` : "";
        const competencies = (r.competencies ?? []).map((c) => ` <span class="tag">${esc(c)}</span>`).join("");
        return `<li class="${state.previewKrai && r.id.startsWith(`${state.previewKrai}-`) ? "added" : ""}" title="${esc(r.id)}"><span class="n">${esc(numbered ? String(i + 1) : r.id)}.</span><span>${md(r.text)}${level}${competencies}</span></li>`;
      })
      .join("")}</ol>`;
  const tags = [
    x.krai ? `<span class="tag ${x.krai === state.previewKrai ? "krai-own" : ""}">край: ${esc(x.krai)}</span>` : "",
    x.status ? `<span class="tag ${x.status}">${STATUS[x.status]}</span>` : "",
    kind === "probe" ? `<span class="tag">редакція: ${esc(editionTitle(x.edition))} · №${esc(String(x.order))}</span>` : "",
    x.level ? `<span class="tag">рівень ${x.level}</span>` : "",
    kind === "degree" ? `<span class="tag">щабель ${esc(String(x.order))}</span>` : "",
    x.gender ? `<span class="tag">${GENDER[x.gender] ?? esc(x.gender)}</span>` : "",
    ...(x.wornIn ?? []).map((u) => `<span class="tag">носять і в ${ULADY[u] ?? esc(u)}</span>`),
    ...(x.ulady ?? (x.ulad ? [x.ulad] : [])).map((u) => `<span class="tag">${ULADY[u] ?? u}</span>`),
    ...cats.map((c) => `<span class="tag">${esc(c)}</span>`),
    x.group ? `<span class="tag">${esc(x.group)}</span>` : "",
  ].join("");

  let body = "";
  if (kind === "badge") {
    body = `${prereqs.length ? `<div class="section-title">Спершу здобути</div><p>${prereqs.join(", ")}</p>` : ""}
      <div class="section-title">Вимоги</div>${reqs(x.requirements)}
      ${x.instructorRequirements ? `<div class="section-title">Інструктор</div><p>${md(x.instructorRequirements)}</p>` : ""}
      <p class="muted">${x.author ? `Розробив: ${esc(x.author)}. ` : ""}${x.updatedOn ? `Оновлено ${esc(x.updatedOn)}.` : ""}</p>`;
  } else if (kind === "edition") {
    const probes = state.catalog.probes.filter((p) => p.edition === x.id).sort((a, b) => a.order - b.order);
    body = `<div class="section-title">Проби редакції</div>${
      probes.length
        ? `<ol class="reqs">${probes.map((p) => `<li><span class="n">№${esc(String(p.order))}</span><span>${esc(p.title)} <code>${esc(p.id)}</code>${p.status !== "approved" ? ` <span class="tag ${p.status}">${STATUS[p.status]}</span>` : ""}</span></li>`).join("")}</ol>`
        : `<p class="muted">Ще жодна проба не має <code>edition: "${esc(x.id)}"</code>.</p>`
    }<p class="muted">Назву редакції Лілейка показує людям як є, напр. у виборі проби гуртка.</p>`;
  } else if (kind === "probe") {
    body = x.sections.map((s) => `<div class="section-title">${esc(s.code)}. ${esc(s.title)}</div>${reqs(s.points, true)}`).join("") + (x.points.length ? reqs(x.points, true) : "");
  } else {
    body = `${x.description ? `<p>${md(x.description)}</p>` : ""}${x.requirements?.length ? `<div class="section-title">Вимоги</div>${reqs(x.requirements)}` : ""}`;
  }

  return `<div class="card">
    ${unpublished ? `<p class="muted">Цей запис API зараз не віддає; нижче він так, як збережений.</p>` : ""}
    <div class="preview">
      <div>${color ? `<img class="art" alt="" src="${color}">` : ""}${bw ? `<img class="art" alt="" src="${bw}" title="ч/б">` : ""}</div>
      <div><h2>${esc(x.title)}</h2><div class="muted"><code>${esc(x.id)}</code></div><div class="tags">${tags}</div></div>
    </div>
    ${body}
  </div>`;
}

// ---- editing ---------------------------------------------------------------------------------

function template(kind) {
  const krai = state.me.krai[0] ?? "ua";
  if (kind === "badge") return { id: "", title: "", family: null, level: 1, categories: [], ulady: ["upyu"], krai, status: "trial", images: { color: null, bw: null }, prerequisites: [], requirements: [{ id: "1", text: "" }], instructorRequirements: null, author: null, updatedOn: new Date().toISOString().slice(0, 10), notes: [] };
  if (kind === "edition") return { id: "", title: "", ulad: "upyu", krai };
  if (kind === "degree") return { id: "", family: null, title: "", ulad: "usp", krai, gender: null, order: 0, wornIn: [], status: "trial", images: { color: null, bw: null }, description: null, requirements: [] };
  if (kind === "probe") return { id: "", title: "", ulad: "upyu", krai, edition: null, order: items("probe").length + 1, status: "trial", images: { color: null, bw: null }, sections: [], points: [] };
  return { id: "", group: "upyu-vidznachennia", title: "", ulad: "upyu", krai, level: null, status: "trial", images: { color: null, bw: null }, description: null, requirements: [] };
}

function renderEdit(target, kind, raw) {
  const item = structuredClone(raw ?? template(kind));
  const isBadge = kind === "badge";

  target.innerHTML = `<div class="form card">
    ${isBadge ? badgeFormHtml(item, !raw) : `<p class="muted">Редагування як JSON. Поля описані в <a href="/docs#format" target="_blank">документації</a>.</p>`}
    <details ${isBadge ? "" : "open"}><summary>JSON запису</summary><textarea class="json" id="raw-json" rows="18"></textarea></details>
    <div class="row">
      <button id="save">${raw ? "Зберегти" : "Створити"}</button>
      ${raw && raw.status !== "retired" ? `<button id="retire" class="danger">${kind === "edition" ? "Видалити" : "Вивести з ужитку"}</button>` : ""}
      <span class="muted" id="save-note"></span>
    </div>
    <div id="issues"></div>
  </div>`;

  const json = $("#raw-json", target);
  json.value = JSON.stringify(item, null, 2);

  if (isBadge) wireBadgeForm(target, item, json);

  $("#save", target).onclick = async () => {
    let entry;
    try {
      entry = JSON.parse(json.value);
    } catch {
      return showIssues(target, [{ severity: "error", path: "JSON", message: "JSON не розбирається." }]);
    }
    try {
      const res = await api(`/v1/admin/entries/${KINDS[kind].plural}/${encodeURIComponent(entry.id)}`, { method: "PUT", json: entry });
      showIssues(target, res.issues ?? [], res.status === "unchanged" ? "Змін немає." : "Збережено.");
      await reload();
      state.selected = { kind, id: entry.id };
      renderList();
    } catch (e) {
      showIssues(target, e.data?.issues ?? [{ severity: "error", path: "", message: e.message }]);
    }
  };
  const retire = $("#retire", target);
  if (retire)
    retire.onclick = async () => {
      const question =
        kind === "edition"
          ? `Видалити редакцію «${raw.title}»? Це можна, лише поки до неї не належить жодна проба.`
          : `Вивести «${raw.title}»? Запис зникне з API, але поступ людей на ньому збережеться.`;
      if (!confirm(question)) return;
      try {
        await api(`/v1/admin/entries/${KINDS[kind].plural}/${encodeURIComponent(raw.id)}`, { method: "DELETE" });
        await reload();
        renderList();
        renderDetail();
      } catch (e) {
        showIssues(target, [{ severity: "error", path: "", message: e.message }]);
      }
    };
}

function badgeFormHtml(b, isNew) {
  const imageOptions = [...state.images.keys()].sort().map((n) => `<option value="${esc(n)}">`).join("");
  return `
    <div class="grid">
      <label>id ${isNew ? "" : "(не змінюється)"}<input name="id" value="${esc(b.id)}" ${isNew ? "" : "readonly"} placeholder="aktorstvo-i"></label>
      <label>Назва<input name="title" value="${esc(b.title)}"></label>
      <label>Родина рівнів<input name="family" value="${esc(b.family ?? "")}" placeholder="aktorstvo"></label>
      <label>Рівень<input name="level" type="number" min="1" max="5" value="${b.level ?? ""}"></label>
      <label>Край<input name="krai" value="${esc(b.krai ?? "")}" maxlength="3"></label>
      <label>Статус<select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${b.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    </div>
    <div><div class="muted">Улади</div><div class="checks">${Object.entries(ULADY).map(([k, v]) => `<label><input type="checkbox" name="ulady" value="${k}" ${b.ulady.includes(k) ? "checked" : ""}>${v}</label>`).join("")}</div></div>
    <div><div class="muted">Категорії</div><div class="checks">${state.catalog.categories.map((c) => `<label><input type="checkbox" name="categories" value="${esc(c.id)}" ${b.categories.includes(c.id) ? "checked" : ""}>${esc(c.title)}</label>`).join("")}</div></div>
    <div class="grid">
      <label>Зображення (кольорове)<input name="image-color" list="image-names" value="${esc(b.images.color ?? "")}"></label>
      <label>Зображення (ч/б)<input name="image-bw" list="image-names" value="${esc(b.images.bw ?? "")}"></label>
      <label>Завантажити нове<input type="file" id="image-upload" accept=".svg,.png,.webp,.jpg"></label>
    </div>
    <datalist id="image-names">${imageOptions}</datalist>
    <label>Передумови (id вмілостей через кому)<input name="prerequisites" value="${esc(b.prerequisites.join(", "))}"></label>
    <div><div class="muted">Вимоги</div><div id="reqs" class="form"></div><button type="button" class="secondary" id="add-req">+ Пункт</button></div>
    <label>Вимоги до інструктора<textarea name="instructorRequirements" rows="2">${esc(b.instructorRequirements ?? "")}</textarea></label>
    <div class="grid">
      <label>Автор<input name="author" value="${esc(b.author ?? "")}"></label>
      <label>Оновлено<input name="updatedOn" type="date" value="${esc(b.updatedOn ?? "")}"></label>
    </div>
    <label>Нотатки для редакторів (по рядку)<textarea name="notes" rows="2">${esc(b.notes.join("\n"))}</textarea></label>`;
}

function wireBadgeForm(root, b, json) {
  const reqs = $("#reqs", root);
  const drawReqs = () => {
    reqs.innerHTML = b.requirements
      .map((r, i) => `<div class="req-edit"><input data-i="${i}" data-f="id" value="${esc(r.id)}"><textarea data-i="${i}" data-f="text" rows="2">${esc(r.text)}</textarea><button type="button" class="secondary" data-del="${i}">✕</button></div>`)
      .join("");
  };
  drawReqs();

  const sync = () => {
    const f = (n) => root.querySelector(`[name="${n}"]`);
    const opt = (v) => (v.trim() === "" ? null : v.trim());
    b.id = f("id").value.trim();
    b.title = f("title").value.trim();
    b.family = opt(f("family").value);
    b.level = f("level").value ? Number(f("level").value) : null;
    b.krai = opt(f("krai").value.toLowerCase());
    b.status = f("status").value;
    b.ulady = [...root.querySelectorAll('[name="ulady"]:checked')].map((x) => x.value);
    b.categories = [...root.querySelectorAll('[name="categories"]:checked')].map((x) => x.value);
    b.images = { color: opt(f("image-color").value), bw: opt(f("image-bw").value) };
    b.prerequisites = f("prerequisites").value.split(",").map((s) => s.trim()).filter(Boolean);
    b.instructorRequirements = opt(f("instructorRequirements").value);
    b.author = opt(f("author").value);
    b.updatedOn = opt(f("updatedOn").value);
    b.notes = f("notes").value.split("\n").map((s) => s.trim()).filter(Boolean);
    json.value = JSON.stringify(b, null, 2);
  };

  root.addEventListener("input", (e) => {
    if (e.target === json) return;
    if (e.target.dataset.f) b.requirements[Number(e.target.dataset.i)][e.target.dataset.f] = e.target.value;
    sync();
  });
  root.addEventListener("change", (e) => e.target !== json && sync());
  reqs.addEventListener("click", (e) => {
    if (e.target.dataset.del === undefined) return;
    b.requirements.splice(Number(e.target.dataset.del), 1);
    drawReqs();
    sync();
  });
  $("#add-req", root).onclick = () => {
    b.requirements.push({ id: String(b.requirements.length + 1), text: "" });
    drawReqs();
    sync();
  };
  $("#image-upload", root).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await api(`/v1/admin/images/${encodeURIComponent(file.name)}`, { method: "PUT", body: await file.arrayBuffer() });
      await reload();
      root.querySelector('[name="image-color"]').value = file.name;
      sync();
      $("#save-note", root).textContent = `Зображення ${file.name} завантажено.`;
    } catch (err) {
      showIssues(root, err.data?.issues ?? [{ severity: "error", path: file.name, message: err.message }]);
    }
  };
}

function renderOverride(target, kind, raw, krai, existing) {
  const value = existing ?? { krai, target: `${kind}:${raw.id}`, hidden: false, title: null, addRequirements: [], removeRequirements: [], addPoints: [], removePoints: [], note: null };
  target.innerHTML = `<div class="form card">
    <p>Доповнення змінює запис лише для краю <b>${esc(krai)}</b>; для решти він лишається як є. Нові пункти мають id з префіксом <code>${esc(krai)}-</code>, наприклад <code>${esc(krai)}-1</code>.
    ${kind === "probe" ? `Точки проби додаються з полем <code>section</code> (літера розділу).` : ""}</p>
    <textarea class="json" id="override-json" rows="16">${esc(JSON.stringify(value, null, 2))}</textarea>
    <div class="row"><button id="save-override">Зберегти доповнення</button>${existing ? `<button id="delete-override" class="danger">Прибрати</button>` : ""}</div>
    <div id="issues"></div>
  </div>`;
  const key = `${krai}|${kind}:${raw.id}`;
  $("#save-override", target).onclick = async () => {
    try {
      const body = JSON.parse($("#override-json", target).value);
      await api(`/v1/admin/entries/overrides/${encodeURIComponent(key)}`, { method: "PUT", json: body });
      await reload();
      renderDetail("preview");
    } catch (e) {
      showIssues(target, e.data?.issues ?? [{ severity: "error", path: "", message: e.message }]);
    }
  };
  const del = $("#delete-override", target);
  if (del)
    del.onclick = async () => {
      await api(`/v1/admin/entries/overrides/${encodeURIComponent(key)}`, { method: "DELETE" });
      await reload();
      renderDetail("preview");
    };
}

function issuesHtml(issues) {
  if (!issues.length) return "";
  return `<ul class="issues">${issues.map((i) => `<li class="${i.severity}"><code>${esc(i.path)}</code> ${esc(i.message)}</li>`).join("")}</ul>`;
}

function showIssues(root, issues, okMessage) {
  const errors = issues.filter((i) => i.severity === "error");
  $("#issues", root).innerHTML = (okMessage && !errors.length ? `<div class="ok">${esc(okMessage)}</div>` : "") + issuesHtml(issues);
}

// ---- zip import ------------------------------------------------------------------------------

async function importZip(file) {
  const { unzipSync, strFromU8 } = await import("./fflate-0.8.2.js");
  const dialog = $("#dialog");
  const body = $("#dialog-body");
  const close = `<div class="row" style="justify-content:flex-end"><button class="secondary" id="close">Закрити</button></div>`;
  const show = (html) => {
    body.innerHTML = html + close;
    $("#close", body).onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
  };

  let files;
  try {
    files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => !f.name.startsWith("__MACOSX/") && !f.name.endsWith(".DS_Store") });
  } catch {
    return show(`<h3>Не вдалося відкрити архів</h3><p>Перевірте, що це zip.</p>`);
  }
  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  const catalogPath = names.filter((n) => n === "catalog.json" || n.endsWith("/catalog.json")).sort((a, b) => a.length - b.length)[0];
  if (!catalogPath) return show(`<h3>У архіві немає catalog.json</h3><p>Очікується <code>catalog.json</code> і тека <code>images/</code> поруч з ним.</p>`);
  const root = catalogPath.slice(0, -"catalog.json".length);
  const images = Object.fromEntries(names.filter((n) => n.startsWith(`${root}images/`) && !n.slice(root.length + 7).includes("/")).map((n) => [n.slice(root.length + 7), files[n]]));

  show(`<h3>${esc(file.name)}</h3><p>Перевіряю ${Object.keys(images).length} зображень і catalog.json…</p>`);
  let created;
  try {
    created = await api("/v1/submissions", { method: "POST", body: strFromU8(files[catalogPath]), headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return show(`<h3>Каталог не пройшов перевірку</h3>${issuesHtml(e.data?.issues ?? e.data?.report?.issues ?? [{ severity: "error", path: "", message: e.message }])}`);
  }

  const missing = created.missingImages.filter((n) => !images[n]);
  if (missing.length) {
    return show(`<h3>Бракує зображень</h3><p>catalog.json посилається на файли, яких немає в <code>images/</code>:</p><ul>${missing.map((n) => `<li><code>${esc(n)}</code></li>`).join("")}</ul>`);
  }

  const toUpload = Object.entries(images).filter(([n]) => created.missingImages.includes(n) || state.images.get(n));
  const problems = [];
  for (let i = 0; i < toUpload.length; i++) {
    const [name, bytes] = toUpload[i];
    show(`<h3>Завантажую зображення</h3><progress max="${toUpload.length}" value="${i}"></progress><p class="muted">${esc(name)}</p>`);
    try {
      const res = await api(`/v1/submissions/${created.id}/images/${encodeURIComponent(name)}`, { method: "PUT", body: bytes });
      problems.push(...(res.issues ?? []));
    } catch (e) {
      problems.push(...(e.data?.issues ?? [{ severity: "error", path: `images/${name}`, message: e.message }]));
    }
  }

  const changes = created.changes;
  const summary = `<p>${changes.filter((c) => c.action === "added").length} нових, ${changes.filter((c) => c.action === "updated").length} змінених записів, ${toUpload.length} зображень.</p>
    <details><summary>Що зміниться</summary><ul>${changes.map((c) => `<li>${c.action === "added" ? "додати" : "змінити"} ${esc(c.kind)} <code>${esc(c.id)}</code></li>`).join("")}</ul></details>`;
  const allIssues = [...created.report.issues, ...problems];

  if (problems.some((p) => p.severity === "error")) return show(`<h3>Деякі зображення не прийнято</h3>${issuesHtml(allIssues)}`);

  if (state.me.role === "contributor") {
    return show(`<h3>Надіслано на погодження</h3>${summary}${issuesHtml(allIssues)}<p>Редактор краю побачить подання у вкладці «Подання».</p>`);
  }
  show(`<h3>Готово до застосування</h3>${summary}${issuesHtml(allIssues)}<div class="row"><button id="apply">Застосувати зараз</button><span class="muted">або залиште у «Поданнях» на погодження.</span></div>`);
  $("#apply", body).onclick = async () => {
    try {
      const res = await api(`/v1/admin/submissions/${created.id}/approve`, { method: "POST" });
      await reload();
      renderList();
      show(`<div class="ok">Застосовано: ${res.changes.length} змін, ${res.images} зображень.</div>`);
    } catch (e) {
      show(`<h3>Не застосовано</h3><p>${esc(e.message)}</p>${issuesHtml(e.data?.report?.issues ?? [])}`);
    }
  };
}

// ---- submissions, editors, audit -------------------------------------------------------------

async function renderSubmissions() {
  const view = $("#submissions-view");
  if (state.me.role === "contributor") {
    view.innerHTML = `<div class="card"><p>Ваші подання переглядає редактор краю. Нове подання: завантажте zip у вкладці «Вмілості».</p></div>`;
    return;
  }
  const list = await api("/v1/admin/submissions?status=pending");
  view.innerHTML = `<h2>Подання на погодження</h2>${
    list.length
      ? `<table><tr><th>Коли</th><th>Від кого</th><th>Край</th><th></th></tr>${list.map((s) => `<tr><td>${esc(s.created_at.slice(0, 16).replace("T", " "))}</td><td>${esc(s.created_by)}</td><td>${esc(s.krai ?? "—")}</td><td><button class="secondary" data-open="${esc(s.id)}">Переглянути</button></td></tr>`).join("")}</table>`
      : `<p class="muted">Нічого не чекає.</p>`
  }<div id="submission"></div>`;
  view.onclick = async (e) => {
    const id = e.target.dataset.open;
    if (!id) return;
    const s = await api(`/v1/submissions/${id}`);
    const box = $("#submission", view);
    box.innerHTML = `<div class="card form">
      <div><b>${esc(s.createdBy)}</b> · край ${esc(s.krai ?? "—")} · ${esc(s.createdAt)}</div>
      <ul>${(s.changes ?? []).map((c) => `<li>${c.action === "added" ? "додати" : "змінити"} ${esc(c.kind)} <code>${esc(c.id)}</code></li>`).join("")}</ul>
      ${s.missingImages?.length ? `<p class="muted">Ще не завантажено: ${s.missingImages.map(esc).join(", ")}</p>` : ""}
      ${issuesHtml(s.report?.issues ?? [])}
      <label>Коментар до відхилення<input id="reject-note"></label>
      <div class="row"><button id="approve">Застосувати</button><button id="reject" class="danger">Відхилити</button></div>
      <div id="issues"></div></div>`;
    $("#approve", box).onclick = async () => {
      try {
        await api(`/v1/admin/submissions/${id}/approve`, { method: "POST" });
        await reload();
        renderSubmissions();
      } catch (err) {
        showIssues(box, err.data?.report?.issues ?? [{ severity: "error", path: "", message: err.message }]);
      }
    };
    $("#reject", box).onclick = async () => {
      await api(`/v1/admin/submissions/${id}/reject`, { method: "POST", json: { note: $("#reject-note", box).value } });
      renderSubmissions();
    };
  };
}

async function renderEditors() {
  const view = $("#editors-view");
  const list = await api("/v1/admin/editors");
  view.innerHTML = `<h2>Хто має доступ</h2>
    <p class="muted">Вхід через Cloudflare Access (код на пошту). Власники з <code>OWNER_EMAILS</code> тут не показані.</p>
    <table><tr><th>Пошта</th><th>Роль</th><th>Краї</th><th></th></tr>${list.map((e) => `<tr><td>${esc(e.email)}</td><td>${esc(e.role)}</td><td>${esc(e.krai ?? "")}</td><td><button class="danger" data-remove="${esc(e.email)}">Прибрати</button></td></tr>`).join("")}</table>
    <div class="card form"><div class="grid">
      <label>Пошта<input id="ed-email" type="email"></label>
      <label>Роль<select id="ed-role"><option value="editor">редактор краю</option><option value="contributor">дописувач</option><option value="owner">власник</option></select></label>
      <label>Краї (через кому)<input id="ed-krai" placeholder="cz"></label>
    </div><div class="row"><button id="ed-save">Додати або змінити</button></div><div id="issues"></div></div>`;
  view.onclick = async (e) => {
    if (e.target.dataset.remove) {
      if (!confirm(`Прибрати доступ ${e.target.dataset.remove}?`)) return;
      await api(`/v1/admin/editors/${encodeURIComponent(e.target.dataset.remove)}`, { method: "DELETE" });
      renderEditors();
    } else if (e.target.id === "ed-save") {
      try {
        await api(`/v1/admin/editors/${encodeURIComponent($("#ed-email").value)}`, {
          method: "PUT",
          json: { role: $("#ed-role").value, krai: $("#ed-krai").value.split(",").map((k) => k.trim()).filter(Boolean) },
        });
        renderEditors();
      } catch (err) {
        showIssues(view, [{ severity: "error", path: "", message: err.message }]);
      }
    }
  };
}

async function renderAudit() {
  const list = await api("/v1/admin/audit?limit=200");
  $("#audit-view").innerHTML = `<h2>Журнал змін</h2><table><tr><th>Коли</th><th>Хто</th><th>Що</th><th>Запис</th></tr>${list
    .map((a) => `<tr><td>${esc(a.at.slice(0, 16).replace("T", " "))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.kind ?? "")} <code>${esc(a.entry_id ?? a.submission ?? "")}</code></td></tr>`)
    .join("")}</table>`;
}

boot().catch((e) => {
  $("#detail").innerHTML = `<div class="card"><h2>Помилка</h2><p>${esc(e.message)}</p></div>`;
});
