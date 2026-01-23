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
 * - Optional store lock via URL ?store=Boniface
 * - Basic input validation and error surfaces
 *
 * Required HTML element IDs expected (matches index.html):
 * lastUpdated, refreshBtn, store, requestedDate, placedBy, notes,
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
  // Behavior
  CACHE_TTL_MS: 1000 * 60 * 60 * 12, // 12 hours (soft)
  CONFIRM_REFRESH_IF_DIRTY: true,
  AUTOFOCUS_QTY: true,
  HIDE_EMPTY_CATEGORIES: true,

  // Validation
  MAX_QTY: 9999,
  QTY_SELECT_MAX: 50,
  REPORT_REFRESH_MS: 1000 * 60 * 5,

  // If your stores are fixed, put them here (optional). If empty, free-text store entry.
  STORES: ["MULDOON", "CAMELOT", "BONIFACE", "HUFFMAN", "LAKE OTIS"],
};

// =========================
// URL PARAMS
// =========================
const urlParams = new URLSearchParams(window.location.search);
const STORE_LOCK = urlParams.get("store") || "";            // optional store prefill/lock
const VIEW = (urlParams.get("view") || "").toLowerCase();
const DEBUG = window.DEBUG === true;

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
  topbarHomeBtn: $("topbarHomeBtn"),
  lastUpdated: $("lastUpdated"),
  apiHealth: $("apiHealth"),
  refreshBtn: $("refreshBtn"),
  orderTabBtn: $("orderTabBtn"),
  reportsTabBtn: $("reportsTabBtn"),
  store: $("store"),
  requestedDate: $("requestedDate"),
  placedBy: $("placedBy"),
  notes: $("notes"),
  orderMeta: $("orderMeta"),

  orderPanel: $("orderPanel"),
  wizard: $("wizard"),
  review: $("review"),
  reportsPanel: $("reports"),

  catalog: $("catalog"),
  items: $("items"),
  categoryList: $("categoryList"),
  itemList: $("itemList"),
  selectedSummary: $("selectedSummary"),
  itemsSummary: $("itemsSummary"),
  categoryTitle: $("categoryTitle"),
  categoryMeta: $("categoryMeta"),
  backToCategories: $("backToCategories"),
  backToCategoriesBottom: $("backToCategoriesBottom"),

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
  statusBox: $("statusBox"),
  todayOrdersList: $("todayOrdersList"),

  // Optional extras
  netStatus: $("netStatus"),

  reportHistoryCount: $("reportHistoryCount"),
  reportStatus: $("reportStatus"),
  reportTopStore: $("reportTopStore"),
  refreshReportsBtn: $("refreshReportsBtn"),
  reportModeVolume: $("reportModeVolume"),
  reportModeMissing: $("reportModeMissing"),
  reportVolumePanel: $("reportVolumePanel"),
  reportMissingPanel: $("reportMissingPanel"),
  compareScope: $("compareScope"),
  compareStores: $("compareStores"),
  compareProduct: $("compareProduct"),
  compareCategory: $("compareCategory"),
  compareProductField: $("compareProductField"),
  compareCategoryField: $("compareCategoryField"),
  compareStart: $("compareStart"),
  compareEnd: $("compareEnd"),
  compareSort: $("compareSort"),
  compareGo: $("compareGo"),
  compareHead: $("compareHead"),
  compareBody: $("compareBody"),
  compareEmpty: $("compareEmpty"),
  compareRangeHint: $("compareRangeHint"),
  missingScope: $("missingScope"),
  missingProduct: $("missingProduct"),
  missingCategory: $("missingCategory"),
  missingProductField: $("missingProductField"),
  missingCategoryField: $("missingCategoryField"),
  missingStart: $("missingStart"),
  missingEnd: $("missingEnd"),
  missingSort: $("missingSort"),
  missingGo: $("missingGo"),
  missingStoreTitle: $("missingStoreTitle"),
  missingStoreWrap: $("missingStoreWrap"),
  missingStoreHead: $("missingStoreHead"),
  missingStoreBody: $("missingStoreBody"),
  missingStoreEmpty: $("missingStoreEmpty"),
  missingItemsTitle: $("missingItemsTitle"),
  missingItemsWrap: $("missingItemsWrap"),
  missingItemsHead: $("missingItemsHead"),
  missingItemsBody: $("missingItemsBody"),
  missingItemsEmpty: $("missingItemsEmpty"),
  missingRangeHint: $("missingRangeHint"),
  missingGrandTotal: $("missingGrandTotal"),
  missingGrandTotalWrap: $("missingGrandTotalWrap"),
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
    notes: "",
  },
  dirty: false,     // true if anything changed since last submit/refresh
  lastCatalogIso: "", // when refreshed
  lastCacheIso: "",   // when cached
  categoryIndex: new Map(), // category -> {start, end}
  orders: [],
  reports: {
    mode: "volume",
    compareStores: [],
    compareProduct: "",
    compareCategory: "",
    compareScope: "product",
    compareStart: "",
    compareEnd: "",
    compareSort: "qty-desc",
    missingScope: "product",
    missingProduct: "",
    missingCategory: "",
    missingStart: "",
    missingEnd: "",
    missingSort: "missing-desc",
  },
  activeTab: "order",
  submitting: false,
};

// =========================
// UTIL
// =========================
function log(...args) { if (DEBUG) console.log("[OrderPortal]", ...args); }

