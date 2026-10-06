// Coffee, ranked: loads config + shops, lets the viewer weight categories,
// and renders a ranked list. No build step, no dependencies.

const STORAGE_KEY = "coffee-rankings:weights:v1";

const state = {
  config: null,
  shops: [],
  weights: {},        // { catId: { subId: number } } — sub weights are absolute
  presetId: null,     // id of the preset the weights still match, or null for custom
  expanded: new Set(), // shop names whose breakdown is open
  query: ""
};

// ---------- weights ----------

// A preset may give a category a number (its total, split evenly across subs)
// or an object of per-sub weights. Unlisted subs/categories get 0.
function weightsFromPreset(preset) {
  const out = {};
  for (const cat of state.config.categories) {
    const spec = preset.weights[cat.id];
    out[cat.id] = {};
    for (const sub of cat.subcategories) {
      if (typeof spec === "number") out[cat.id][sub.id] = spec / cat.subcategories.length;
      else out[cat.id][sub.id] = spec?.[sub.id] ?? 0;
    }
  }
  return out;
}

const catTotal = (catId) =>
  Object.values(state.weights[catId]).reduce((a, b) => a + b, 0);

const grandTotal = () =>
  state.config.categories.reduce((a, c) => a + catTotal(c.id), 0);

// Set a category's total by scaling its subs proportionally. Subs are capped
// at maxWeight, so overflow is redistributed to the ones with headroom.
function setCategoryTotal(cat, target) {
  const max = state.config.maxWeight;
  const subs = cat.subcategories.map((s) => s.id);
  const w = state.weights[cat.id];
  const current = catTotal(cat.id);

  // Nothing to scale from: spread evenly.
  if (current === 0) {
    for (const id of subs) w[id] = Math.min(max, target / subs.length);
    return;
  }

  const ratios = Object.fromEntries(subs.map((id) => [id, w[id] / current]));
  let free = subs.filter((id) => ratios[id] > 0);
  let remaining = target;
  for (const id of subs) if (!free.includes(id)) w[id] = 0;

  while (free.length) {
    const ratioSum = free.reduce((a, id) => a + ratios[id], 0);
    const capped = free.filter((id) => (remaining * ratios[id]) / ratioSum > max);
    if (!capped.length) {
      for (const id of free) w[id] = (remaining * ratios[id]) / ratioSum;
      break;
    }
    for (const id of capped) { w[id] = max; remaining -= max; }
    free = free.filter((id) => !capped.includes(id));
  }
}

function matchingPresetId() {
  const eq = (a, b) => Math.abs(a - b) < 1e-6;
  for (const p of state.config.presets) {
    const pw = weightsFromPreset(p);
    const same = state.config.categories.every((c) =>
      c.subcategories.every((s) => eq(pw[c.id][s.id], state.weights[c.id][s.id]))
    );
    if (same) return p.id;
  }
  return null;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.weights));
  } catch {}
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return null;
    // Only accept saved weights that still fit the current config.
    const ok = state.config.categories.every((c) =>
      c.subcategories.every((s) => typeof saved[c.id]?.[s.id] === "number")
    );
    return ok ? saved : null;
  } catch {
    return null;
  }
}

// ---------- scoring ----------

// Weighted mean over the sub-scores a shop actually has. Missing values are
// dropped from both numerator and denominator rather than counted as zero.
function scoreShop(shop) {
  let totalW = 0, totalWS = 0;
  const cats = state.config.categories.map((cat) => {
    let w = 0, ws = 0, plainSum = 0, plainN = 0;
    const subs = cat.subcategories.map((sub) => {
      const s = shop.scores?.[cat.id]?.[sub.id];
      const has = typeof s === "number";
      if (has) {
        const sw = state.weights[cat.id][sub.id];
        w += sw; ws += sw * s;
        plainSum += s; plainN++;
      }
      return { sub, score: has ? s : null };
    });
    totalW += w; totalWS += ws;
    // Display score for the category: weighted if it has weight, plain mean otherwise.
    const score = w > 0 ? ws / w : plainN ? plainSum / plainN : null;
    return { cat, score, weighted: ws, subs };
  });

  const total = totalW > 0 ? totalWS / totalW : null;
  // Each category's share of the final score, in score points.
  for (const c of cats) c.points = totalW > 0 ? c.weighted / totalW : 0;
  return { shop, total, cats };
}

