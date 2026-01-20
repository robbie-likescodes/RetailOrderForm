/**
 * Retail Order Portal - app.js (comprehensive, production-lean)
 * ------------------------------------------------------------
 * Features:
 * - Loads Categories + Products from Google Apps Script (GET)
 * - Category-first mobile flow with fast quantity controls per item
 * - Local cache for offline / fast startup (categories, products, quantities, form meta, position)
 * - “Refresh Products” button with confirmation and graceful fallback to cache
 * - Review screen with inline edits
 * - Submit (POST) wired (will fail gracefully until you add doPost in Apps Script)
 * - Token support via URL ?token=XXXX and optional store lock via ?store=Boniface
 * - Basic input validation and error surfaces
 *
 * Required HTML element IDs expected (matches index.html):
 * lastUpdated, refreshBtn, store, requestedDate, placedBy, email, notes,
 * catalog, items, categoryList, itemList, selectedSummary, itemsSummary,
 * categoryTitle, categoryMeta, backToCategories, reviewBtn, errorBox,
 * review, reviewList, editBtn, submitBtn, submitError, submitSuccess
 *
 * Optional extra IDs (if you add them):
 * netStatus
 */

// =========================
// CONFIG
// =========================
const CONFIG = {
  // Put your web app URL here (ends with /exec)
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzgkI0hGD6aIdLuUYM8T_MD6XJyfzYBQmdoLW7z8yB2R6Sjh4BI5LHgyg_ybvVisY6K/exec",

  // Endpoints
  GET_CATEGORIES: (t) => `${CONFIG.SCRIPT_URL}?action=categories&t=${t}`,
  GET_PRODUCTS: (t) => `${CONFIG.SCRIPT_URL}?action=products&t=${t}`,

  // POST URL is the same /exec (Apps Script doPost)
  POST_ORDER: () => `${CONFIG.SCRIPT_URL}`,

  // Behavior
  CACHE_TTL_MS: 1000 * 60 * 60 * 12, // 12 hours (soft)
  CONFIRM_REFRESH_IF_DIRTY: true,
  AUTOFOCUS_QTY: true,
  HIDE_EMPTY_CATEGORIES: true,
  REQUIRE_TOKEN: false,

  // Validation
  MAX_QTY: 9999,

  // If your stores are fixed, put them here (optional). If empty, free-text store entry.
  STORES: [], // e.g. ["Boniface", "Huffman", "Muldoon", "Lake Otis", "Camelot"]
};

// =========================
// URL PARAMS / TOKEN
// =========================
const urlParams = new URLSearchParams(window.location.search);
const TOKEN = urlParams.get("token") || "";                 // optional shared key / store token
const STORE_LOCK = urlParams.get("store") || "";            // optional store prefill/lock
const DEBUG = (urlParams.get("debug") || "").toLowerCase() === "true";

// =========================
// CACHE KEYS
// =========================
const CACHE = {
  CATEGORIES: "orderportal_categories_v2",
  PRODUCTS: "orderportal_products_v2",
  UPDATED_AT: "orderportal_updated_at_v2",
  CACHED_AT: "orderportal_cached_at_v2",
  QUANTITIES: "orderportal_quantities_v2",
  META: "orderportal_meta_v2",
  POSITION: "orderportal_position_v2",
};

// =========================
// DOM HELPERS
// =========================
const $ = (id) => document.getElementById(id);
const ui = {
  lastUpdated: $("lastUpdated"),
  refreshBtn: $("refreshBtn"),
  store: $("store"),
  requestedDate: $("requestedDate"),
  placedBy: $("placedBy"),
  email: $("email"),
  notes: $("notes"),

  review: $("review"),

  catalog: $("catalog"),
  items: $("items"),
  categoryList: $("categoryList"),
  itemList: $("itemList"),
  selectedSummary: $("selectedSummary"),
  itemsSummary: $("itemsSummary"),
  categoryTitle: $("categoryTitle"),
  categoryMeta: $("categoryMeta"),
  backToCategories: $("backToCategories"),
  reviewBtn: $("reviewBtn"),
  errorBox: $("errorBox"),

  reviewList: $("reviewList"),
  editBtn: $("editBtn"),
  submitBtn: $("submitBtn"),
  submitError: $("submitError"),
  submitSuccess: $("submitSuccess"),

  // Optional extras
  netStatus: $("netStatus"),
};