function nowIso() {
  const date = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Anchorage",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const offsetMatch = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(parts.timeZoneName || "");
  const rawOffset = offsetMatch ? offsetMatch[1] : "+0";
  const offsetMinutes = offsetMatch && offsetMatch[2] ? offsetMatch[2] : "00";
  const offsetHours = String(Math.abs(Number(rawOffset))).padStart(2, "0");
  const offsetSign = Number(rawOffset) < 0 ? "-" : "+";
  const offset = `${offsetSign}${offsetHours}:${offsetMinutes}`;
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}${offset}`;
}

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
          category: normalizedItem.category || item.category || "",
          unit: normalizedItem.unit || item.unit || "",
          pack_size: normalizedItem.pack_size || item.pack_size || "",
          qty: Number(normalizedItem.qty ?? item.qty ?? 0) || 0,
          status: normalizedItem.status || item.status || "",
        };
      })
      : [];
    return {
      id: normalized.id || normalized.order_id || row.id || row.order_id || `remote-${Math.random().toString(36).slice(2)}`,
      store: normalized.store || row.store || "",
      requested_date: normalized.requested_date || row.requested_date || "",
      placed_by: normalized.placed_by || row.placed_by || "",
      notes: normalized.notes || row.notes || "",
      items: normalizedItems,
      created_at: normalized.created_at || row.created_at || "",
    };
  });
}

function attachItemsToOrders(orders, items) {
  if (!Array.isArray(orders)) return [];
  if (!Array.isArray(items) || items.length === 0) return orders;

  const itemsByOrder = new Map();
  items.forEach((item) => {
    const orderId = String(item.order_id || item.orderId || "").trim();
    if (!orderId) return;
    if (!itemsByOrder.has(orderId)) itemsByOrder.set(orderId, []);
    itemsByOrder.get(orderId).push(item);
  });

  return orders.map((order) => {
    if (Array.isArray(order.items) && order.items.length) return order;
    const orderId = String(order.order_id || order.orderId || order.id || "").trim();
    if (!orderId) return order;
    const orderItems = itemsByOrder.get(orderId) || [];
    return { ...order, items: orderItems };
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

function showGlobalError(message, type = "error") {
  if (message) {
    AppClient.showBanner(message, type);
  } else {
    AppClient.hideBanner();
  }
}

function showSubmitError(msg) {
  setHidden(ui.submitError, !msg);
  setText(ui.submitError, msg || "");
}

function showSubmitSuccess(msg) {
  setHidden(ui.submitSuccess, !msg);
  setText(ui.submitSuccess, msg || "");
}

function setApiHealth(message) {
  if (!ui.apiHealth) return;
  ui.apiHealth.textContent = message;
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
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value === "number") {
    const numericDate = new Date(value);
    return Number.isNaN(numericDate.getTime()) ? null : numericDate;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (isoMatch) {
    const [, year, month, day, hourPart, minutePart] = isoMatch;
    const hours = Number.isFinite(Number(hourPart)) ? Number(hourPart) : 0;
    const minutes = Number.isFinite(Number(minutePart)) ? Number(minutePart) : 0;
    return new Date(Number(year), Number(month) - 1, Number(day), hours, minutes);
  }
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,T](\d{1,2}):(\d{2}))?/);
  if (slashMatch) {
    const [, month, day, yearRaw, hourPart, minutePart] = slashMatch;
    const year = yearRaw.length === 2 ? Number(`20${yearRaw}`) : Number(yearRaw);
    const hours = Number.isFinite(Number(hourPart)) ? Number(hourPart) : 0;
    const minutes = Number.isFinite(Number(minutePart)) ? Number(minutePart) : 0;
    return new Date(year, Number(month) - 1, Number(day), hours, minutes);
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function formatShortDate(date) {
  if (!date) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  const catalogCache = AppClient.loadCatalog?.();
  if (catalogCache) {
    if (Array.isArray(catalogCache.categories)) state.categories = catalogCache.categories;
    if (Array.isArray(catalogCache.products)) state.products = catalogCache.products;
    state.lastCatalogIso = catalogCache.updatedAt || "";
    state.lastCacheIso = catalogCache.cachedAt || "";
  }

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
    notes: state.meta.notes || "",
  };

  if (pos && typeof pos.idx === "number") state.idx = Math.max(0, pos.idx | 0);

  if (!state.lastCatalogIso) state.lastCatalogIso = updatedAt;
  if (!state.lastCacheIso) state.lastCacheIso = cachedAt;

  const catalogTimestamp = state.lastCatalogIso || updatedAt;
  const cacheTimestamp = state.lastCacheIso || cachedAt;
  if (catalogTimestamp) {
    setText(ui.lastUpdated, `Catalog: ${new Date(catalogTimestamp).toLocaleString()}`);
  } else if (cacheTimestamp) {
    setText(ui.lastUpdated, `Catalog: cached ${new Date(cacheTimestamp).toLocaleString()}`);
  } else {
    setText(ui.lastUpdated, "Catalog: not loaded");
  }

  // Apply store lock if present
  if (STORE_LOCK) state.meta.store = STORE_LOCK;
  const today = todayDateValue();
  state.meta.requested_date = today;

  hydrateMetaInputs();
}

function loadOrders() {
  const cachedOrders = AppClient.loadOrders?.();
  if (cachedOrders && Array.isArray(cachedOrders.orders)) {
    const mergedOrders = attachItemsToOrders(cachedOrders.orders, cachedOrders.items || []);
    state.orders = normalizeOrderRows(mergedOrders);
    state.ordersUpdatedAt = cachedOrders.updatedAt || "";
    return;
  }
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
  if (ui.requestedDate) {
    ui.requestedDate.value = state.meta.requested_date || "";
    ui.requestedDate.setAttribute("disabled", "disabled");
    ui.requestedDate.setAttribute("aria-disabled", "true");
  }
  if (ui.placedBy) ui.placedBy.value = state.meta.placed_by || "";
  if (ui.notes) ui.notes.value = state.meta.notes || "";

  // Optional store lock
  if (STORE_LOCK && ui.store) {
    ui.store.value = STORE_LOCK;
    ui.store.setAttribute("disabled", "disabled");
  }
}

function syncMetaFromInputs() {
  if (ui.store) state.meta.store = ui.store.value.trim();
  state.meta.requested_date = todayDateValue();
  if (ui.placedBy) state.meta.placed_by = ui.placedBy.value.trim();
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

function resetQuantitiesForNewOrder() {
  state.quantities = {};
  state.dirty = false;
  saveCache();
  renderSelectedSummary();
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
  const selectedByCategory = new Map();
  state.steps.forEach(item => {
    const qty = getQty(item.sku);
    if (qty <= 0) return;
    if (!selectedByCategory.has(item.category)) {
      selectedByCategory.set(item.category, []);
    }
    selectedByCategory.get(item.category).push({
      name: item.name,
      qty
    });
  });

  const categoriesFromProducts = [...new Set(state.steps.map(p => p.category))];
  const orderedCategories = state.categories.length
    ? state.categories.map(c => c.category)
    : categoriesFromProducts;

  let renderedCount = 0;
  const renderCategoryCard = (category) => {
    if (!category) return;
    const itemCount = counts.get(category) || 0;
    if (!itemCount && CONFIG.HIDE_EMPTY_CATEGORIES) return;
    const catRow = state.categories.find(c => c.category === category);
    const label = catRow?.display_name || category;
    const selectedItems = selectedByCategory.get(category) || [];
    const previewLimit = 2;
    const previewItems = selectedItems.slice(0, previewLimit);
    const remainingCount = Math.max(0, selectedItems.length - previewItems.length);
    const previewHtml = previewItems.map(item => `
      <div class="categoryCard__summaryItem">${escapeHtml(item.name)} x ${item.qty}</div>
    `).join("");
    const moreHtml = remainingCount > 0
      ? `<div class="categoryCard__summaryMore">+${remainingCount} more</div>`
      : "";
    const summaryHtml = selectedItems.length
      ? `<div class="categoryCard__summary">${previewHtml}${moreHtml}</div>`
      : "";
    const card = document.createElement("button");
    card.type = "button";
    card.className = "categoryCard";
    card.innerHTML = `
      <div>${escapeHtml(label)}</div>
      ${summaryHtml}
      <div class="categoryCard__meta">${itemCount} item${itemCount === 1 ? "" : "s"}</div>
    `;
    card.addEventListener("click", () => {
      state.selectedCategory = category;
      showItems();
    });
    ui.categoryList.appendChild(card);
    renderedCount += 1;
  };

  orderedCategories.forEach(renderCategoryCard);

  if (renderedCount === 0 && categoriesFromProducts.length) {
    categoriesFromProducts.forEach(renderCategoryCard);
  }

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
    header.innerHTML = `<div class="reviewItem__name reviewItem__category">${escapeHtml(catLabel)}</div>`;
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

function isCacheStale() {
  const cachedAt = localStorage.getItem(CACHE.CACHED_AT);
  if (!cachedAt) return true;
  const age = Date.now() - new Date(cachedAt).getTime();
  return age > CONFIG.CACHE_TTL_MS;
}

function updateUIAfterRefresh(catalog) {
  const cats = normalizeCategoryRows(catalog.categories || []);
  const prods = normalizeProductRows(catalog.products || []);

  if (!prods.length) {
    throw new Error("No products returned from Google Sheets. Verify your Products sheet has active rows.");
  }

  const previousCategory = state.selectedCategory;
  state.categories = cats;
  state.products = prods;

  buildSteps();
  state.idx = Math.min(state.idx, Math.max(0, state.steps.length - 1));

  const iso = catalog.updatedAt || nowIso();
  state.lastCatalogIso = iso;
  localStorage.setItem(CACHE.UPDATED_AT, iso);
  localStorage.setItem(CACHE.CACHED_AT, iso);
  setText(ui.lastUpdated, `Catalog: ${new Date(iso).toLocaleString()}`);

  saveCache();
  updateReportOptions();
  if (previousCategory && state.categoryIndex.has(previousCategory)) {
    state.selectedCategory = previousCategory;
    showItems();
  } else {
    state.selectedCategory = "";
    showCatalog();
  }

  renderWizard();
  state.dirty = false;
  return { cats, prods };
}

async function refreshCatalog({ force = false, background = false } = {}) {
  showError("");
  showGlobalError("");

  if (CONFIG.CONFIRM_REFRESH_IF_DIRTY && state.dirty && !force && !background) {
    const ok = confirm("Refreshing may reset your position. Continue?");
    if (!ok) return;
  }

  setTopbarRefreshState({
    isLoading: true,
    label: "Refreshing products from Google Sheets",
    text: "Refreshing...",
  });

  try {
    const previousUpdatedAt = state.lastCatalogIso;
    const catalog = await AppClient.refreshCategoriesAndProducts({ force });
    const isUnchanged = Boolean(
      catalog.updatedAt
      && previousUpdatedAt
      && catalog.updatedAt === previousUpdatedAt
    );
    const { cats, prods } = updateUIAfterRefresh(catalog);
    if (!background) {
      if (isUnchanged) {
        AppClient.showToast("Fully Refreshed and Up to Date.", "info");
      } else {
        AppClient.showToast(`Loaded ${cats.length} categories and ${prods.length} products.`, "success");
      }
    }
  } catch (err) {
    const message = `Could not refresh catalog. ${err.userMessage || err.message || err}`;
    const requestUrl = err?.request?.url || AppClient.getBaseUrl();
    const hint = err?.isNetworkError
      ? "Network/CORS/deployment issue likely. Verify the Apps Script /exec URL is publicly accessible."
      : "Check the Apps Script deployment permissions and response payload.";
    const bannerMessage = `${message} ${hint} URL: ${requestUrl}`;
    log("Catalog refresh failed", {
      message,
      request: err?.request,
      responseStatus: err?.response?.status,
      responseText: err?.response?.text,
      isNetworkError: err?.isNetworkError || err?.name === "TypeError",
    });
    showError(message);
    showGlobalError(bannerMessage, "warning");
    AppClient.showToast("Using cached data (if available).", "warning");
    buildSteps();
    if (state.selectedCategory) {
      showItems();
    } else {
      showCatalog();
    }
  } finally {
    updateRefreshButtonLabel();
    setTopbarRefreshState({ isLoading: false });
    refreshApiHealth({ background: true });
  }
}

async function refreshApiHealth({ background = false } = {}) {
  if (!ui.apiHealth) return;
  if (!background) {
    setApiHealth("API: checking…");
  }
  try {
    const data = await AppClient.apiFetch("health", { cacheBust: true, retry: 1 });
    const updatedAt = data.updated_at ? new Date(data.updated_at).toLocaleString() : "OK";
    setApiHealth(`API Health: OK (${updatedAt})`);
  } catch (err) {
    const message = err.userMessage || err.message || "Unavailable";
    const hint = err.isNetworkError ? "Network/CORS/deployment" : message;
    setApiHealth(`API Health: Error (${hint})`);
  }
}

function updateNetStatus() {
  const online = navigator.onLine;
  if (ui.netStatus) {
    ui.netStatus.textContent = online ? "Online" : "Offline";
    ui.netStatus.style.opacity = online ? "0.7" : "1";
  }
  if (!online) {
    showGlobalError("You appear to be offline. Showing cached data until connection is restored.", "warning");
  } else {
    showGlobalError("");
  }
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

function getRefreshLabel() {
  return state.activeTab === "reports"
    ? "Refresh reports from Google Sheets"
    : "Refresh products from Google Sheets";
}

function getRefreshButtonText() {
  return state.activeTab === "reports"
    ? "Refresh Reports"
    : "Refresh Products";
}

function setTopbarRefreshState({ isLoading, label, text } = {}) {
  if (!ui.refreshBtn) return;
  if (typeof isLoading === "boolean") {
    ui.refreshBtn.disabled = isLoading;
    if (isLoading) {
      ui.refreshBtn.setAttribute("aria-busy", "true");
    } else {
      ui.refreshBtn.removeAttribute("aria-busy");
    }
  }
  if (label) {
    ui.refreshBtn.setAttribute("aria-label", label);
    ui.refreshBtn.setAttribute("title", label);
  }
  if (text) {
    ui.refreshBtn.textContent = text;
  }
}

function updateRefreshButtonLabel() {
  setTopbarRefreshState({ label: getRefreshLabel(), text: getRefreshButtonText() });
}

async function refreshReports({ force = false } = {}) {
  if (!navigator.onLine && !force) {
    setReportStatus("History: offline, using cached data.");
    return;
  }

  if (ui.refreshReportsBtn) {
    ui.refreshReportsBtn.disabled = true;
    ui.refreshReportsBtn.textContent = "Refreshing...";
  }
  setTopbarRefreshState({
    isLoading: true,
    label: "Refreshing reports from Google Sheets",
    text: "Refreshing...",
  });

  try {
    const previousUpdatedAt = state.ordersUpdatedAt;
    const ordersResp = await AppClient.refreshOrders({ force });
    const mergedOrders = attachItemsToOrders(ordersResp.orders || [], ordersResp.items || []);
    const orders = normalizeOrderRows(mergedOrders);
    state.orders = orders;
    const responseUpdatedAt = ordersResp.updatedAt || ordersResp.updated_at || "";
    const iso = responseUpdatedAt || nowIso();
    state.ordersUpdatedAt = iso;
    localStorage.setItem(CACHE.ORDERS, JSON.stringify(state.orders));
    localStorage.setItem(CACHE.ORDERS_UPDATED_AT, iso);
    if (ordersResp.source === "cache") {
      const cachedLabel = responseUpdatedAt
        ? `History: cached (${new Date(responseUpdatedAt).toLocaleString()})`
        : "History: cached";
      setReportStatus(cachedLabel);
    } else if (responseUpdatedAt && previousUpdatedAt && responseUpdatedAt === previousUpdatedAt) {
      setReportStatus("History: Fully Updated");
    } else {
      setReportStatus(`History: ${new Date(iso).toLocaleString()}`);
    }
    updateReportOptions();
    renderReports();
    AppClient.showToast(`Loaded ${orders.length} orders from history.`, "success");
  } catch (err) {
    const message = `History: using cached data. (${err.userMessage || err.message || err})`;
    setReportStatus(message);
    showGlobalError(message, "warning");
    AppClient.showToast("History refresh failed. Using cached data.", "warning");
  } finally {
    if (ui.refreshReportsBtn) {
      ui.refreshReportsBtn.disabled = false;
      ui.refreshReportsBtn.textContent = "Refresh Reports";
    }
    updateRefreshButtonLabel();
    setTopbarRefreshState({ isLoading: false });
  }
}

function setActiveTab(tab) {
  state.activeTab = tab === "reports" ? "reports" : "order";
  setHidden(ui.orderPanel, state.activeTab !== "order");
  setHidden(ui.reportsPanel, state.activeTab !== "reports");
  setHidden(ui.orderMeta, state.activeTab === "reports");

  if (ui.orderTabBtn) ui.orderTabBtn.classList.toggle("is-active", state.activeTab === "order");
  if (ui.reportsTabBtn) ui.reportsTabBtn.classList.toggle("is-active", state.activeTab === "reports");

  if (state.activeTab === "reports") {
    if (state.ordersUpdatedAt) {
      setReportStatus(`History: ${new Date(state.ordersUpdatedAt).toLocaleString()}`);
    } else {
      setReportStatus("History: not loaded");
    }
    updateReportOptions();
    setReportMode(state.reports.mode);
    renderReports();
    if (!state.orders.length || isReportDataStale()) {
      refreshReports();
    }
  }

  updateRefreshButtonLabel();
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

function updateMultiSelectToggle(container) {
  const toggle = container?.querySelector(".multiselect__toggle");
  if (!toggle) return;
  const placeholder = container.dataset.placeholder || "Select";
  const selected = getSelectedValues(container);
  if (selected.length === 0) {
    toggle.textContent = placeholder;
    return;
  }
  if (selected.length <= 2) {
    toggle.textContent = selected.join(", ");
    return;
  }
  toggle.textContent = `${selected.length} stores selected`;
}

function setMultiSelectOpen(container, isOpen) {
  if (!container) return;
  const toggle = container.querySelector(".multiselect__toggle");
  container.classList.toggle("is-open", isOpen);
  if (toggle) toggle.setAttribute("aria-expanded", String(isOpen));
}

function buildMultiSelectDropdown(container, options, selectedValues = []) {
  if (!container) return;
  const menu = container.querySelector(".multiselect__menu");
  if (!menu) return;
  const selectedSet = new Set(selectedValues);
  menu.innerHTML = "";
  options.forEach((option) => {
    const label = document.createElement("label");
    label.className = "multiselect__option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = option.value;
    input.checked = selectedSet.has(option.value);
    const text = document.createElement("span");
    text.textContent = option.label;
    label.appendChild(input);
    label.appendChild(text);
    menu.appendChild(label);
  });
  updateMultiSelectToggle(container);
}

function getSelectedValues(select) {
  if (!select) return [];
  if (select instanceof HTMLSelectElement) {
    return Array.from(select.selectedOptions || []).map((option) => option.value);
  }
  return Array.from(select.querySelectorAll("input[type=\"checkbox\"]:checked"))
    .map((input) => input.value);
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

function getReportOrdersWithCatalog() {
  const catalog = AppClient.loadCatalog?.() || null;
  return state.orders.map((order) => {
    const items = AppClient.enrichItemsWithCatalog(order.items || [], catalog);
    return { ...order, items };
  });
}

function updateReportOptions() {
  const stores = getStoreList();
  buildMultiSelectDropdown(
    ui.compareStores,
    stores.map((store) => ({ value: store, label: store })),
    state.reports.compareStores
  );

  const productMap = getProductMap();
  const productOptions = [{ value: "", label: "Select a product" }];
  const missingProductOptions = [{ value: "", label: "Select an item" }];
  productMap.forEach((label, value) => productOptions.push({ value, label }));
  productMap.forEach((label, value) => missingProductOptions.push({ value, label }));
  buildSelectOptions(ui.compareProduct, productOptions, state.reports.compareProduct);
  buildSelectOptions(ui.missingProduct, missingProductOptions, state.reports.missingProduct);

  const categoryMap = getCategoryMap();
  const categoryOptions = [{ value: "", label: "Select a category" }];
  categoryMap.forEach((label, value) => categoryOptions.push({ value, label }));
  buildSelectOptions(ui.compareCategory, categoryOptions, state.reports.compareCategory);
  buildSelectOptions(ui.missingCategory, categoryOptions, state.reports.missingCategory);

  if (ui.reportHistoryCount) {
    ui.reportHistoryCount.textContent = String(state.orders.length);
  }

  if (ui.reportTopStore) {
    ui.reportTopStore.textContent = "—";
  }
}

function syncReportFiltersFromInputs() {
  if (!ui.compareProduct) return;
  state.reports.compareStores = getSelectedValues(ui.compareStores);
  state.reports.compareProduct = normalizeProductKey(ui.compareProduct?.value);
  state.reports.compareCategory = ui.compareCategory?.value || "";
  state.reports.compareScope = ui.compareScope?.value || state.reports.compareScope;
  state.reports.compareStart = ui.compareStart?.value || "";
  state.reports.compareEnd = ui.compareEnd?.value || "";
  state.reports.compareSort = ui.compareSort?.value || state.reports.compareSort;
}

function syncMissingFiltersFromInputs() {
  if (!ui.missingProduct) return;
  state.reports.missingScope = ui.missingScope?.value || state.reports.missingScope;
  state.reports.missingProduct = normalizeProductKey(ui.missingProduct?.value);
  state.reports.missingCategory = ui.missingCategory?.value || "";
  state.reports.missingStart = ui.missingStart?.value || "";
  state.reports.missingEnd = ui.missingEnd?.value || "";
  state.reports.missingSort = ui.missingSort?.value || state.reports.missingSort;
}

function itemMatchesProduct(item, productKey) {
  if (!productKey) return false;
  const normalizedTarget = normalizeKey(productKey);
  const skuMatch = normalizeKey(item.sku) === normalizedTarget;
  const itemNoMatch = normalizeKey(item.item_no) === normalizedTarget;
  const nameMatch = normalizeKey(item.name) === normalizedTarget;
  return item.sku === productKey || item.item_no === productKey || item.name === productKey
    || skuMatch || itemNoMatch || nameMatch;
}

function itemMatchesCategory(item, categoryKey) {
  if (!categoryKey) return false;
  return normalizeKey(item.category) === normalizeKey(categoryKey);
}

function updateCompareScopeUI() {
  const currentScope = ui.compareScope?.value || state.reports.compareScope;
  const isCategory = currentScope === "category";
  setHidden(ui.compareProductField, isCategory);
  setHidden(ui.compareCategoryField, !isCategory);
}

function updateMissingScopeUI() {
  const currentScope = ui.missingScope?.value || state.reports.missingScope;
  const isCategory = currentScope === "category";
  setHidden(ui.missingProductField, isCategory);
  setHidden(ui.missingCategoryField, !isCategory);
}

function setReportMode(mode) {
  const nextMode = mode === "missing" ? "missing" : "volume";
  state.reports.mode = nextMode;
  const isVolume = nextMode === "volume";
  if (ui.reportModeVolume) {
    ui.reportModeVolume.classList.toggle("is-active", isVolume);
    ui.reportModeVolume.setAttribute("aria-selected", isVolume ? "true" : "false");
  }
  if (ui.reportModeMissing) {
    ui.reportModeMissing.classList.toggle("is-active", !isVolume);
    ui.reportModeMissing.setAttribute("aria-selected", isVolume ? "false" : "true");
  }
  setHidden(ui.reportVolumePanel, !isVolume);
  setHidden(ui.reportMissingPanel, isVolume);
}

function sortStores(stores, totals, sortKey) {
  const list = Array.from(stores);
  const compareQty = (a, b) => (totals.get(b) || 0) - (totals.get(a) || 0);
  const compareQtyAsc = (a, b) => (totals.get(a) || 0) - (totals.get(b) || 0);
  const compareNameAsc = (a, b) => a.localeCompare(b);
  const compareNameDesc = (a, b) => b.localeCompare(a);

  switch (sortKey) {
    case "qty-asc":
    case "missing-asc":
      return list.sort(compareQtyAsc);
    case "store-desc":
      return list.sort(compareNameDesc);
    case "store-asc":
    case "item-asc":
      return list.sort(compareNameAsc);
    case "qty-desc":
    case "missing-desc":
    default:
      return list.sort(compareQty);
  }
}

function parseMissingItemStatus(status, orderedQty) {
  if (!status) return null;
  const normalized = String(status).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("unavailable") || normalized.includes("out of stock")) {
    return {
      missingQty: orderedQty,
      orderedQty,
      collectedQty: 0,
      reason: "unavailable",
    };
  }
  const partialMatch = normalized.match(/partially\s+(?:collected|pulled)\s*(\d+)\s*of\s*(\d+)/i);
  if (!partialMatch) return null;
  const collectedQty = Number(partialMatch[1]);
  const orderedFromStatus = Number(partialMatch[2]);
  if (!Number.isFinite(collectedQty)) return null;
  let finalOrdered = Number(orderedQty);
  if (!Number.isFinite(finalOrdered) || finalOrdered <= 0) {
    finalOrdered = Number.isFinite(orderedFromStatus) ? orderedFromStatus : 0;
  }
  if (Number.isFinite(orderedFromStatus) && Number.isFinite(orderedQty) && orderedQty > 0 && orderedQty !== orderedFromStatus) {
    log("Partial status qty mismatch", { orderedQty, orderedFromStatus, status });
    if (orderedQty < collectedQty && orderedFromStatus >= collectedQty) {
      finalOrdered = orderedFromStatus;
    }
  }
  if (finalOrdered < collectedQty && Number.isFinite(orderedFromStatus) && orderedFromStatus >= collectedQty) {
    finalOrdered = orderedFromStatus;
  }
  const missingQty = Math.max((Number(finalOrdered) || 0) - collectedQty, 0);
  return {
    missingQty,
    orderedQty: finalOrdered,
    collectedQty,
    reason: "partial",
  };
}

function renderReports() {
  if (!ui.reportsPanel) return;
  updateCompareScopeUI();
  updateMissingScopeUI();

  const reportOrders = getReportOrdersWithCatalog();

  const allStores = getStoreList();
  const selectedStores = state.reports.compareStores || [];
  const stores = selectedStores.length
    ? allStores.filter((storeName) => selectedStores.includes(storeName))
    : allStores;

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
  const last30DaysStart = new Date(now);
  last30DaysStart.setDate(last30DaysStart.getDate() - 30);
  const last30DaysEnd = new Date(now);
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
      key: "custom",
      label: "Custom range",
      rangeLabel: customLabel,
      start: compareStart,
      end: compareEnd,
      active: !!(compareStart || compareEnd),
    },
    {
      key: "last30Days",
      label: "Last 30 days",
      rangeLabel: formatDateRange(last30DaysStart, last30DaysEnd),
      start: last30DaysStart,
      end: last30DaysEnd,
      active: true,
    },
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
  ];

  if (ui.compareRangeHint) {
    ui.compareRangeHint.textContent = "Timeframes use calendar periods, except Last 30 days. Custom range uses the start/end dates above.";
  }

  const compareTotals = new Map();
  stores.forEach((storeName) => {
    const totals = {};
    frames.forEach((frame) => { totals[frame.key] = 0; });
    compareTotals.set(storeName, totals);
  });

  if (compareValid) {
    reportOrders.forEach((order) => {
      if (!order) return;
      const orderDate = parseDateValue(order.requested_date || order.created_at);
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

  const primaryFrame = frames.find((frame) => frame.key === "custom" && frame.active)
    || frames.find((frame) => frame.active)
    || frames[0];
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
    ui.compareEmpty.textContent = selectedStores.length
      ? "No matching stores selected. Update the store filter to compare results."
      : "No order history yet. Submit orders to populate reports.";
  }
  if (ui.reportTopStore && !compareValid) {
    ui.reportTopStore.textContent = "—";
  }

  const missingStart = parseDateValue(state.reports.missingStart);
  const missingEnd = parseDateValue(state.reports.missingEnd);
  const missingScope = state.reports.missingScope;
  const missingSort = state.reports.missingSort;
  const missingProduct = state.reports.missingProduct;
  const missingCategory = state.reports.missingCategory;
  const missingTarget = missingScope === "category" ? missingCategory : missingProduct;
  const missingHasFilter = Boolean(missingTarget);
  let missingValid = true;
  if (missingStart && missingEnd && missingStart > missingEnd) {
    missingValid = false;
  }

  if (ui.missingRangeHint) {
    ui.missingRangeHint.textContent = "Missing inventory uses the start/end date range above.";
  }

  const missingStoreTotals = new Map();
  const missingItemTotals = new Map();

  if (missingValid) {
    reportOrders.forEach((order) => {
      if (!order) return;
      const orderDate = parseDateValue(order.requested_date || order.created_at);
      if (!orderDate) return;
      if (!isWithinRange(orderDate, missingStart, missingEnd)) return;
      (order.items || []).forEach((item) => {
        const orderedQty = Number(item.qty || 0) || 0;
        const statusResult = parseMissingItemStatus(item.status || "", orderedQty);
        if (!statusResult || !statusResult.missingQty) return;
        if (missingHasFilter) {
          const match = missingScope === "category"
            ? itemMatchesCategory(item, missingTarget)
            : itemMatchesProduct(item, missingTarget);
          if (!match) return;
          const current = missingStoreTotals.get(order.store) || 0;
          missingStoreTotals.set(order.store, current + statusResult.missingQty);
        } else {
          const key = item.sku || item.item_no || item.name;
          if (!key) return;
          const current = missingItemTotals.get(key) || { name: item.name || key, qty: 0 };
          current.name = item.name || current.name || key;
          current.qty += statusResult.missingQty;
          missingItemTotals.set(key, current);
        }
      });
    });
  }

  if (ui.missingStoreHead) {
    ui.missingStoreHead.innerHTML = "";
    const row = document.createElement("tr");
    const storeHead = document.createElement("th");
    storeHead.textContent = "Store";
    const qtyHead = document.createElement("th");
    qtyHead.textContent = "Missing qty";
    row.appendChild(storeHead);
    row.appendChild(qtyHead);
    ui.missingStoreHead.appendChild(row);
  }

  if (ui.missingStoreBody) {
    ui.missingStoreBody.innerHTML = "";
    if (missingValid && missingHasFilter && missingStoreTotals.size) {
      const storeList = Array.from(missingStoreTotals.keys());
      const totalsMap = new Map(missingStoreTotals);
      const sortedStores = sortStores(storeList, totalsMap, missingSort);
      let grandTotal = 0;
      sortedStores.forEach((storeName) => {
        const qty = totalsMap.get(storeName) || 0;
        grandTotal += qty;
        const row = document.createElement("tr");
        const storeCell = document.createElement("td");
        storeCell.textContent = storeName;
        const qtyCell = document.createElement("td");
        qtyCell.textContent = String(qty);
        row.appendChild(storeCell);
        row.appendChild(qtyCell);
        ui.missingStoreBody.appendChild(row);
      });
      if (ui.missingGrandTotal) {
        ui.missingGrandTotal.textContent = String(grandTotal);
      }
      setHidden(ui.missingGrandTotalWrap, false);
    } else {
      setHidden(ui.missingGrandTotalWrap, true);
    }
  }

  if (ui.missingItemsHead) {
    ui.missingItemsHead.innerHTML = "";
    const row = document.createElement("tr");
    const itemHead = document.createElement("th");
    itemHead.textContent = "Item";
    const qtyHead = document.createElement("th");
    qtyHead.textContent = "Missing qty";
    row.appendChild(itemHead);
    row.appendChild(qtyHead);
    ui.missingItemsHead.appendChild(row);
  }

  if (ui.missingItemsBody) {
    ui.missingItemsBody.innerHTML = "";
    if (missingValid && !missingHasFilter && missingItemTotals.size) {
      const itemList = Array.from(missingItemTotals.values());
      const sortedItems = itemList.sort((a, b) => {
        if (missingSort === "item-asc" || missingSort === "store-asc" || missingSort === "store-desc") {
          return String(a.name || "").localeCompare(String(b.name || ""));
        }
        if (missingSort === "missing-asc") {
          return (a.qty || 0) - (b.qty || 0);
        }
        return (b.qty || 0) - (a.qty || 0);
      });
      sortedItems.forEach((item) => {
        const row = document.createElement("tr");
        const nameCell = document.createElement("td");
        nameCell.textContent = item.name;
        const qtyCell = document.createElement("td");
        qtyCell.textContent = String(item.qty || 0);
        row.appendChild(nameCell);
        row.appendChild(qtyCell);
        ui.missingItemsBody.appendChild(row);
      });
    }
  }

  const showMissingStore = missingHasFilter;
  if (ui.missingStoreEmpty && missingHasFilter) {
    ui.missingStoreEmpty.textContent = missingValid
      ? "No missing inventory found in this range."
      : "Start date must be before end date.";
  }
  if (ui.missingItemsEmpty && !missingHasFilter) {
    ui.missingItemsEmpty.textContent = missingValid
      ? "No missing inventory found in this range."
      : "Start date must be before end date.";
  }
  const showMissingStoreEmpty = showMissingStore && (!missingValid || !missingStoreTotals.size);
  const showMissingItemsEmpty = !showMissingStore && (!missingValid || !missingItemTotals.size);
  setHidden(ui.missingStoreTitle, !showMissingStore);
  setHidden(ui.missingItemsTitle, showMissingStore);
  setHidden(ui.missingStoreWrap, !showMissingStore);
  setHidden(ui.missingStoreEmpty, !showMissingStoreEmpty);
  setHidden(ui.missingItemsWrap, showMissingStore);
  setHidden(ui.missingItemsEmpty, !showMissingItemsEmpty);
}

function applyReportFilters() {
  syncReportFiltersFromInputs();
  renderReports();
}

function applyMissingReportFilters() {
  syncMissingFiltersFromInputs();
  renderReports();
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
  if (state.submitting) return;
  state.submitting = true;
  showSubmitError("");
  showSubmitSuccess("");

  const metaErr = validateMeta();
  if (metaErr) {
    showSubmitError(metaErr);
    state.submitting = false;
    return;
  }

  const items = selectedItemsPayload();
  if (items.length === 0) {
    showSubmitError("No items selected.");
    state.submitting = false;
    return;
  }

  const payload = {
    store: state.meta.store,
    placed_by: state.meta.placed_by,
    timestamp: nowIso(),
    requested_date: state.meta.requested_date,
    notes: state.meta.notes,
    items,
    client: {
      userAgent: navigator.userAgent,
      ts: nowIso(),
    },
  };

  const payloadSummary = {
    store: payload.store,
    placed_by: payload.placed_by,
    requested_date: payload.requested_date,
    item_count: items.length,
    total_qty: items.reduce((sum, item) => sum + Number(item.qty || 0), 0),
  };

  const localOrder = createLocalOrderRecord(payload, items);
  storeLocalOrder(localOrder);

  ui.submitBtn.disabled = true;
  ui.submitBtn.textContent = "Submitting...";

  try {
    const data = await AppClient.apiFetch("submitOrder", {
      method: "POST",
      body: payload,
      cacheBust: true,
      retry: 0,
      onRequest: ({ url, method }) => {
        console.info("[OrderPortal] Submit request", { method, url, payload: payloadSummary });
      },
    });

    const orderId = data.order_id || "(no id)";
    showSubmitSuccess(`Order submitted successfully. Order ID: ${orderId}`);
    AppClient.showToast("Order submitted successfully.", "success");

    // Reset quantities after success
    recordOrderHistory(payload, orderId);
    state.quantities = {};
    state.dirty = false;
    saveCache();

  } catch (err) {
    const statusText = err.status ? `HTTP ${err.status}` : "";
    const responseJson = err.responseJson || err.payload || null;
    const responseText = !responseJson && err.responseText ? err.responseText.slice(0, 500) : "";
    const responseSummary = responseJson
      ? `Response: ${JSON.stringify(responseJson)}`
      : responseText
        ? `Response: ${responseText}`
        : "";
    const exceptionSummary = err && err.name ? `${err.name}: ${err.message || ""}`.trim() : (err.message || String(err));
    const requestId = err.payload?.request_id || err.responseJson?.request_id;
    const details = [statusText, responseSummary, exceptionSummary].filter(Boolean).join(" | ");
    const hint = err.isNetworkError
      ? "Network/CORS/deployment issue likely. Verify the Apps Script web app /exec URL and that it is deployed for 'Anyone' access."
      : details || "Request failed.";
    const requestIdSuffix = requestId ? ` (Request ID: ${requestId})` : "";
    showSubmitError(`Submit failed. ${hint}${requestIdSuffix}`);
    showGlobalError(`Order submission failed. ${hint}${requestIdSuffix}`, "warning");
    if (DEBUG) console.error(err);
  } finally {
    state.submitting = false;
    ui.submitBtn.disabled = false;
    ui.submitBtn.textContent = "Submit Order";
  }
}

// =========================
// EVENTS
// =========================
function wireEvents() {
  ui.homeOrder?.addEventListener("click", () => {
    resetQuantitiesForNewOrder();
    state.selectedCategory = "";
    renderWizard();
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

  ui.topbarHomeBtn?.addEventListener("click", () => showHome());
  AppClient.bindRefreshButtons({
    catalog: () => {
      if (state.activeTab === "reports") {
        refreshReports({ force: true });
        return;
      }
      refreshCatalog({ force: true });
    },
  });
  ui.orderTabBtn?.addEventListener("click", () => setActiveTab("order"));
  ui.reportsTabBtn?.addEventListener("click", () => setActiveTab("reports"));

  ui.reviewBtn?.addEventListener("click", showReview);
  const returnToCategories = () => {
    state.selectedCategory = "";
    showCatalog();
  };
  ui.backToCategories?.addEventListener("click", returnToCategories);
  ui.backToCategoriesBottom?.addEventListener("click", returnToCategories);

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
  ui.store?.addEventListener("change", markDirty);
  ui.requestedDate?.addEventListener("change", markDirty);
  ui.placedBy?.addEventListener("input", markDirty);
  ui.notes?.addEventListener("input", markDirty);

  ui.compareScope?.addEventListener("change", updateCompareScopeUI);
  ui.missingScope?.addEventListener("change", updateMissingScopeUI);
  ui.compareStores?.addEventListener("change", () => {
    updateMultiSelectToggle(ui.compareStores);
  });
  ui.compareStores?.addEventListener("click", (event) => {
    const toggle = event.target.closest(".multiselect__toggle");
    if (!toggle || !ui.compareStores) return;
    event.preventDefault();
    setMultiSelectOpen(ui.compareStores, !ui.compareStores.classList.contains("is-open"));
  });
  document.addEventListener("click", (event) => {
    if (!ui.compareStores) return;
    if (ui.compareStores.contains(event.target)) return;
    setMultiSelectOpen(ui.compareStores, false);
  });
  ui.compareGo?.addEventListener("click", applyReportFilters);
  ui.missingGo?.addEventListener("click", applyMissingReportFilters);
  ui.reportModeVolume?.addEventListener("click", () => {
    setReportMode("volume");
    renderReports();
  });
  ui.reportModeMissing?.addEventListener("click", () => {
    setReportMode("missing");
    renderReports();
  });

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
  updateRefreshButtonLabel();
  refreshApiHealth({ background: true });

  // If cache is stale or empty, try a background refresh
  const hasCatalog = state.products.length > 0;
  if (hasCatalog) {
    refreshCatalog({ force: true, background: true });
  } else {
    refreshCatalog({ force: true });
  }
}

init();