// ---------- rendering ----------

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};

const fmt = (n) => (n == null ? "—" : n.toFixed(1));
const pct = (n) => `${Math.round(n * 100)}%`;
// Case- and accent-insensitive matching ("cafe" finds "Café").
const normalize = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function renderRanking() {
  const max = state.config.scale.max;
  const results = state.shops
    .map(scoreShop)
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1))
    .map((r, i) => ({ ...r, rank: i + 1 })); // rank before filtering, so search keeps true positions

  const q = normalize(state.query.trim());
  const shown = q ? results.filter((r) => normalize(r.shop.name).includes(q)) : results;

  document.getElementById("list-meta").textContent = q
    ? `${shown.length} of ${results.length} places`
    : `${results.length} places`;

  const list = document.getElementById("ranking");
  if (!shown.length) {
    list.replaceChildren(el("li", { class: "empty" }, `Nothing matches “${state.query.trim()}”.`));
    return;
  }
  list.replaceChildren(
    ...shown.map((r) => {
      const open = state.expanded.has(r.shop.name);
      const bar = el("div", { class: "bar", "aria-hidden": "true" },
        r.cats.map((c) =>
          el("span", {
            class: "seg",
            title: `${c.cat.label}: ${c.points.toFixed(2)} pts`,
            style: { width: `${(c.points / max) * 100}%`, background: c.cat.color }
          })
        )
      );

      const breakdown = el("div", { class: "breakdown" },
        r.cats.map((c) =>
          el("div", { class: "bd-cat" },
            el("div", { class: "bd-head" },
              el("span", { class: "swatch", style: { background: c.cat.color } }),
              el("span", { class: "bd-label" }, c.cat.label),
              el("span", { class: "num" }, fmt(c.score))
            ),
            el("ul", { class: "bd-subs" },
              c.subs.map((s) =>
                el("li", { class: s.score == null ? "missing" : "" },
                  el("span", {}, s.sub.label),
                  el("span", { class: "num" }, fmt(s.score))
                )
              )
            )
          )
        )
      );
      if (!open) breakdown.hidden = true;

      const toggle = () => {
        if (state.expanded.has(r.shop.name)) state.expanded.delete(r.shop.name);
        else state.expanded.add(r.shop.name);
        renderRanking();
      };

      return el("li", { class: `shop${open ? " open" : ""}` },
        el("button", { class: "shop-main", "aria-expanded": String(open), onclick: toggle },
          el("span", { class: "rank num" }, String(r.rank).padStart(2, "0")),
          el("span", { class: "shop-body" },
            el("span", { class: "shop-title" },
              el("span", { class: "shop-name" }, r.shop.name),
              r.shop.area ? el("span", { class: "shop-area" }, r.shop.area) : null
            ),
            el("span", { class: "shop-desc" }, r.shop.description),
            bar
          ),
          el("span", { class: "score num" }, fmt(r.total))
        ),
        breakdown
      );
    })
  );
}

function renderPresets() {
  const list = document.getElementById("preset-list");
  list.replaceChildren(
    ...state.config.presets.map((p) =>
      el("button", {
        class: "preset",
        role: "radio",
        "data-id": p.id,
        onclick: () => {
          state.weights = weightsFromPreset(p);
          update();
        }
      }, p.label)
    )
  );
}

