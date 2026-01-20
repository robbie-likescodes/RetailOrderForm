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
 * lastUpdated, refreshBtn, store, requestedDate, deliveryMethod, placedBy, phone, email, notes,
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
  SCRIPT_URL: "PASTE_YOUR_SCRIPT_URL_HERE",

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
  deliveryMethod: $("deliveryMethod"),
  placedBy: $("placedBy"),
  phone: $("phone"),
  email: $("email"),
  notes: $("notes"),

  wizard: $("wizard"),
  review: $("review"),

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

  // Optional extras
  categoryJumpBtn: $("categoryJumpBtn"),
  categoryJumpMenu: $("categoryJumpMenu"),
  searchInput: $("searchInput"),
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
  meta: {
    store: "",
    requested_date: "",
    delivery_method: "Delivery",
    placed_by: "",
    phone: "",
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
  if (ui.deliveryMethod) ui.deliveryMethod.value = state.meta.delivery_method || "Delivery";
  if (ui.placedBy) ui.placedBy.value = state.meta.placed_by || "";
  if (ui.phone) ui.phone.value = state.meta.phone || "";
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
  if (ui.deliveryMethod) state.meta.delivery_method = ui.deliveryMethod.value;
  if (ui.placedBy) state.meta.placed_by = ui.placedBy.value.trim();
  if (ui.phone) state.meta.phone = ui.phone.value.trim();
  if (ui.email) state.meta.email = ui.email.value.trim();
  if (ui.notes) state.meta.notes = ui.notes.value.trim();
  saveCache();
}

// =========================
// CATALOG: BUILD STEPS
// =========================
function normalizeCategoryRows(rows) {
  // expected: {category, display_name, sort}
  const out = [];
  for (const r of rows || []) {
    const category = String(r.category || "").trim();
    if (!category) continue;
    out.push({
      category,
      display_name: String(r.display_name || category).trim(),
      sort: Number(r.sort ?? 9999),
    });
  }
  out.sort((a, b) => a.sort - b.sort);
  return out;
}

function normalizeProductRows(rows) {
  // expected: item_no, sku, name, category, unit, pack_size, sort
  const out = [];
  for (const r of rows || []) {
    const sku = String(r.sku || "").trim();
    const name = String(r.name || "").trim();
    const category = String(r.category || "").trim();
    if (!sku || !name || !category) continue;

    out.push({
      item_no: String(r.item_no || "").trim(),
      sku,
      name,
      category,
      unit: String(r.unit || "").trim(),
      pack_size: String(r.pack_size || "").trim(),
      sort: Number(r.sort ?? 9999),
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
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
// SUBMISSION (POST)
// =========================
function validateMeta() {
  syncMetaFromInputs();

  if (!state.meta.store) return "Store is required.";
  if (!state.meta.requested_date) return "Requested date is required.";
  if (!state.meta.placed_by) return "Placed by is required.";

  // Light validation
  if (state.meta.phone && state.meta.phone.length < 7) return "Phone looks too short.";
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

  const metaErr = validateMeta();
  if (metaErr) { showSubmitError(metaErr); return; }

  const items = selectedItemsPayload();
  if (items.length === 0) { showSubmitError("No items selected."); return; }

  const payload = {
    token: TOKEN || undefined,
    store: state.meta.store,
    placed_by: state.meta.placed_by,
    phone: state.meta.phone,
    email: state.meta.email,
    requested_date: state.meta.requested_date,
    delivery_method: state.meta.delivery_method,
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
  ui.deliveryMethod?.addEventListener("change", markDirty);
  ui.placedBy?.addEventListener("input", markDirty);
  ui.phone?.addEventListener("input", markDirty);
  ui.email?.addEventListener("input", markDirty);
  ui.notes?.addEventListener("input", markDirty);

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
}

// =========================
// INIT
// =========================
function init() {
  loadCache();
  buildSteps();
  wireEvents();
  updateNetStatus();
  renderWizard();

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
