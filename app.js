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
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbw6ogE8v1_hlV1iCGhPGo0SpDzlzzVYNrjQ8rNk2e7lgQos66GBp_JBazt3_g7H4tCz/exec",

  // Endpoints
  GET_CATEGORIES: (t) => `${CONFIG.SCRIPT_URL}?action=categories&t=${t}`,
  GET_PRODUCTS: (t) => `${CONFIG.SCRIPT_URL}?action=products&t=${t}`,

  // POST URL is the same /exec (Apps Script doPost)
  POST_ORDER: () => `${CONFIG.SCRIPT_URL}`,
  GET_ORDERS: (t) => `${CONFIG.SCRIPT_URL}?action=orders&t=${t}`,

  // Behavior
  CACHE_TTL_MS: 1000 * 60 * 60 * 12, // 12 hours (soft)
  CONFIRM_REFRESH_IF_DIRTY: true,
  AUTOFOCUS_QTY: true,
  HIDE_EMPTY_CATEGORIES: true,
  REQUIRE_TOKEN: false,

  // Validation
  MAX_QTY: 9999,
  QTY_SELECT_MAX: 50,
  REPORT_REFRESH_MS: 1000 * 60 * 5,

  // If your stores are fixed, put them here (optional). If empty, free-text store entry.
  STORES: [], // e.g. ["Boniface", "Huffman", "Muldoon", "Lake Otis", "Camelot"]
};

// =========================
// URL PARAMS / TOKEN
// =========================
const urlParams = new URLSearchParams(window.location.search);
const TOKEN = urlParams.get("token") || "";                 // optional shared key / store token
const STORE_LOCK = urlParams.get("store") || "";            // optional store prefill/lock
const VIEW = (urlParams.get("view") || "").toLowerCase();
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
  ORDERS: "orderportal_orders_v1",
  ORDERS_UPDATED_AT: "orderportal_orders_updated_at_v1",
};

// =========================
// DOM HELPERS
// =========================
const $ = (id) => document.getElementById(id);
const ui = {
  homeScreen: $("homeScreen"),
  orderApp: $("orderApp"),
  homeOrder: $("homeOrder"),
  homeDrivers: $("homeDrivers"),
  homeHistory: $("homeHistory"),
  homeReports: $("homeReports"),
  homeButton: $("homeButton"),
  lastUpdated: $("lastUpdated"),
  refreshBtn: $("refreshBtn"),
  orderTabBtn: $("orderTabBtn"),
  reportsTabBtn: $("reportsTabBtn"),
  store: $("store"),
  requestedDate: $("requestedDate"),
  placedBy: $("placedBy"),
  email: $("email"),
  notes: $("notes"),

  orderPanel: $("orderPanel"),
  wizard: $("wizard"),
  review: $("review"),
  reportsPanel: $("reports"),

  pillCategory: $("pillCategory"),
  productName: $("productName"),
  productMeta: $("productMeta"),
  progressText: $("progressText"),
  selectedText: $("selectedText"),
  backBtn: $("backBtn"),
  nextBtn: $("nextBtn"),
  reviewBtn: $("reviewBtn"),
  errorBox: $("errorBox"),

  reviewList: $("reviewList"),
  editBtn: $("editBtn"),
  submitBtn: $("submitBtn"),
  submitError: $("submitError"),
  submitSuccess: $("submitSuccess"),
  todayOrdersList: $("todayOrdersList"),

  // Optional extras
  netStatus: $("netStatus"),

  reportHistoryCount: $("reportHistoryCount"),
  reportStatus: $("reportStatus"),
  reportTopStore: $("reportTopStore"),
  refreshReportsBtn: $("refreshReportsBtn"),
  reportProduct: $("reportProduct"),
  reportStore: $("reportStore"),
  reportDay: $("reportDay"),
  reportMonth: $("reportMonth"),
  reportYear: $("reportYear"),
  reportSort: $("reportSort"),
  reportStoreBody: $("reportStoreBody"),
  reportStoreEmpty: $("reportStoreEmpty"),
  compareScope: $("compareScope"),
  compareProduct: $("compareProduct"),
  compareCategory: $("compareCategory"),
  compareProductField: $("compareProductField"),
  compareCategoryField: $("compareCategoryField"),
  compareStart: $("compareStart"),
  compareEnd: $("compareEnd"),
  compareSort: $("compareSort"),
  compareHead: $("compareHead"),
  compareBody: $("compareBody"),
  compareEmpty: $("compareEmpty"),
  compareRangeHint: $("compareRangeHint"),
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
  orders: [],
  ordersUpdatedAt: "",
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
  orders: [],
  reports: {
    product: "",
    store: "all",
    day: "",
    month: "",
    year: "",
    compareProduct: "",
    compareCategory: "",
    compareScope: "product",
    compareStart: "",
    compareEnd: "",
    sort: "qty-desc",
    compareSort: "qty-desc",
  },
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

function normalizeOrderRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const normalized = normalizeRowKeys(row);
    const items = Array.isArray(row.items) ? row.items : normalized.items;
    const normalizedItems = Array.isArray(items)
      ? items.map((item) => {
        const normalizedItem = normalizeRowKeys(item);
        return {
          sku: normalizedItem.sku || item.sku || "",
          item_no: normalizedItem.item_no || item.item_no || "",
          name: normalizedItem.name || item.name || "",
          qty: Number(normalizedItem.qty ?? item.qty ?? 0) || 0,
        };
      })
      : [];
    return {
      id: normalized.id || row.id || `remote-${Math.random().toString(36).slice(2)}`,
      store: normalized.store || row.store || "",
      requested_date: normalized.requested_date || row.requested_date || "",
      placed_by: normalized.placed_by || row.placed_by || "",
      items: normalizedItems,
      created_at: normalized.created_at || row.created_at || "",
    };
  });
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

