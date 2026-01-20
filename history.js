/**
 * Retail Order Portal - history.js
 * --------------------------------
 * Fetches orders + items from Apps Script and renders a store/order drill-down.
 */

const CONFIG = {
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzgkI0hGD6aIdLuUYM8T_MD6XJyfzYBQmdoLW7z8yB2R6Sjh4BI5LHgyg_ybvVisY6K/exec",
  GET_ORDER_HISTORY: (t) => `${CONFIG.SCRIPT_URL}?action=order_history&t=${t}`,
};

const $ = (id) => document.getElementById(id);
const ui = {
  updated: $("historyUpdated"),
  refreshBtn: $("historyRefreshBtn"),
  status: $("historyStatus"),
  error: $("historyError"),
  content: $("historyContent"),
};

const state = {
  orders: [],
  items: [],
};

function setText(el, txt) {
  if (!el) return;
  el.textContent = txt;
}

function setHidden(el, hidden) {
  if (!el) return;
  el.hidden = !!hidden;
}

function showError(message) {
  setHidden(ui.error, !message);
  setText(ui.error, message || "");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function formatDate(value) {
  const date = parseDate(value);
  return date ? date.toLocaleString() : "Unknown time";
}

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

function groupItemsByOrder(items) {
  const map = new Map();
  for (const item of items) {
    const orderId = String(item.order_id || "").trim();
    if (!orderId) continue;
    if (!map.has(orderId)) map.set(orderId, []);
    map.get(orderId).push(item);
  }
  return map;
}

function sortOrdersByDate(orders) {
  return [...orders].sort((a, b) => {
    const da = parseDate(a.created_at)?.getTime() || 0;
    const db = parseDate(b.created_at)?.getTime() || 0;
    return db - da;
  });
}

function renderHistory() {
  ui.content.innerHTML = "";

  if (!state.orders.length) {
    ui.content.innerHTML = `<div class="historyEmpty">No orders found yet.</div>`;
    return;
  }

  const itemsByOrder = groupItemsByOrder(state.items);
  const stores = new Map();

  for (const order of state.orders) {
    const store = String(order.store || "Unknown Store").trim() || "Unknown Store";
    if (!stores.has(store)) stores.set(store, []);
    stores.get(store).push(order);
  }

  const sortedStores = [...stores.keys()].sort((a, b) => a.localeCompare(b));

  sortedStores.forEach((storeName) => {
    const storeOrders = sortOrdersByDate(stores.get(storeName));

    const storeDetails = document.createElement("details");
    storeDetails.className = "historyStore";

    const storeSummary = document.createElement("summary");
    storeSummary.innerHTML = `
      <span>${escapeHtml(storeName)}</span>
      <span class="historyCount">${storeOrders.length} order${storeOrders.length === 1 ? "" : "s"}</span>
    `;
    storeDetails.appendChild(storeSummary);

    const ordersWrap = document.createElement("div");
    ordersWrap.className = "historyOrders";

    storeOrders.forEach((order) => {
      const orderId = String(order.order_id || "").trim() || "(no id)";
      const createdAt = formatDate(order.created_at);
      const orderDetails = document.createElement("details");
      orderDetails.className = "historyOrder";

      const orderSummary = document.createElement("summary");
      orderSummary.innerHTML = `
        <div>
          <div class="historyOrder__title">Order ${escapeHtml(orderId)}</div>
          <div class="historyOrder__subtitle">${escapeHtml(createdAt)}</div>
        </div>
        <div class="historyOrder__metaSummary">
          <span>${escapeHtml(String(order.item_count || ""))} items</span>
          <span>${escapeHtml(String(order.total_qty || ""))} qty</span>
        </div>
      `;
      orderDetails.appendChild(orderSummary);

      const orderBody = document.createElement("div");
      orderBody.className = "historyOrder__body";
      orderBody.innerHTML = `
        <div class="historyOrder__metaGrid">
          <div><strong>Placed by:</strong> ${escapeHtml(order.placed_by || "—")}</div>
          <div><strong>Requested date:</strong> ${escapeHtml(order.requested_date || "—")}</div>
          <div><strong>Email:</strong> ${escapeHtml(order.email || "—")}</div>
          <div><strong>Notes:</strong> ${escapeHtml(order.notes || "—")}</div>
        </div>
      `;

      const items = itemsByOrder.get(orderId) || [];
      const itemsWrap = document.createElement("div");
      itemsWrap.className = "historyItems";

      if (!items.length) {
        itemsWrap.innerHTML = `<div class="historyEmpty">No items recorded for this order.</div>`;
      } else {
        items.forEach((item) => {
          const itemDiv = document.createElement("div");
          itemDiv.className = "historyItem";
          itemDiv.innerHTML = `
            <div>
              <div class="historyItem__name">${escapeHtml(item.name || item.sku || "Item")}</div>
              <div class="historyItem__meta">
                ${escapeHtml([item.item_no, item.category, item.unit, item.pack_size].filter(Boolean).join(" • "))}
              </div>
            </div>
            <div class="historyItem__qty">${escapeHtml(String(item.qty || ""))}</div>
          `;
          itemsWrap.appendChild(itemDiv);
        });
      }

      orderBody.appendChild(itemsWrap);
      orderDetails.appendChild(orderBody);
      ordersWrap.appendChild(orderDetails);
    });

    storeDetails.appendChild(ordersWrap);
    ui.content.appendChild(storeDetails);
  });
}

async function refreshHistory() {
  showError("");
  setHidden(ui.status, false);
  setText(ui.status, "Refreshing orders from Google Sheets…");

  if (!CONFIG.SCRIPT_URL || CONFIG.SCRIPT_URL.includes("PASTE_")) {
    showError("Please set CONFIG.SCRIPT_URL in history.js to your Apps Script Web App /exec URL.");
    setHidden(ui.status, true);
    return;
  }

  ui.refreshBtn.disabled = true;
  ui.refreshBtn.textContent = "Refreshing…";

  try {
    const t = Date.now();
    const data = await fetchJson(CONFIG.GET_ORDER_HISTORY(t));
    if (!data.ok) throw new Error(data.error || "Order history endpoint failed");

    state.orders = Array.isArray(data.orders) ? data.orders : [];
    state.items = Array.isArray(data.items) ? data.items : [];

    renderHistory();

    const updatedAt = data.updated_at ? new Date(data.updated_at) : new Date();
    setText(ui.updated, `Orders: ${updatedAt.toLocaleString()}`);
    setHidden(ui.status, true);
  } catch (err) {
    showError(`Could not refresh order history. (${String(err)})`);
    setHidden(ui.status, true);
  } finally {
    ui.refreshBtn.disabled = false;
    ui.refreshBtn.textContent = "Refresh Orders";
  }
}

function init() {
  ui.refreshBtn?.addEventListener("click", refreshHistory);
  refreshHistory();
}

init();