// =========================
// STATE
// =========================
const state = {
  categories: [],
  products: [],
  steps: [],        // flattened ordered products
  idx: 0,           // current step index
  quantities: {},   // sku -> qty number
  selectedCategory: "",
  meta: {
    store: "",
    requested_date: "",
    placed_by: "",
    email: "",
    notes: "",
  },
  dirty: false,     // true if anything changed since last submit/refresh
  lastCatalogIso: "", // when refreshed
  lastCacheIso: "",   // when cached
  categoryIndex: new Map(), // category -> {start, end}
};

// =========================
// UTIL
// =========================
function log(...args) { if (DEBUG) console.log("[OrderPortal]", ...args); }

function nowIso() { return new Date().toISOString(); }

function todayDateValue() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRowKeys(row) {
  if (!row || typeof row !== "object") return {};
  return Object.keys(row).reduce((acc, key) => {
    const normalized = normalizeKey(key);
    if (normalized) acc[normalized] = row[key];
    return acc;
  }, {});
}

function setText(el, txt) {
  if (!el) return;
  el.textContent = txt;
}

function setHidden(el, hidden) {
  if (!el) return;
  el.hidden = !!hidden;
}

function showError(msg) {
  setHidden(ui.errorBox, !msg);
  setText(ui.errorBox, msg || "");
}

function showSubmitError(msg) {
  setHidden(ui.submitError, !msg);
  setText(ui.submitError, msg || "");
}

function showSubmitSuccess(msg) {
  setHidden(ui.submitSuccess, !msg);
  setText(ui.submitSuccess, msg || "");
}

function isFiniteInt(n) {
  return Number.isFinite(n) && Math.floor(n) === n;
}

// iOS: avoid zoom: ensure input font-size >= 16 in CSS, already done.

// =========================
// CACHE: LOAD/SAVE
// =========================
function loadCache() {
  const cats = safeJsonParse(localStorage.getItem(CACHE.CATEGORIES) || "[]", []);
  const prods = safeJsonParse(localStorage.getItem(CACHE.PRODUCTS) || "[]", []);
  const qtys = safeJsonParse(localStorage.getItem(CACHE.QUANTITIES) || "{}", {});
  const meta = safeJsonParse(localStorage.getItem(CACHE.META) || "{}", {});
  const pos = safeJsonParse(localStorage.getItem(CACHE.POSITION) || "{}", {});
  const updatedAt = localStorage.getItem(CACHE.UPDATED_AT) || "";
  const cachedAt = localStorage.getItem(CACHE.CACHED_AT) || "";

  if (Array.isArray(cats) && cats.length) state.categories = cats;
  if (Array.isArray(prods) && prods.length) state.products = prods;
  if (qtys && typeof qtys === "object") state.quantities = qtys;
  state.meta = { ...state.meta, ...(meta || {}) };
  state.meta = {
    store: state.meta.store || "",
    requested_date: state.meta.requested_date || "",
    placed_by: state.meta.placed_by || "",
    email: state.meta.email || "",
    notes: state.meta.notes || "",
  };

  if (pos && typeof pos.idx === "number") state.idx = Math.max(0, pos.idx | 0);

  state.lastCatalogIso = updatedAt;
  state.lastCacheIso = cachedAt;

  if (updatedAt) {
    setText(ui.lastUpdated, `Catalog: ${new Date(updatedAt).toLocaleString()}`);
  } else if (cachedAt) {
    setText(ui.lastUpdated, `Catalog: cached ${new Date(cachedAt).toLocaleString()}`);
  } else {
    setText(ui.lastUpdated, `Catalog: not loaded`);
  }

  // Apply store lock if present
  if (STORE_LOCK) state.meta.store = STORE_LOCK;
  if (!state.meta.requested_date) state.meta.requested_date = todayDateValue();

  hydrateMetaInputs();
}