function showHome() {
  setHidden(ui.homeScreen, false);
  setHidden(ui.orderApp, true);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function showOrderApp() {
  setHidden(ui.homeScreen, true);
  setHidden(ui.orderApp, false);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function isFiniteInt(n) {
  return Number.isFinite(n) && Math.floor(n) === n;
}

function parseDateValue(value) {
  if (!value) return null;
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function isSameDay(a, b) {
  return a && b
    && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatShortDate(date) {
  if (!date) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateRange(start, end) {
  if (start && end) return `${formatShortDate(start)} – ${formatShortDate(end)}`;
  if (start) return `From ${formatShortDate(start)}`;
  if (end) return `Up to ${formatShortDate(end)}`;
  return "";
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function isWithinRange(date, start, end) {
  if (!date) return false;
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
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
  const orders = safeJsonParse(localStorage.getItem(CACHE.ORDERS) || "[]", []);
  const ordersUpdatedAt = localStorage.getItem(CACHE.ORDERS_UPDATED_AT) || "";
  const updatedAt = localStorage.getItem(CACHE.UPDATED_AT) || "";
  const cachedAt = localStorage.getItem(CACHE.CACHED_AT) || "";

  if (Array.isArray(cats) && cats.length) state.categories = cats;
  if (Array.isArray(prods) && prods.length) state.products = prods;
  if (qtys && typeof qtys === "object") state.quantities = qtys;
  if (Array.isArray(orders)) state.orders = orders;
  state.ordersUpdatedAt = ordersUpdatedAt;
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

function loadOrders() {
  const orders = safeJsonParse(localStorage.getItem(CACHE.ORDERS) || "[]", []);
  state.orders = Array.isArray(orders) ? orders : [];
}

function saveOrders() {
  localStorage.setItem(CACHE.ORDERS, JSON.stringify(state.orders));
}

function todayOrders() {
  const today = todayDateValue();
  return state.orders.filter((order) => order.requested_date === today);
}

function renderTodayOrders() {
  if (!ui.todayOrdersList) return;
  const orders = todayOrders();
  ui.todayOrdersList.innerHTML = "";

  if (orders.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emptyState";
    empty.textContent = "No orders placed yet for today.";
    ui.todayOrdersList.appendChild(empty);
    return;
  }

  orders.forEach((order) => {
    const row = document.createElement("div");
    row.className = "orderRow";

    const details = document.createElement("div");
    details.className = "orderRow__details";
    details.innerHTML = `
      <div class="orderRow__title">${escapeHtml(order.store || "Unknown Store")}</div>
      <div class="orderRow__meta">${escapeHtml(order.placed_by || "Unknown")}</div>
    `;

    const status = document.createElement("div");
    const ready = order.delivery?.status === "ready";
    status.className = ready ? "statusBadge" : "statusBadge statusBadge--pending";
    status.textContent = ready ? "✓ Ready for delivery" : "In progress";

    row.appendChild(details);
    row.appendChild(status);
    ui.todayOrdersList.appendChild(row);
  });
}

function createLocalOrderRecord(payload, items) {
  const id = `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return {
    id,
    store: payload.store,
    placed_by: payload.placed_by,
    requested_date: payload.requested_date,
    notes: payload.notes || "",
    created_at: nowIso(),
    items: items.map((item) => ({ ...item })),
    delivery: {
      status: "pending",
      items: {},
    },
  };
}

function storeLocalOrder(order) {
  state.orders.unshift(order);
  saveOrders();
  renderTodayOrders();
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

function buildQtySelectOptions(currentQty) {
  const selectedQty = Number(currentQty) || 0;
  const options = [];
  for (let i = 0; i <= CONFIG.QTY_SELECT_MAX; i++) {
    const isSelected = i === selectedQty ? " selected" : "";
    options.push(`<option value="${i}"${isSelected}>${i}</option>`);
  }
  if (selectedQty > CONFIG.QTY_SELECT_MAX) {
    options.push(`<option value="${selectedQty}" selected>${selectedQty}</option>`);
  }
  return options.join("");
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
      <div class="qtyControl">
        <label class="qtyLabel" for="qty-${escapeHtml(item.sku)}">Qty</label>
        <select class="qtySelect" id="qty-${escapeHtml(item.sku)}" data-sku="${escapeHtml(item.sku)}">
          ${buildQtySelectOptions(qty)}
        </select>
      </div>
    `;
    ui.itemList.appendChild(card);
  });

  renderSelectedSummary();
}

function renderWizard() {
  renderSelectedSummary();
  setHidden(ui.review, true);
  if (state.selectedCategory) {
    showItems();
  } else {
    showCatalog();
  }
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
    updateReportOptions();
    renderWizard();
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
// REPORTS
// =========================
function setReportStatus(message) {
  if (!ui.reportStatus) return;
  ui.reportStatus.textContent = message;
}

function isReportDataStale() {
  if (!state.ordersUpdatedAt) return true;
  const last = new Date(state.ordersUpdatedAt);
  if (Number.isNaN(last.getTime())) return true;
  return (Date.now() - last.getTime()) > CONFIG.REPORT_REFRESH_MS;
}

async function refreshReports({ force = false } = {}) {
  if (!CONFIG.SCRIPT_URL || CONFIG.SCRIPT_URL.includes("PASTE_")) {
    setReportStatus("History: unavailable (missing Apps Script URL).");
    return;
  }

  if (!navigator.onLine && !force) {
    setReportStatus("History: offline, using cached data.");
    return;
  }

  if (ui.refreshReportsBtn) {
    ui.refreshReportsBtn.disabled = true;
    ui.refreshReportsBtn.textContent = "Refreshing...";
  }

  try {
    const t = Date.now();
    const ordersResp = await fetchJson(CONFIG.GET_ORDERS(t));
    if (!ordersResp.ok) throw new Error(ordersResp.error || "Orders endpoint failed");
    const orders = normalizeOrderRows(ordersResp.orders || []);
    state.orders = orders;
    const iso = nowIso();
    state.ordersUpdatedAt = iso;
    localStorage.setItem(CACHE.ORDERS, JSON.stringify(state.orders));
    localStorage.setItem(CACHE.ORDERS_UPDATED_AT, iso);
    setReportStatus(`History: ${new Date(iso).toLocaleString()}`);
    updateReportOptions();
    renderReports();
  } catch (err) {
    setReportStatus(`History: using cached data. (${String(err)})`);
  } finally {
    if (ui.refreshReportsBtn) {
      ui.refreshReportsBtn.disabled = false;
      ui.refreshReportsBtn.textContent = "Refresh Reports";
    }
  }
}

function setActiveTab(tab) {
  state.activeTab = tab === "reports" ? "reports" : "order";
  setHidden(ui.orderPanel, state.activeTab !== "order");
  setHidden(ui.reportsPanel, state.activeTab !== "reports");

  if (ui.orderTabBtn) ui.orderTabBtn.classList.toggle("is-active", state.activeTab === "order");
  if (ui.reportsTabBtn) ui.reportsTabBtn.classList.toggle("is-active", state.activeTab === "reports");

  if (state.activeTab === "reports") {
    if (state.ordersUpdatedAt) {
      setReportStatus(`History: ${new Date(state.ordersUpdatedAt).toLocaleString()}`);
    } else {
      setReportStatus("History: not loaded");
    }
    updateReportOptions();
    renderReports();
    if (!state.orders.length || isReportDataStale()) {
      refreshReports();
    }
  }
}

function normalizeProductKey(value) {
  return String(value || "").trim();
}

function buildSelectOptions(select, options, selectedValue) {
  if (!select) return;
  select.innerHTML = "";
  options.forEach((option) => {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    select.appendChild(el);
  });
  if (selectedValue !== undefined && selectedValue !== null) {
    select.value = selectedValue;
  }
}

function getStoreList() {
  const stores = new Set(CONFIG.STORES || []);
  state.orders.forEach((order) => {
    if (order && order.store) stores.add(order.store);
  });
  return Array.from(stores).sort((a, b) => a.localeCompare(b));
}

function getProductMap() {
  const map = new Map();
  state.products.forEach((product) => {
    const key = product.sku || product.item_no || product.name;
    if (!key) return;
    map.set(key, product.name || product.sku || key);
  });
  state.orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const key = item.sku || item.item_no || item.name;
      if (!key || map.has(key)) return;
      map.set(key, item.name || key);
    });
  });
  return map;
}

function getCategoryMap() {
  const map = new Map();
  state.categories.forEach((category) => {
    const key = category.category || category.display_name;
    if (!key) return;
    map.set(key, category.display_name || key);
  });
  state.products.forEach((product) => {
    if (!product.category || map.has(product.category)) return;
    map.set(product.category, product.category);
  });
  state.orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      if (!item.category || map.has(item.category)) return;
      map.set(item.category, item.category);
    });
  });
  return map;
}

