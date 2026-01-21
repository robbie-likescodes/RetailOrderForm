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
};

const state = {
  orders: [],
  items: [],
  catalog: null,
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

function applyOrdersPayload(payload) {
  state.catalog = AppClient.loadCatalog?.() || null;
  state.orders = Array.isArray(payload.orders) ? payload.orders : [];
  const items = Array.isArray(payload.items) ? payload.items : [];
  state.items = AppClient.enrichItemsWithCatalog(items, state.catalog);
  const updatedAt = payload.updatedAt || payload.updated_at || "";
  if (updatedAt) {
    setText(ui.updated, `Orders: ${new Date(updatedAt).toLocaleString()}`);
  }
  renderHistory();
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

      const items = sortItems(itemsByOrder.get(orderId) || []);
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

async function refreshHistory(button) {
  showError("");
  AppClient.hideBanner?.();
  AppClient.setRefreshState(button || ui.refreshBtn, true, "Refreshing…");

  try {
    const payload = await AppClient.refreshOrders({ force: true });
    applyOrdersPayload(payload);
    setText(ui.status, "History: updated");
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

function init() {
  loadFromCache();
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