function saveCache() {
  localStorage.setItem(CACHE.CATEGORIES, JSON.stringify(state.categories));
  localStorage.setItem(CACHE.PRODUCTS, JSON.stringify(state.products));
  localStorage.setItem(CACHE.QUANTITIES, JSON.stringify(state.quantities));
  localStorage.setItem(CACHE.META, JSON.stringify(state.meta));
  localStorage.setItem(CACHE.POSITION, JSON.stringify({ idx: state.idx }));
  localStorage.setItem(CACHE.CACHED_AT, nowIso());
}

// =========================
// META INPUTS
// =========================
function hydrateMetaInputs() {
  if (ui.store) ui.store.value = state.meta.store || "";
  if (ui.requestedDate) ui.requestedDate.value = state.meta.requested_date || "";
  if (ui.placedBy) ui.placedBy.value = state.meta.placed_by || "";
  if (ui.email) ui.email.value = state.meta.email || "";
  if (ui.notes) ui.notes.value = state.meta.notes || "";

  // Optional store lock
  if (STORE_LOCK && ui.store) {
    ui.store.value = STORE_LOCK;
    ui.store.setAttribute("disabled", "disabled");
  }
}

function syncMetaFromInputs() {
  if (ui.store) state.meta.store = ui.store.value.trim();
  if (ui.requestedDate) state.meta.requested_date = ui.requestedDate.value;
  if (ui.placedBy) state.meta.placed_by = ui.placedBy.value.trim();
  if (ui.email) state.meta.email = ui.email.value.trim();
  if (ui.notes) state.meta.notes = ui.notes.value.trim();
  saveCache();
}

// =========================
// CATALOG: BUILD STEPS
// =========================
function normalizeCategoryRows(rows) {
  // expected: {category, display_name, sort, active}
  const out = [];
  for (const r of rows || []) {
    const normalized = normalizeRowKeys(r);
    const category = String(normalized.category || r.category || "").trim();
    const active = String(normalized.active ?? r.active ?? "TRUE").toUpperCase() === "TRUE";
    if (!category || !active) continue;
    out.push({
      category,
      display_name: String(
        normalized.display_name ?? r.display_name ?? category
      ).trim(),
      sort: Number(normalized.sort ?? r.sort ?? 9999),
    });
  }
  out.sort((a, b) => a.sort - b.sort);
  return out;
}

function normalizeProductRows(rows) {
  // expected: item_no, sku, name, category, unit, pack_size, sort, active
  const out = [];
  for (const r of rows || []) {
    const normalized = normalizeRowKeys(r);
    const sku = String(normalized.sku || r.sku || "").trim();
    const name = String(normalized.name || r.name || "").trim();
    const category = String(normalized.category || r.category || "").trim();
    const active = String(normalized.active ?? r.active ?? "TRUE").toUpperCase() === "TRUE";
    if (!sku || !name || !category || !active) continue;

    out.push({
      item_no: String(normalized.item_no || r.item_no || "").trim(),
      sku,
      name,
      category,
      unit: String(normalized.unit || r.unit || "").trim(),
      pack_size: String(normalized.pack_size || r.pack_size || "").trim(),
      sort: Number(normalized.sort ?? r.sort ?? 9999),
    });
  }
  return out;
}