function updateReportOptions() {
  const stores = getStoreList();
  buildSelectOptions(
    ui.reportStore,
    [{ value: "all", label: "All stores" }, ...stores.map((store) => ({ value: store, label: store }))],
    state.reports.store
  );

  const productMap = getProductMap();
  const productOptions = [{ value: "", label: "Select a product" }];
  productMap.forEach((label, value) => productOptions.push({ value, label }));
  buildSelectOptions(ui.reportProduct, productOptions, state.reports.product);
  buildSelectOptions(ui.compareProduct, productOptions, state.reports.compareProduct);

  const categoryMap = getCategoryMap();
  const categoryOptions = [{ value: "", label: "Select a category" }];
  categoryMap.forEach((label, value) => categoryOptions.push({ value, label }));
  buildSelectOptions(ui.compareCategory, categoryOptions, state.reports.compareCategory);

  const years = new Set();
  state.orders.forEach((order) => {
    const date = parseDateValue(order.requested_date);
    if (date) years.add(date.getFullYear());
  });
  const yearOptions = [{ value: "", label: "All years" }];
  Array.from(years).sort((a, b) => b - a).forEach((year) => {
    yearOptions.push({ value: String(year), label: String(year) });
  });
  buildSelectOptions(ui.reportYear, yearOptions, state.reports.year);

  if (ui.reportHistoryCount) {
    ui.reportHistoryCount.textContent = String(state.orders.length);
  }

  if (ui.reportTopStore) {
    ui.reportTopStore.textContent = "—";
  }
}

