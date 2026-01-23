/**
 * Retail Order Portal - history.js
 * --------------------------------
 * Fetches orders + items from Apps Script and renders a store/order drill-down.
 */

const $ = (id) => document.getElementById(id);
const ui = {
  updated: $("historyUpdated"),
  refreshBtn: $("historyRefreshBtn"),
  status: $("historyStatus"),
  error: $("historyError"),
  content: $("historyContent"),
  startDate: $("historyStartDate"),
  endDate: $("historyEndDate"),
};

const state = {
  orders: [],
  items: [],
  catalog: null,
  ordersUpdatedAt: "",
  deliveryState: {},
  filter: {
    start: null,
    end: null,
  },
};

const DELIVERY_STATE_KEY = "orderportal_delivery_state_v1";

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

function formatDateInputValue(date) {
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInput(value, { endOfDay = false } = {}) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  if (endOfDay) {
    return new Date(year, month - 1, day, 23, 59, 59, 999);
  }
  return new Date(year, month - 1, day, 0, 0, 0, 0);
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

function loadDeliveryState() {
  try {
    const raw = JSON.parse(localStorage.getItem(DELIVERY_STATE_KEY) || "{}");
    state.deliveryState = raw && typeof raw === "object" ? raw : {};
    Object.values(state.deliveryState).forEach((entry) => {
      if (!entry || typeof entry !== "object" || !entry.items) return;
      Object.keys(entry.items).forEach((key) => {
        const value = entry.items[key];
        if (typeof value === "string") {
          if (value === "pulled") {
            entry.items[key] = { status: "Pulled" };
          } else if (value === "unavailable") {
            entry.items[key] = { status: "Unavailable", pulledQty: 0 };
          }
        }
      });
    });
  } catch (err) {
    state.deliveryState = {};
  }
}

function normalizeItem(item) {
  const normalized = normalizeRowKeys(item);
  return {
    sku: normalized.sku || item.sku || "",
    item_no: normalized.item_no || item.item_no || "",
    name: normalized.name || item.name || "",
  };
}

function itemKey(item) {
  const normalized = normalizeItem(item);
  return normalized.sku || normalized.item_no || normalized.name;
}

function parsePulledQtyFromStatus(status, orderedQty) {
  if (!status) return null;
  const normalized = String(status).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("unavailable")) return 0;
  if (normalized.startsWith("not pulled")) return 0;
  if (normalized.startsWith("pulled")) return orderedQty;
  const match = normalized.match(/partially collected\s+(\d+)\s+of\s+(\d+)/);
  if (match) {
    const pulled = Number(match[1]);
    if (Number.isFinite(pulled)) return pulled;
  }
  return null;
}

function getDeliveredQty(orderId, item) {
  const key = itemKey(item);
  if (!key) return 0;
  const orderState = state.deliveryState[orderId] || state.deliveryState[String(orderId).trim()];
  const itemState = orderState?.items?.[key];
  if (!itemState) return 0;
  const orderedQty = Number(item.qty || 0) || 0;
  const overridePulled = itemState.pulledQty;
  const statusLabel = itemState.status || "";
  const parsedPulled = parsePulledQtyFromStatus(statusLabel, orderedQty);
  if (Number.isFinite(overridePulled)) return overridePulled;
  if (Number.isFinite(parsedPulled)) return parsedPulled;
  return 0;
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
    if (db !== da) return db - da;
    return String(a.order_id || "").localeCompare(String(b.order_id || ""), undefined, {
      sensitivity: "base",
    });
  });
}

function sortStores(stores) {
  return [...stores].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const nameCompare = String(a.name || a.sku || "").localeCompare(
      String(b.name || b.sku || ""),
      undefined,
      { sensitivity: "base" }
    );
    if (nameCompare !== 0) return nameCompare;
    return String(a.sku || "").localeCompare(String(b.sku || ""), undefined, {
      sensitivity: "base",
    });
  });
}

function filterOrdersByDate(orders) {
  const { start, end } = state.filter;
  if (!start && !end) return orders;
  return orders.filter((order) => {
    const createdAt = parseDate(order.created_at);
    if (!createdAt) return false;
    if (start && createdAt < start) return false;
    if (end && createdAt > end) return false;
    return true;
  });
}

function applyOrdersPayload(payload) {
  const previousUpdatedAt = state.ordersUpdatedAt;
  state.catalog = AppClient.loadCatalog?.() || null;
  state.orders = Array.isArray(payload.orders) ? payload.orders : [];
  const items = Array.isArray(payload.items) ? payload.items : [];
  state.items = AppClient.enrichItemsWithCatalog(items, state.catalog);
  const updatedAt = payload.updatedAt || payload.updated_at || "";
  state.ordersUpdatedAt = updatedAt || previousUpdatedAt || "";
  if (updatedAt) {
    setText(ui.updated, `Orders: ${new Date(updatedAt).toLocaleString()}`);
  }
  loadDeliveryState();
  renderHistory();
}