function buildSteps() {
  const catOrder = new Map();
  const catDisplay = new Map();

  state.categories.forEach((c, i) => {
    catOrder.set(c.category, Number(c.sort ?? i));
    catDisplay.set(c.category, c.display_name || c.category);
  });

  // If no categories loaded, create derived categories in alpha order
  if (state.categories.length === 0) {
    const unique = new Set(state.products.map(p => p.category));
    const derived = [...unique].sort().map((cat, i) => ({
      category: cat,
      display_name: cat,
      sort: i * 10,
    }));
    state.categories = derived;
    derived.forEach((c, i) => {
      catOrder.set(c.category, Number(c.sort ?? i));
      catDisplay.set(c.category, c.display_name || c.category);
    });
  }

  // Sort by category sort, then product sort, then name
  const sorted = [...state.products].sort((a, b) => {
    const ac = catOrder.has(a.category) ? catOrder.get(a.category) : 9999;
    const bc = catOrder.has(b.category) ? catOrder.get(b.category) : 9999;
    if (ac !== bc) return ac - bc;

    const as = Number(a.sort ?? 9999);
    const bs = Number(b.sort ?? 9999);
    if (as !== bs) return as - bs;

    return String(a.name).localeCompare(String(b.name));
  });

  // If configured, hide products whose category is missing and HIDE_EMPTY_CATEGORIES is false/true:
  // We keep them anyway; missing category simply sorts to end.
  state.steps = sorted;

  // Build category index (start/end) for jump menu and progress
  state.categoryIndex = new Map();
  let currentCat = null;
  let start = 0;
  for (let i = 0; i < state.steps.length; i++) {
    const cat = state.steps[i].category;
    if (cat !== currentCat) {
      if (currentCat !== null) state.categoryIndex.set(currentCat, { start, end: i - 1 });
      currentCat = cat;
      start = i;
    }
  }
  if (currentCat !== null) state.categoryIndex.set(currentCat, { start, end: state.steps.length - 1 });

  // Clamp idx
  state.idx = Math.max(0, Math.min(state.idx, Math.max(0, state.steps.length - 1)));

  renderCategories();
}

// =========================
// SELECTIONS
// =========================
function countSelected() {
  let n = 0;
  for (const v of Object.values(state.quantities)) {
    if (Number(v) > 0) n++;
  }
  return n;
}

function getQty(sku) {
  return Number(state.quantities[sku]) || 0;
}

function setQty(sku, qty) {
  if (!sku) return;
  if (!Number.isFinite(qty) || qty < 0) return;
  const clamped = Math.min(Math.floor(qty), CONFIG.MAX_QTY);
  if (clamped <= 0) {
    if (state.quantities[sku] !== undefined) {
      delete state.quantities[sku];
      state.dirty = true;
    }
  } else {
    if (state.quantities[sku] !== clamped) {
      state.quantities[sku] = clamped;
      state.dirty = true;
    }
  }
  saveCache();
  renderSelectedSummary();
}

function parseQtyInput(raw) {
  const trimmed = String(raw || "").trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return Math.min(Math.floor(num), CONFIG.MAX_QTY);
}

// =========================
// RENDER: CATALOG / ITEMS
// =========================
function renderSelectedSummary() {
  const label = `Selected: ${countSelected()}`;
  setText(ui.selectedSummary, label);
  setText(ui.itemsSummary, label);
}

function renderCategories() {
  if (!ui.categoryList) return;
  ui.categoryList.innerHTML = "";

  if (!state.steps.length) {
    ui.categoryList.innerHTML = `<div class="categoryCard" aria-disabled="true">
      <div>No products loaded</div>
      <div class="categoryCard__meta">Tap refresh to load your catalog.</div>
    </div>`;
    renderSelectedSummary();
    return;
  }

  const counts = new Map();
  state.steps.forEach(p => {
    counts.set(p.category, (counts.get(p.category) || 0) + 1);
  });

  const orderedCategories = state.categories.length
    ? state.categories.map(c => c.category)
    : [...new Set(state.steps.map(p => p.category))];

  orderedCategories.forEach(category => {
    const itemCount = counts.get(category) || 0;
    if (!itemCount && CONFIG.HIDE_EMPTY_CATEGORIES) return;
    const catRow = state.categories.find(c => c.category === category);
    const label = catRow?.display_name || category;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "categoryCard";
    card.innerHTML = `
      <div>${escapeHtml(label)}</div>
      <div class="categoryCard__meta">${itemCount} item${itemCount === 1 ? "" : "s"}</div>
    `;
    card.addEventListener("click", () => {
      state.selectedCategory = category;
      showItems();
    });
    ui.categoryList.appendChild(card);
  });

  renderSelectedSummary();
}