function syncReportFiltersFromInputs() {
  if (!ui.reportProduct) return;
  state.reports.product = normalizeProductKey(ui.reportProduct.value);
  state.reports.store = ui.reportStore?.value || "all";
  state.reports.day = ui.reportDay?.value || "";
  state.reports.month = ui.reportMonth?.value || "";
  state.reports.year = ui.reportYear?.value || "";
  state.reports.compareProduct = normalizeProductKey(ui.compareProduct?.value);
  state.reports.compareCategory = ui.compareCategory?.value || "";
  state.reports.compareScope = ui.compareScope?.value || state.reports.compareScope;
  state.reports.compareStart = ui.compareStart?.value || "";
  state.reports.compareEnd = ui.compareEnd?.value || "";
  state.reports.sort = ui.reportSort?.value || state.reports.sort;
  state.reports.compareSort = ui.compareSort?.value || state.reports.compareSort;
}

function passesDateFilters(orderDate, filters) {
  if (!orderDate) return false;
  const dayDate = parseDateValue(filters.day);
  if (dayDate) return isSameDay(orderDate, dayDate);

  const monthNum = filters.month ? Number(filters.month) : null;
  const yearNum = filters.year ? Number(filters.year) : null;
  if (yearNum && orderDate.getFullYear() !== yearNum) return false;
  if (monthNum && orderDate.getMonth() + 1 !== monthNum) return false;
  return true;
}