function renderHistory() {
  ui.content.innerHTML = "";
  loadDeliveryState();

  const filteredOrders = filterOrdersByDate(state.orders);

  if (!filteredOrders.length) {
    ui.content.innerHTML = `<div class="historyEmpty">No orders found for the selected dates.</div>`;
    return;
  }

  const itemsByOrder = groupItemsByOrder(state.items);
  const stores = new Map();

  for (const order of filteredOrders) {
    const store = String(order.store || "Unknown Store").trim() || "Unknown Store";
    if (!stores.has(store)) stores.set(store, []);
    stores.get(store).push(order);
  }

  const sortedStores = sortStores(stores.keys());

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
          <div class="historyOrder__title">Order from: ${escapeHtml(createdAt)} · ${escapeHtml(storeName)}</div>
          <div class="historyOrder__subtitle">${escapeHtml(orderId)}</div>
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
          <div><strong>Notes:</strong> ${escapeHtml(order.notes || "—")}</div>
        </div>
      `;

      const items = sortItems(itemsByOrder.get(orderId) || []);
      const itemsWrap = document.createElement("div");
      itemsWrap.className = "historyItems";

      if (!items.length) {
        itemsWrap.innerHTML = `<div class="historyEmpty">No items recorded for this order.</div>`;
      } else {
        const headerRow = document.createElement("div");
        headerRow.className = "historyItem historyItem--header";
        headerRow.innerHTML = `
          <div class="historyItem__name">Item</div>
          <div class="historyItem__qtyGroup">
            <div class="historyItem__qtyColumn">
              <div class="historyItem__qtyLabel">Ordered</div>
            </div>
            <div class="historyItem__qtyColumn">
              <div class="historyItem__qtyLabel">Delivered</div>
            </div>
          </div>
        `;
        itemsWrap.appendChild(headerRow);
        items.forEach((item) => {
          const deliveredQty = getDeliveredQty(orderId, item);
          const itemDiv = document.createElement("div");
          itemDiv.className = "historyItem";
          itemDiv.innerHTML = `
            <div>
              <div class="historyItem__name">${escapeHtml(item.name || item.sku || "Item")}</div>
              <div class="historyItem__meta">
                ${escapeHtml([item.item_no, item.category, item.unit, item.pack_size].filter(Boolean).join(" • "))}
              </div>
            </div>
            <div class="historyItem__qtyGroup">
              <div class="historyItem__qtyColumn">
                <div class="historyItem__qty historyItem__qty--ordered">${escapeHtml(String(item.qty || ""))}</div>
              </div>
              <div class="historyItem__qtyColumn">
                <div class="historyItem__qty historyItem__qty--delivered">${escapeHtml(String(deliveredQty))}</div>
              </div>
            </div>
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

async function refreshHistory(button) {
  showError("");
  AppClient.hideBanner?.();
  AppClient.setRefreshState(button || ui.refreshBtn, true, "Refreshing…");

  try {
    const payload = await AppClient.refreshOrders({ force: true });
    const responseUpdatedAt = payload.updatedAt || payload.updated_at || "";
    const previousUpdatedAt = state.ordersUpdatedAt;
    applyOrdersPayload(payload);
    if (responseUpdatedAt && previousUpdatedAt && responseUpdatedAt === previousUpdatedAt) {
      setText(ui.status, "History: Fully Updated");
    } else {
      setText(ui.status, "History: updated");
    }
    AppClient.showToast(`Loaded ${state.orders.length} orders.`, "success");
  } catch (err) {
    const message = err.userMessage || err.message || String(err);
    showError(message);
    AppClient.showBanner(`History refresh failed. ${message}`, "warning");
    AppClient.showToast("History refresh failed.", "error");
  } finally {
    AppClient.setRefreshState(button || ui.refreshBtn, false);
  }
}

function loadFromCache() {
  const cachedOrders = AppClient.loadOrders?.();
  if (cachedOrders) {
    applyOrdersPayload(cachedOrders);
    setText(ui.status, "History: loaded from cache.");
  }
}

function updateDateFilter() {
  state.filter.start = parseDateInput(ui.startDate?.value);
  state.filter.end = parseDateInput(ui.endDate?.value, { endOfDay: true });
  renderHistory();
}

function setDefaultDateFilter() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 6);
  if (ui.startDate) ui.startDate.value = formatDateInputValue(startDate);
  if (ui.endDate) ui.endDate.value = formatDateInputValue(endDate);
  updateDateFilter();
}

function init() {
  loadFromCache();
  setDefaultDateFilter();
  ui.startDate?.addEventListener("change", updateDateFilter);
  ui.endDate?.addEventListener("change", updateDateFilter);
  AppClient.bindRefreshButtons({
    orders: (button) => refreshHistory(button),
  });
  AppClient.watchNetworkStatus((online) => {
    if (!online) {
      AppClient.showBanner("You are offline. Showing cached history.", "warning");
    } else {
      AppClient.hideBanner();
    }
  });
  refreshHistory(ui.refreshBtn);
}

init();