function renderItems() {
  if (!ui.itemList) return;
  const category = state.selectedCategory;
  const catRow = state.categories.find(c => c.category === category);
  const label = catRow?.display_name || category || "Items";

  setText(ui.categoryTitle, label);

  const items = state.steps.filter(p => p.category === category);
  setText(ui.categoryMeta, `${items.length} item${items.length === 1 ? "" : "s"}`);

  ui.itemList.innerHTML = "";

  if (!items.length) {
    ui.itemList.innerHTML = `<div class="itemCard">
      <div class="itemCard__name">No items found</div>
      <div class="itemCard__meta">Pick another category.</div>
    </div>`;
    renderSelectedSummary();
    return;
  }

  items.forEach(item => {
    const metaParts = [item.item_no, item.unit, item.pack_size].filter(Boolean);
    const qty = getQty(item.sku);
    const card = document.createElement("div");
    card.className = "itemCard";
    card.innerHTML = `
      <div>
        <div class="itemCard__name">${escapeHtml(item.name)}</div>
        <div class="itemCard__meta">${escapeHtml(metaParts.join(" • "))}</div>
      </div>
      <div class="qtyControl" data-sku="${escapeHtml(item.sku)}">
        <button class="qtyBtn" type="button" data-action="decrement">−</button>
        <input class="qtyInput" inputmode="numeric" pattern="[0-9]*" value="${qty ? qty : ""}" />
        <button class="qtyBtn" type="button" data-action="increment">+</button>
      </div>
    `;
    ui.itemList.appendChild(card);
  });

  renderSelectedSummary();
}

// =========================
// NAVIGATION
// =========================
function showCatalog() {
  setHidden(ui.items, true);
  setHidden(ui.review, true);
  setHidden(ui.catalog, false);
  renderCategories();
}

function showItems() {
  if (!state.selectedCategory) {
    showCatalog();
    return;
  }
  setHidden(ui.catalog, true);
  setHidden(ui.review, true);
  setHidden(ui.items, false);
  renderItems();
}

function showReview() {
  syncMetaFromInputs();
  showSubmitError("");
  showSubmitSuccess("");

  setHidden(ui.catalog, true);
  setHidden(ui.items, true);
  setHidden(ui.review, false);

  const selected = state.steps
    .filter(p => Number(state.quantities[p.sku]) > 0)
    .map(p => ({
      ...p,
      qty: Number(state.quantities[p.sku]),
    }));

  ui.reviewList.innerHTML = "";
  if (selected.length === 0) {
    ui.reviewList.innerHTML = `<div class="reviewItem">No items selected.</div>`;
    return;
  }

  // Group by category for readability
  const grouped = new Map();
  for (const item of selected) {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category).push(item);
  }

  for (const [cat, items] of grouped.entries()) {
    const catRow = state.categories.find(c => c.category === cat);
    const catLabel = catRow?.display_name || cat;

    const header = document.createElement("div");
    header.className = "reviewItem";
    header.innerHTML = `<div class="reviewItem__name">${escapeHtml(catLabel)}</div>`;
    ui.reviewList.appendChild(header);

    items.forEach(p => {
      const div = document.createElement("div");
      div.className = "reviewItem";
      div.innerHTML = `
        <div class="reviewItem__top">
          <div>
            <div class="reviewItem__name">${escapeHtml(p.name)}</div>
            <div class="reviewItem__meta">${escapeHtml([p.item_no, p.unit, p.pack_size].filter(Boolean).join(" • "))}</div>
          </div>
          <input
            data-sku="${escapeHtml(p.sku)}"
            value="${p.qty}"
            inputmode="numeric"
            pattern="[0-9]*"
            style="width:110px; font-size:16px; padding:10px; border-radius:12px; border:1px solid rgba(0,0,0,.12);"
          />
        </div>
      `;
      ui.reviewList.appendChild(div);
    });
  }
}

function backToWizard() {
  // Pull edits from review
  const inputs = ui.reviewList.querySelectorAll("input[data-sku]");
  inputs.forEach(inp => {
    const sku = inp.getAttribute("data-sku");
    const raw = (inp.value || "").trim();
    if (!raw) {
      delete state.quantities[sku];
      return;
    }
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n > 0) state.quantities[sku] = n;
    else delete state.quantities[sku];
  });

  saveCache();
  state.dirty = true;
  renderSelectedSummary();

  setHidden(ui.review, true);
  if (state.selectedCategory) {
    showItems();
  } else {
    showCatalog();
  }
}