function itemMatchesProduct(item, productKey) {
  if (!productKey) return false;
  return item.sku === productKey || item.item_no === productKey || item.name === productKey;
}

function itemMatchesCategory(item, categoryKey) {
  if (!categoryKey) return false;
  return normalizeKey(item.category) === normalizeKey(categoryKey);
}

function updateCompareScopeUI() {
  const isCategory = state.reports.compareScope === "category";
  setHidden(ui.compareProductField, isCategory);
  setHidden(ui.compareCategoryField, !isCategory);
}

function sortStores(stores, totals, sortKey) {
  const list = Array.from(stores);
  const compareQty = (a, b) => (totals.get(b) || 0) - (totals.get(a) || 0);
  const compareQtyAsc = (a, b) => (totals.get(a) || 0) - (totals.get(b) || 0);
  const compareNameAsc = (a, b) => a.localeCompare(b);
  const compareNameDesc = (a, b) => b.localeCompare(a);

  switch (sortKey) {
    case "qty-asc":
      return list.sort(compareQtyAsc);
    case "store-desc":
      return list.sort(compareNameDesc);
    case "store-asc":
      return list.sort(compareNameAsc);
    case "qty-desc":
    default:
      return list.sort(compareQty);
  }
}

function renderReports() {
  if (!ui.reportsPanel) return;
  syncReportFiltersFromInputs();
  updateCompareScopeUI();

  const { product, store, day, month, year, sort } = state.reports;
  const storeTotals = new Map();
  const stores = getStoreList();
  stores.forEach((storeName) => storeTotals.set(storeName, 0));

  const showProductTotals = !!product;
  if (showProductTotals) {
    state.orders.forEach((order) => {
      if (!order || !order.requested_date) return;
      const orderDate = parseDateValue(order.requested_date);
      if (!passesDateFilters(orderDate, { day, month, year })) return;
      if (store !== "all" && order.store !== store) return;

      (order.items || []).forEach((item) => {
        if (!itemMatchesProduct(item, product)) return;
        const current = storeTotals.get(order.store) || 0;
        const qty = Number(item.qty) || 0;
        storeTotals.set(order.store, current + qty);
      });
    });
  }

  if (ui.reportStoreBody) {
    ui.reportStoreBody.innerHTML = "";
    if (showProductTotals && stores.length) {
      const rows = sortStores(
        store === "all" ? stores : stores.filter((name) => name === store),
        storeTotals,
        sort
      );
      rows.forEach((storeName) => {
        const row = document.createElement("tr");
        const nameCell = document.createElement("td");
        nameCell.textContent = storeName;
        const qtyCell = document.createElement("td");
        qtyCell.textContent = String(storeTotals.get(storeName) || 0);
        row.appendChild(nameCell);
        row.appendChild(qtyCell);
        ui.reportStoreBody.appendChild(row);
      });
    }
  }

  setHidden(ui.reportStoreEmpty, showProductTotals && stores.length);
  if (ui.reportStoreEmpty && !showProductTotals) {
    ui.reportStoreEmpty.textContent = "Select a product and timeframe to see totals.";
  } else if (ui.reportStoreEmpty && !stores.length) {
    ui.reportStoreEmpty.textContent = "No order history yet. Submit orders to populate reports.";
  }

  const compareProduct = state.reports.compareProduct;
  const compareCategory = state.reports.compareCategory;
  const compareScope = state.reports.compareScope;
  const compareSort = state.reports.compareSort;
  const compareStart = parseDateValue(state.reports.compareStart);
  const compareEnd = parseDateValue(state.reports.compareEnd);
  const compareTarget = compareScope === "category" ? compareCategory : compareProduct;
  let compareValid = !!compareTarget;
  if (compareValid && compareStart && compareEnd && compareStart > compareEnd) {
    compareValid = false;
    if (ui.compareEmpty) ui.compareEmpty.textContent = "Start date must be before end date.";
  } else if (ui.compareEmpty) {
    ui.compareEmpty.textContent = "Select a product or category to compare stores.";
  }

  const now = new Date();
  const lastMonthAnchor = addMonths(now, -1);
  const lastMonthStart = startOfMonth(lastMonthAnchor);
  const lastMonthEnd = endOfMonth(lastMonthAnchor);
  const lastQuarterEnd = endOfMonth(addMonths(now, -1));
  const lastQuarterStart = startOfMonth(addMonths(now, -3));
  const lastYearStart = new Date(now.getFullYear() - 1, 0, 1);
  const lastYearEnd = new Date(now.getFullYear() - 1, 11, 31);
  const customLabel = formatDateRange(compareStart, compareEnd) || "Set a custom range";
  const frames = [
    {
      key: "lastMonth",
      label: "Last month",
      rangeLabel: formatDateRange(lastMonthStart, lastMonthEnd),
      start: lastMonthStart,
      end: lastMonthEnd,
      active: true,
    },
    {
      key: "lastQuarter",
      label: "Last quarter",
      rangeLabel: formatDateRange(lastQuarterStart, lastQuarterEnd),
      start: lastQuarterStart,
      end: lastQuarterEnd,
      active: true,
    },
    {
      key: "lastYear",
      label: "Last year",
      rangeLabel: formatDateRange(lastYearStart, lastYearEnd),
      start: lastYearStart,
      end: lastYearEnd,
      active: true,
    },
    {
      key: "custom",
      label: "Custom range",
      rangeLabel: customLabel,
      start: compareStart,
      end: compareEnd,
      active: !!(compareStart || compareEnd),
    },
  ];

  if (ui.compareRangeHint) {
    ui.compareRangeHint.textContent = "Timeframes use calendar periods. Custom range uses the start/end dates above.";
  }

  const compareTotals = new Map();
  stores.forEach((storeName) => {
    const totals = {};
    frames.forEach((frame) => { totals[frame.key] = 0; });
    compareTotals.set(storeName, totals);
  });

  if (compareValid) {
    state.orders.forEach((order) => {
      if (!order || !order.requested_date) return;
      const orderDate = parseDateValue(order.requested_date);
      if (!orderDate) return;
      if (!stores.includes(order.store)) return;

      let matchedQty = 0;
      (order.items || []).forEach((item) => {
        const match = compareScope === "category"
          ? itemMatchesCategory(item, compareTarget)
          : itemMatchesProduct(item, compareTarget);
        if (!match) return;
        matchedQty += Number(item.qty) || 0;
      });
      if (!matchedQty) return;

      frames.forEach((frame) => {
        if (!frame.active) return;
        if (!isWithinRange(orderDate, frame.start, frame.end)) return;
        const totals = compareTotals.get(order.store);
        if (totals) totals[frame.key] += matchedQty;
      });
    });
  }

  const primaryFrame = frames.find((frame) => frame.key === "custom" && frame.active) || frames[0];
  const sortTotals = new Map();
  stores.forEach((storeName) => {
    const totals = compareTotals.get(storeName);
    sortTotals.set(storeName, totals ? totals[primaryFrame.key] : 0);
  });

  if (ui.compareHead) {
    ui.compareHead.innerHTML = "";
    const headRow = document.createElement("tr");
    const storeHead = document.createElement("th");
    storeHead.textContent = "Store";
    headRow.appendChild(storeHead);
    frames.forEach((frame) => {
      const th = document.createElement("th");
      const title = document.createElement("div");
      title.className = "table__headTitle";
      title.textContent = frame.label;
      const sub = document.createElement("div");
      sub.className = "table__headSub";
      sub.textContent = frame.rangeLabel;
      th.appendChild(title);
      th.appendChild(sub);
      headRow.appendChild(th);
    });
    ui.compareHead.appendChild(headRow);
  }

  if (ui.compareBody) {
    ui.compareBody.innerHTML = "";
    if (compareValid && stores.length) {
      const sortedStores = sortStores(stores, sortTotals, compareSort);
      sortedStores.forEach((storeName) => {
        const row = document.createElement("tr");
        const nameCell = document.createElement("td");
        nameCell.textContent = storeName;
        row.appendChild(nameCell);
        frames.forEach((frame) => {
          const qtyCell = document.createElement("td");
          if (!frame.active) {
            qtyCell.textContent = "—";
            qtyCell.className = "table__cellMuted";
          } else {
            const totals = compareTotals.get(storeName) || {};
            qtyCell.textContent = String(totals[frame.key] || 0);
          }
          row.appendChild(qtyCell);
        });
        ui.compareBody.appendChild(row);
      });
      if (ui.reportTopStore) {
        const topStore = sortStores(stores, sortTotals, "qty-desc")[0];
        ui.reportTopStore.textContent = topStore
          ? `${topStore} (${sortTotals.get(topStore) || 0})`
          : "—";
      }
    }
  }

  setHidden(ui.compareEmpty, compareValid && stores.length);
  if (ui.compareEmpty && !stores.length) {
    ui.compareEmpty.textContent = "No order history yet. Submit orders to populate reports.";
  }
  if (ui.reportTopStore && !compareValid) {
    ui.reportTopStore.textContent = "—";
  }
}