// Built once; update() syncs values so sliders don't lose focus mid-drag.
function renderControls() {
  const max = state.config.maxWeight;
  const root = document.getElementById("category-controls");

  root.replaceChildren(
    ...state.config.categories.map((cat) => {
      const subRows = cat.subcategories.map((sub) =>
        el("label", { class: "ctrl sub", title: sub.description },
          el("span", { class: "ctrl-label" }, sub.label),
          el("input", {
            type: "range", min: 0, max, step: 0.5,
            "data-cat": cat.id, "data-sub": sub.id,
            oninput: (e) => {
              state.weights[cat.id][sub.id] = Number(e.target.value);
              update();
            }
          }),
          el("span", { class: "ctrl-pct num", "data-pct": `${cat.id}.${sub.id}` })
        )
      );

      const subsBox = el("div", { class: "subs", hidden: "" }, subRows);
      const caret = el("button", {
        class: "caret",
        "aria-expanded": "false",
        "aria-label": `Show ${cat.label} details`,
        onclick: () => {
          const open = subsBox.hidden;
          subsBox.hidden = !open;
          caret.setAttribute("aria-expanded", String(open));
        }
      }, "▸");

      return el("div", { class: "cat-ctrl" },
        el("div", { class: "ctrl cat" },
          caret,
          el("span", { class: "ctrl-label" },
            el("span", { class: "swatch", style: { background: cat.color } }),
            cat.label
          ),
          el("input", {
            type: "range", min: 0, max: max * cat.subcategories.length, step: 0.5,
            "data-cat": cat.id,
            oninput: (e) => {
              setCategoryTotal(cat, Number(e.target.value));
              update();
            }
          }),
          el("span", { class: "ctrl-pct num", "data-pct": cat.id })
        ),
        subsBox
      );
    })
  );
}

function syncControls() {
  const total = grandTotal();
  const share = (w) => (total > 0 ? pct(w / total) : "—");

  for (const cat of state.config.categories) {
    const t = catTotal(cat.id);
    const catInput = document.querySelector(`input[data-cat="${cat.id}"]:not([data-sub])`);
    if (document.activeElement !== catInput) catInput.value = t;
    document.querySelector(`[data-pct="${cat.id}"]`).textContent = share(t);

    for (const sub of cat.subcategories) {
      const w = state.weights[cat.id][sub.id];
      const input = document.querySelector(`input[data-cat="${cat.id}"][data-sub="${sub.id}"]`);
      if (document.activeElement !== input) input.value = w;
      document.querySelector(`[data-pct="${cat.id}.${sub.id}"]`).textContent = share(w);
    }
  }

  const active = state.config.presets.find((p) => p.id === state.presetId);
  for (const btn of document.querySelectorAll(".preset")) {
    const on = btn.dataset.id === state.presetId;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", String(on));
  }
  document.getElementById("active-preset").textContent = active ? active.label : "Custom";
  document.getElementById("preset-desc").textContent = active
    ? active.description
    : "Custom weights. Pick a preset to reset.";
}

function update() {
  state.presetId = matchingPresetId();
  save();
  syncControls();
  renderRanking();
}

// ---------- boot ----------

async function main() {
  try {
    const [config, data] = await Promise.all([
      fetch("data/config.json").then((r) => r.json()),
      fetch("data/shops.json").then((r) => r.json())
    ]);
    state.config = config;
    state.shops = data.shops;
  } catch (err) {
    document.getElementById("ranking").replaceChildren(
      el("li", { class: "error" },
        "Couldn't load data/*.json. Serve this folder over HTTP (e.g. `python -m http.server`) rather than opening the file directly.")
    );
    console.error(err);
    return;
  }

  state.weights = load() ?? weightsFromPreset(state.config.presets[0]);

  // Start with the weights panel collapsed on narrow screens.
  if (window.matchMedia("(max-width: 900px)").matches) {
    document.getElementById("weights-box").open = false;
  }

  document.getElementById("search").addEventListener("input", (e) => {
    state.query = e.target.value;
    renderRanking();
  });

  renderPresets();
  renderControls();
  update();
}

main();