// =========================
// NETWORK / API
// =========================
async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (!data) {
      throw new Error(
        `Expected JSON but received ${res.headers.get("content-type") || "unknown content-type"}. ` +
        `Response: ${text.slice(0, 200)}`
      );
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function isCacheStale() {
  const cachedAt = localStorage.getItem(CACHE.CACHED_AT);
  if (!cachedAt) return true;
  const age = Date.now() - new Date(cachedAt).getTime();
  return age > CONFIG.CACHE_TTL_MS;
}

async function refreshCatalog({ force = false } = {}) {
  showError("");

  if (CONFIG.CONFIRM_REFRESH_IF_DIRTY && state.dirty && !force) {
    const ok = confirm("Refreshing may reset your position. Continue?");
    if (!ok) return;
  }

  if (!CONFIG.SCRIPT_URL || CONFIG.SCRIPT_URL.includes("PASTE_")) {
    showError("Please set CONFIG.SCRIPT_URL in app.js to your Apps Script Web App /exec URL.");
    return;
  }

  ui.refreshBtn.disabled = true;
  ui.refreshBtn.textContent = "Refreshing...";

  try {
    const t = Date.now();
    const [catsResp, prodsResp] = await Promise.all([
      fetchJson(CONFIG.GET_CATEGORIES(t)),
      fetchJson(CONFIG.GET_PRODUCTS(t)),
    ]);

    if (!catsResp.ok) throw new Error(catsResp.error || "Categories endpoint failed");
    if (!prodsResp.ok) throw new Error(prodsResp.error || "Products endpoint failed");

    const cats = normalizeCategoryRows(catsResp.categories || []);
    const prods = normalizeProductRows(prodsResp.products || []);

    state.categories = cats;
    state.products = prods;

    // Reset idx if steps changed significantly
    buildSteps();
    state.idx = Math.min(state.idx, Math.max(0, state.steps.length - 1));

    // Update timestamps
    const iso = nowIso();
    state.lastCatalogIso = iso;
    localStorage.setItem(CACHE.UPDATED_AT, iso);
    localStorage.setItem(CACHE.CACHED_AT, iso);
    setText(ui.lastUpdated, `Catalog: ${new Date(iso).toLocaleString()}`);

    saveCache();
    if (state.selectedCategory) {
      const hasCategory = state.steps.some(item => item.category === state.selectedCategory);
      if (!hasCategory) state.selectedCategory = "";
    }
    if (state.selectedCategory) {
      showItems();
    } else {
      showCatalog();
    }
    state.dirty = false;

  } catch (err) {
    showError(`Could not refresh. Using cached data if available. (${String(err)})`);
    buildSteps();
    if (state.selectedCategory) {
      showItems();
    } else {
      showCatalog();
    }
  } finally {
    ui.refreshBtn.disabled = false;
    ui.refreshBtn.textContent = "Refresh";
  }
}

function updateNetStatus() {
  if (!ui.netStatus) return;
  const online = navigator.onLine;
  ui.netStatus.textContent = online ? "Online" : "Offline";
  ui.netStatus.style.opacity = online ? "0.7" : "1";
}

// =========================
// SUBMISSION (POST)
// =========================
function validateMeta() {
  syncMetaFromInputs();

  if (!state.meta.store) return "Store is required.";
  if (!state.meta.requested_date) return "Requested date is required.";
  if (!state.meta.placed_by) return "Placed by is required.";

  // Light validation
  if (state.meta.email && !state.meta.email.includes("@")) return "Email looks invalid.";

  return "";
}

function selectedItemsPayload() {
  return state.steps
    .filter(p => Number(state.quantities[p.sku]) > 0)
    .map(p => ({
      item_no: p.item_no,
      sku: p.sku,
      name: p.name,
      category: p.category,
      unit: p.unit,
      pack_size: p.pack_size,
      qty: Number(state.quantities[p.sku]),
    }));
}

async function submitOrder() {
  showSubmitError("");
  showSubmitSuccess("");

  if (CONFIG.REQUIRE_TOKEN && !TOKEN) {
    showSubmitError("Missing security token. Please use the authorized order link.");
    return;
  }

  const metaErr = validateMeta();
  if (metaErr) { showSubmitError(metaErr); return; }

  const items = selectedItemsPayload();
  if (items.length === 0) { showSubmitError("No items selected."); return; }

  const payload = {
    token: TOKEN || undefined,
    store: state.meta.store,
    placed_by: state.meta.placed_by,
    email: state.meta.email,
    requested_date: state.meta.requested_date,
    notes: state.meta.notes,
    items,
    client: {
      userAgent: navigator.userAgent,
      ts: nowIso(),
    },
  };

  ui.submitBtn.disabled = true;
  ui.submitBtn.textContent = "Submitting...";

  try {
    const res = await fetch(CONFIG.POST_ORDER(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Apps Script sometimes returns 302/HTML if not configured; handle gracefully
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not json */ }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!data || data.ok !== true) {
      // If doPost not implemented yet, you’ll likely end up here
      throw new Error((data && data.error) ? data.error : `Unexpected response: ${text.slice(0, 200)}`);
    }

    const orderId = data.order_id || "(no id)";
    showSubmitSuccess(`Order submitted successfully. Order ID: ${orderId}`);

    // Reset quantities after success
    state.quantities = {};
    state.dirty = false;
    saveCache();

  } catch (err) {
    showSubmitError(
      "Submit failed. This is expected until your Apps Script has doPost() to accept orders. " +
      `Details: ${String(err)}`
    );
    if (DEBUG) console.error(err);
  } finally {
    ui.submitBtn.disabled = false;
    ui.submitBtn.textContent = "Submit Order";
  }
}

// =========================
// EVENTS
// =========================
function wireEvents() {
  ui.refreshBtn?.addEventListener("click", () => refreshCatalog());

  ui.reviewBtn?.addEventListener("click", showReview);
  ui.backToCategories?.addEventListener("click", () => {
    state.selectedCategory = "";
    showCatalog();
  });

  ui.editBtn?.addEventListener("click", backToWizard);
  ui.submitBtn?.addEventListener("click", submitOrder);

  ui.itemList?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    const control = btn.closest(".qtyControl");
    const sku = control?.dataset?.sku;
    if (!sku) return;

    const current = getQty(sku);
    const action = btn.dataset.action;
    const next = action === "increment" ? current + 1 : current - 1;
    const updated = Math.max(0, next);
    setQty(sku, updated);
    const input = control.querySelector(".qtyInput");
    if (input) input.value = updated > 0 ? String(updated) : "";
    showError("");
  });

  ui.itemList?.addEventListener("input", (event) => {
    const input = event.target.closest(".qtyInput");
    if (!input) return;
    const control = input.closest(".qtyControl");
    const sku = control?.dataset?.sku;
    if (!sku) return;

    const parsed = parseQtyInput(input.value);
    if (parsed === null) {
      if (String(input.value || "").trim() === "") {
        setQty(sku, 0);
        showError("");
      } else {
        showError("Quantity must be a number.");
      }
      return;
    }
    setQty(sku, parsed);
    input.value = parsed > 0 ? String(parsed) : "";
    showError("");
  });

  // Mark dirty if meta changes
  const markDirty = () => { state.dirty = true; syncMetaFromInputs(); };
  ui.store?.addEventListener("input", markDirty);
  ui.requestedDate?.addEventListener("change", markDirty);
  ui.placedBy?.addEventListener("input", markDirty);
  ui.email?.addEventListener("input", markDirty);
  ui.notes?.addEventListener("input", markDirty);

  // Online/offline indicator
  window.addEventListener("online", updateNetStatus);
  window.addEventListener("offline", updateNetStatus);
}

// =========================
// INIT
// =========================
function init() {
  loadCache();
  buildSteps();
  wireEvents();
  updateNetStatus();
  showCatalog();

  // If store is locked by URL param, keep it locked
  if (STORE_LOCK && ui.store) {
    ui.store.value = STORE_LOCK;
    ui.store.setAttribute("disabled", "disabled");
  }

  // If cache is stale or empty, try a background refresh
  const hasCatalog = state.products.length > 0;
  if (!hasCatalog || isCacheStale()) {
    refreshCatalog({ force: true });
  }
}

init();