function recordOrderHistory(payload, orderId) {
  const entry = {
    id: orderId || `local-${Date.now()}`,
    store: payload.store,
    requested_date: payload.requested_date,
    placed_by: payload.placed_by,
    items: payload.items || [],
    created_at: nowIso(),
  };
  state.orders.push(entry);
  localStorage.setItem(CACHE.ORDERS, JSON.stringify(state.orders));
  updateReportOptions();
  renderReports();
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
    timestamp: nowIso(),
    email: state.meta.email,
    requested_date: state.meta.requested_date,
    notes: state.meta.notes,
    items,
    client: {
      userAgent: navigator.userAgent,
      ts: nowIso(),
    },
  };

  const localOrder = createLocalOrderRecord(payload, items);
  storeLocalOrder(localOrder);

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
    recordOrderHistory(payload, orderId);
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
  ui.homeOrder?.addEventListener("click", () => {
    setActiveTab("order");
    showOrderApp();
  });

  ui.homeDrivers?.addEventListener("click", () => {
    window.location.href = "delivery.html";
  });

  ui.homeHistory?.addEventListener("click", () => {
    window.location.href = "history.html";
  });

  ui.homeReports?.addEventListener("click", () => {
    showOrderApp();
    setActiveTab("reports");
  });

  ui.homeButton?.addEventListener("click", showHome);

  ui.topMenuRefresh?.addEventListener("click", () => {
    refreshCatalog();
    setHidden(ui.topMenuList, true);
  });

  ui.refreshBtn?.addEventListener("click", () => refreshCatalog());
  ui.orderTabBtn?.addEventListener("click", () => setActiveTab("order"));
  ui.reportsTabBtn?.addEventListener("click", () => setActiveTab("reports"));

  ui.reviewBtn?.addEventListener("click", showReview);
  ui.backToCategories?.addEventListener("click", () => {
    state.selectedCategory = "";
    showCatalog();
  });

  ui.editBtn?.addEventListener("click", backToWizard);
  ui.submitBtn?.addEventListener("click", submitOrder);

  ui.itemList?.addEventListener("change", (event) => {
    const select = event.target.closest(".qtySelect");
    if (!select) return;
    const sku = select.dataset.sku;
    if (!sku) return;
    const qty = Number(select.value);
    if (!Number.isFinite(qty)) return;
    setQty(sku, qty);
    showError("");
  });

  // Mark dirty if meta changes
  const markDirty = () => { state.dirty = true; syncMetaFromInputs(); };
  ui.store?.addEventListener("input", markDirty);
  ui.requestedDate?.addEventListener("change", markDirty);
  ui.placedBy?.addEventListener("input", markDirty);
  ui.email?.addEventListener("input", markDirty);
  ui.notes?.addEventListener("input", markDirty);

  const rerenderReports = () => renderReports();
  ui.reportProduct?.addEventListener("change", rerenderReports);
  ui.reportStore?.addEventListener("change", rerenderReports);
  ui.reportMonth?.addEventListener("change", rerenderReports);
  ui.reportYear?.addEventListener("change", rerenderReports);
  ui.reportDay?.addEventListener("change", rerenderReports);
  ui.reportSort?.addEventListener("change", rerenderReports);
  ui.compareScope?.addEventListener("change", rerenderReports);
  ui.compareProduct?.addEventListener("change", rerenderReports);
  ui.compareCategory?.addEventListener("change", rerenderReports);
  ui.compareStart?.addEventListener("change", rerenderReports);
  ui.compareEnd?.addEventListener("change", rerenderReports);
  ui.compareSort?.addEventListener("change", rerenderReports);
  ui.refreshReportsBtn?.addEventListener("click", () => refreshReports({ force: true }));

  // Optional: category jump toggle
  ui.categoryJumpBtn?.addEventListener("click", () => {
    if (!ui.categoryJumpMenu) return;
    ui.categoryJumpMenu.hidden = !ui.categoryJumpMenu.hidden;
  });

  window.addEventListener("storage", (event) => {
    if (event.key === CACHE.ORDERS) {
      loadOrders();
      renderTodayOrders();
    }
  });

  // Online/offline indicator
  window.addEventListener("online", updateNetStatus);
  window.addEventListener("offline", updateNetStatus);

  window.addEventListener("storage", (event) => {
    if (event.key === CACHE.ORDERS) {
      loadOrders();
      renderTodayOrders();
    }
  });

  window.addEventListener("focus", () => {
    loadOrders();
    renderTodayOrders();
  });
}

// =========================
// INIT
// =========================
function init() {
  loadCache();
  loadOrders();
  buildSteps();
  wireEvents();
  updateNetStatus();
  renderWizard();
  renderTodayOrders();

  // If store is locked by URL param, keep it locked
  if (STORE_LOCK && ui.store) {
    ui.store.value = STORE_LOCK;
    ui.store.setAttribute("disabled", "disabled");
  }

  if (VIEW === "order") {
    showOrderApp();
  }
  if (VIEW === "reports") {
    showOrderApp();
    setActiveTab("reports");
  }

  // If cache is stale or empty, try a background refresh
  const hasCatalog = state.products.length > 0;
  if (!hasCatalog || isCacheStale()) {
    refreshCatalog({ force: true });
  }
}

init();
