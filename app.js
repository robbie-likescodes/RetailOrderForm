/**
 * Retail Order Portal - app.js (comprehensive, production-lean)
 * ------------------------------------------------------------
 * Features:
 * - Loads Categories + Products from Google Apps Script (GET)
 * - Wizard “Next/Back” flow with numeric entry + Enter/Done to advance
 * - Optional category jump menu + search
 * - Local cache for offline / fast startup (categories, products, quantities, form meta, position)
 * - “Refresh Products” button with confirmation and graceful fallback to cache
 * - Review screen with inline edits
 * - Submit (POST) wired (will fail gracefully until you add doPost in Apps Script)
 * - Token support via URL ?token=XXXX and optional store lock via ?store=Boniface
 * - Basic input validation and error surfaces
 *
 * Required HTML element IDs expected (matches the earlier index.html):
 * lastUpdated, refreshBtn, store, requestedDate, placedBy, email, notes,
 * wizard, review, pillCategory, productName, productMeta, qtyInput, progressText, selectedText,
 * backBtn, nextBtn, reviewBtn, errorBox, reviewList, editBtn, submitBtn, submitError, submitSuccess
 *
 * Optional extra IDs (if you add them):
 * categoryJumpBtn, categoryJumpMenu, searchInput, netStatus
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
  topMenuToggle: $("topMenuToggle"),
  topMenuList: $("topMenuList"),
  topMenuOrder: $("topMenuOrder"),
  topMenuDrivers: $("topMenuDrivers"),
  topMenuHistory: $("topMenuHistory"),
  topMenuReports: $("topMenuReports"),
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
  qtyInput: $("qtyInput"),
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
  categoryJumpBtn: $("categoryJumpBtn"),
  categoryJumpMenu: $("categoryJumpMenu"),
  searchInput: $("searchInput"),
  netStatus: $("netStatus"),

  reportHistoryCount: $("reportHistoryCount"),
  reportProduct: $("reportProduct"),
  reportStore: $("reportStore"),
  reportDay: $("reportDay"),
  reportMonth: $("reportMonth"),
  reportYear: $("reportYear"),
  reportStoreBody: $("reportStoreBody"),
  reportStoreEmpty: $("reportStoreEmpty"),
  compareProduct: $("compareProduct"),
  compareStart: $("compareStart"),
  compareEnd: $("compareEnd"),
  compareBody: $("compareBody"),
  compareEmpty: $("compareEmpty"),
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
  activeTab: "order",
  reports: {
    product: "",
    store: "all",
    day: "",
    month: "",
    year: "",
    compareProduct: "",
    compareStart: "",
    compareEnd: "",
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
  if (ui.topMenuToggle) ui.topMenuToggle.setAttribute("aria-expanded", "false");
  setHidden(ui.topMenuList, true);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function showOrderApp() {
  setHidden(ui.homeScreen, true);
  setHidden(ui.orderApp, false);
  if (ui.topMenuToggle) ui.topMenuToggle.setAttribute("aria-expanded", "false");
  setHidden(ui.topMenuList, true);
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
  const updatedAt = localStorage.getItem(CACHE.UPDATED_AT) || "";
  const cachedAt = localStorage.getItem(CACHE.CACHED_AT) || "";

  if (Array.isArray(cats) && cats.length) state.categories = cats;
  if (Array.isArray(prods) && prods.length) state.products = prods;
  if (qtys && typeof qtys === "object") state.quantities = qtys;
  if (Array.isArray(orders)) state.orders = orders;
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

  renderCategoryJumpMenu();
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

function getCurrent() {
  return state.steps[state.idx] || null;
}

function commitQty() {
  const step = getCurrent();
  if (!step) return true;

  const raw = (ui.qtyInput?.value || "").trim();
  if (raw === "") {
    if (state.quantities[step.sku] !== undefined) {
      delete state.quantities[step.sku];
      state.dirty = true;
    }
    saveCache();
    return true;
  }

  const num = Number(raw);
  if (!Number.isFinite(num)) {
    showError("Quantity must be a number.");
    return false;
  }
  const qty = Math.floor(num);
  if (qty < 0) {
    showError("Quantity must be 0 or greater.");
    return false;
  }
  if (qty > CONFIG.MAX_QTY) {
    showError(`Quantity is too large (max ${CONFIG.MAX_QTY}).`);
    return false;
  }

  if (qty === 0) {
    if (state.quantities[step.sku] !== undefined) {
      delete state.quantities[step.sku];
      state.dirty = true;
    }
  } else {
    if (state.quantities[step.sku] !== qty) {
      state.quantities[step.sku] = qty;
      state.dirty = true;
    }
  }

  saveCache();
  return true;
}

function setQtyFocus() {
  if (!CONFIG.AUTOFOCUS_QTY) return;
  if (!ui.qtyInput) return;
  ui.qtyInput.focus();
  ui.qtyInput.select?.();
}

// =========================
// RENDER: WIZARD
// =========================
function renderWizard() {
  showError("");

  const step = getCurrent();
  if (!step) {
    setText(ui.pillCategory, "—");
    setText(ui.productName, "No products loaded");
    setText(ui.productMeta, "Tap Refresh to load your catalog.");
    if (ui.qtyInput) ui.qtyInput.value = "";
    setText(ui.progressText, "—");
    setText(ui.selectedText, `Selected: ${countSelected()}`);
    if (ui.backBtn) ui.backBtn.disabled = true;
    return;
  }

  // Category display name
  const catRow = state.categories.find(c => c.category === step.category);
  const catLabel = catRow?.display_name || step.category;

  setText(ui.pillCategory, catLabel);
  setText(ui.productName, step.name);

  const metaParts = [];
  if (step.item_no) metaParts.push(step.item_no);
  if (step.unit) metaParts.push(step.unit);
  if (step.pack_size) metaParts.push(step.pack_size);
  setText(ui.productMeta, metaParts.join(" • "));

  const existing = state.quantities[step.sku];
  if (ui.qtyInput) ui.qtyInput.value = existing ? String(existing) : "";

  // Progress: overall + category
  const overall = `Item ${state.idx + 1} of ${state.steps.length}`;
  const range = state.categoryIndex.get(step.category);
  let catProgress = "";
  if (range) {
    const within = state.idx - range.start + 1;
    const total = range.end - range.start + 1;
    catProgress = ` • ${catLabel} ${within}/${total}`;
  }
  setText(ui.progressText, overall + catProgress);

  setText(ui.selectedText, `Selected: ${countSelected()}`);
  if (ui.backBtn) ui.backBtn.disabled = state.idx === 0;

  saveCache();
  setQtyFocus();
}

// =========================
// RENDER: CATEGORY JUMP MENU (optional)
// =========================
function renderCategoryJumpMenu() {
  if (!ui.categoryJumpMenu) return;

  // Build menu items from current steps order (unique in order)
  const seen = new Set();
  const catsInOrder = [];
  for (const p of state.steps) {
    if (!seen.has(p.category)) {
      seen.add(p.category);
      const row = state.categories.find(c => c.category === p.category);
      catsInOrder.push({ category: p.category, label: row?.display_name || p.category });
    }
  }

  ui.categoryJumpMenu.innerHTML = "";
  for (const c of catsInOrder) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn"; // you can style smaller if desired
    btn.style.height = "44px";
    btn.textContent = c.label;
    btn.addEventListener("click", () => jumpToCategory(c.category));
    ui.categoryJumpMenu.appendChild(btn);
  }
}

function jumpToCategory(category) {
  const range = state.categoryIndex.get(category);
  if (!range) return;
  if (!commitQty()) return;
  state.idx = range.start;
  saveCache();
  renderWizard();
  if (ui.categoryJumpMenu) ui.categoryJumpMenu.hidden = true;
}

// =========================
// SEARCH (optional)
// =========================
function searchAndJump(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return;

  // Find next match starting from current+1, wrap around
  const n = state.steps.length;
  if (!n) return;

  const start = (state.idx + 1) % n;
  let i = start;

  do {
    const p = state.steps[i];
    const hay = `${p.name} ${p.sku} ${p.item_no} ${p.category}`.toLowerCase();
    if (hay.includes(q)) {
      if (!commitQty()) return;
      state.idx = i;
      saveCache();
      renderWizard();
      return;
    }
    i = (i + 1) % n;
  } while (i !== start);

  showError(`No match for “${query}”.`);
}

// =========================
// NAVIGATION
// =========================
function goNext() {
  if (!commitQty()) return;
  if (state.idx < state.steps.length - 1) {
    state.idx++;
    saveCache();
    renderWizard();
  } else {
    showReview();
  }
}

function goBack() {
  if (!commitQty()) return;
  if (state.idx > 0) {
    state.idx--;
    saveCache();
    renderWizard();
  }
}

function showReview() {
  if (!commitQty()) return;

  syncMetaFromInputs();
  showSubmitError("");
  showSubmitSuccess("");

  setHidden(ui.wizard, true);
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

  setHidden(ui.review, true);
  setHidden(ui.wizard, false);
  renderWizard();
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
    renderWizard();
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
function setActiveTab(tab) {
  state.activeTab = tab === "reports" ? "reports" : "order";
  setHidden(ui.orderPanel, state.activeTab !== "order");
  setHidden(ui.reportsPanel, state.activeTab !== "reports");

  if (ui.orderTabBtn) ui.orderTabBtn.classList.toggle("is-active", state.activeTab === "order");
  if (ui.reportsTabBtn) ui.reportsTabBtn.classList.toggle("is-active", state.activeTab === "reports");

  if (state.activeTab === "reports") {
    updateReportOptions();
    renderReports();
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
}

function syncReportFiltersFromInputs() {
  if (!ui.reportProduct) return;
  state.reports.product = normalizeProductKey(ui.reportProduct.value);
  state.reports.store = ui.reportStore?.value || "all";
  state.reports.day = ui.reportDay?.value || "";
  state.reports.month = ui.reportMonth?.value || "";
  state.reports.year = ui.reportYear?.value || "";
  state.reports.compareProduct = normalizeProductKey(ui.compareProduct?.value);
  state.reports.compareStart = ui.compareStart?.value || "";
  state.reports.compareEnd = ui.compareEnd?.value || "";
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

function renderReports() {
  if (!ui.reportsPanel) return;
  syncReportFiltersFromInputs();

  const { product, store, day, month, year } = state.reports;
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
      const rows = (store === "all" ? stores : stores.filter((name) => name === store));
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
  const compareStart = parseDateValue(state.reports.compareStart);
  const compareEnd = parseDateValue(state.reports.compareEnd);
  const compareTotals = new Map();
  stores.forEach((storeName) => compareTotals.set(storeName, 0));

  let compareValid = !!compareProduct;
  if (compareValid && compareStart && compareEnd && compareStart > compareEnd) {
    compareValid = false;
    if (ui.compareEmpty) ui.compareEmpty.textContent = "Start date must be before end date.";
  } else if (ui.compareEmpty) {
    ui.compareEmpty.textContent = "Choose a product and date range to compare stores.";
  }

  if (compareValid) {
    state.orders.forEach((order) => {
      if (!order || !order.requested_date) return;
      const orderDate = parseDateValue(order.requested_date);
      if (!isWithinRange(orderDate, compareStart, compareEnd)) return;

      (order.items || []).forEach((item) => {
        if (!itemMatchesProduct(item, compareProduct)) return;
        const current = compareTotals.get(order.store) || 0;
        const qty = Number(item.qty) || 0;
        compareTotals.set(order.store, current + qty);
      });
    });
  }

  if (ui.compareBody) {
    ui.compareBody.innerHTML = "";
    if (compareValid && stores.length) {
      const sortedStores = Array.from(stores).sort((a, b) => {
        return (compareTotals.get(b) || 0) - (compareTotals.get(a) || 0);
      });
      sortedStores.forEach((storeName) => {
        const row = document.createElement("tr");
        const nameCell = document.createElement("td");
        nameCell.textContent = storeName;
        const qtyCell = document.createElement("td");
        qtyCell.textContent = String(compareTotals.get(storeName) || 0);
        row.appendChild(nameCell);
        row.appendChild(qtyCell);
        ui.compareBody.appendChild(row);
      });
    }
  }

  setHidden(ui.compareEmpty, compareValid && stores.length);
  if (ui.compareEmpty && !stores.length) {
    ui.compareEmpty.textContent = "No order history yet. Submit orders to populate reports.";
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
  ui.topMenuToggle?.addEventListener("click", () => {
    if (!ui.topMenuList) return;
    const isHidden = ui.topMenuList.hidden;
    setHidden(ui.topMenuList, !isHidden);
    ui.topMenuToggle?.setAttribute("aria-expanded", String(isHidden));
  });

  ui.homeOrder?.addEventListener("click", () => {
    showOrderApp();
  });

  ui.homeDrivers?.addEventListener("click", () => {
    alert("Drivers view coming soon.");
  });

  ui.homeHistory?.addEventListener("click", () => {
    window.location.href = "history.html";
  });

  ui.homeReports?.addEventListener("click", () => {
    alert("Reports view coming soon.");
  });

  ui.topMenuOrder?.addEventListener("click", () => {
    showOrderApp();
    setHidden(ui.topMenuList, true);
  });

  ui.topMenuDrivers?.addEventListener("click", () => {
    alert("Drivers view coming soon.");
    setHidden(ui.topMenuList, true);
  });

  ui.topMenuHistory?.addEventListener("click", () => {
    window.location.href = "history.html";
  });

  ui.topMenuReports?.addEventListener("click", () => {
    alert("Reports view coming soon.");
    setHidden(ui.topMenuList, true);
  });

  ui.refreshBtn?.addEventListener("click", () => refreshCatalog());
  ui.orderTabBtn?.addEventListener("click", () => setActiveTab("order"));
  ui.reportsTabBtn?.addEventListener("click", () => setActiveTab("reports"));

  ui.nextBtn?.addEventListener("click", goNext);
  ui.backBtn?.addEventListener("click", goBack);
  ui.reviewBtn?.addEventListener("click", showReview);

  ui.editBtn?.addEventListener("click", backToWizard);
  ui.submitBtn?.addEventListener("click", submitOrder);

  // Enter / Done advances
  ui.qtyInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goNext();
    }
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
  ui.reportMonth?.addEventListener("change", () => {
    if (ui.reportMonth?.value) {
      if (ui.reportDay) ui.reportDay.value = "";
    }
    rerenderReports();
  });
  ui.reportYear?.addEventListener("change", () => {
    if (ui.reportYear?.value) {
      if (ui.reportDay) ui.reportDay.value = "";
    }
    rerenderReports();
  });
  ui.reportDay?.addEventListener("change", () => {
    if (ui.reportDay?.value) {
      if (ui.reportMonth) ui.reportMonth.value = "";
      if (ui.reportYear) ui.reportYear.value = "";
    }
    rerenderReports();
  });
  ui.compareProduct?.addEventListener("change", rerenderReports);
  ui.compareStart?.addEventListener("change", rerenderReports);
  ui.compareEnd?.addEventListener("change", rerenderReports);

  // Optional: category jump toggle
  ui.categoryJumpBtn?.addEventListener("click", () => {
    if (!ui.categoryJumpMenu) return;
    ui.categoryJumpMenu.hidden = !ui.categoryJumpMenu.hidden;
  });

  // Optional: search
  ui.searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchAndJump(ui.searchInput.value);
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
  updateReportOptions();
  setActiveTab("order");

  // If store is locked by URL param, keep it locked
  if (STORE_LOCK && ui.store) {
    ui.store.value = STORE_LOCK;
    ui.store.setAttribute("disabled", "disabled");
  }

  if (VIEW === "order") {
    showOrderApp();
  }

  // If cache is stale or empty, try a background refresh
  const hasCatalog = state.products.length > 0;
  if (!hasCatalog || isCacheStale()) {
    refreshCatalog({ force: true });
  }
}

init();
