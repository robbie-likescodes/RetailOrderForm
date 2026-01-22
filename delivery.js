const ui = {
  deliveryDate: document.getElementById("deliveryDate"),
  deliveryOrders: document.getElementById("deliveryOrders"),
  refreshBtn: document.getElementById("deliveryRefreshBtn"),
};

const DELIVERY_STATE_KEY = "orderportal_delivery_state_v1";
const ORDER_STATUS = {
  NOT_STARTED: "Not Started",
  INCOMPLETE: "Incomplete",
  COMPLETE: "Complete",
};

let orders = [];
let deliveryState = {};

function setText(el, txt) {
  if (!el) return;
  el.textContent = txt;
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

function todayDateValue() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

function normalizeDateValue(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  if (raw.includes("/")) {
    const parts = raw.split("/");
    if (parts.length === 3) {
      const month = Number(parts[0]);
      const day = Number(parts[1]);
      let year = Number(parts[2]);
      if (year < 100) year += 2000;
      if (month && day && year) {
        return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadDeliveryState() {
  try {
    const raw = JSON.parse(localStorage.getItem(DELIVERY_STATE_KEY) || "{}");
    deliveryState = raw && typeof raw === "object" ? raw : {};
  } catch (err) {
    deliveryState = {};
  }
}

function saveDeliveryState() {
  localStorage.setItem(DELIVERY_STATE_KEY, JSON.stringify(deliveryState));
}

function attachItemsToOrders(ordersList, itemsList) {
  if (!Array.isArray(ordersList)) return [];
  const itemsByOrder = new Map();
  (itemsList || []).forEach((item) => {
    const orderId = String(item.order_id || item.orderId || "").trim();
    if (!orderId) return;
    if (!itemsByOrder.has(orderId)) itemsByOrder.set(orderId, []);
    itemsByOrder.get(orderId).push(item);
  });

  return ordersList.map((order) => {
    const orderId = String(order.order_id || order.id || "").trim();
    const items = order.items || itemsByOrder.get(orderId) || [];
    const enrichedItems = AppClient.enrichItemsWithCatalog(items, AppClient.loadCatalog?.());
    return { ...order, items: enrichedItems };
  });
}

function normalizeItemRows(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const normalized = normalizeRowKeys(item);
    return {
      sku: normalized.sku || item.sku || "",
      item_no: normalized.item_no || item.item_no || "",
      name: normalized.name || item.name || "",
      unit: normalized.unit || item.unit || "",
      pack_size: normalized.pack_size || item.pack_size || "",
      qty: Number(normalized.qty ?? item.qty ?? 0) || 0,
      order_id: normalized.order_id || item.order_id || item.orderId || "",
    };
  });
}

function normalizeOrderRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const normalized = normalizeRowKeys(row);
    const items = Array.isArray(row.items) ? row.items : normalized.items;
    return {
      id: normalized.id || normalized.order_id || row.id || row.order_id || "",
      store: normalized.store || row.store || "",
      requested_date: normalizeDateValue(normalized.requested_date || row.requested_date || ""),
      placed_by: normalized.placed_by || row.placed_by || "",
      notes: normalized.notes || row.notes || "",
      items: Array.isArray(items) ? normalizeItemRows(items) : [],
      created_at: normalized.created_at || row.created_at || "",
    };
  });
}

function normalizeOrder(order) {
  const existingDelivery = deliveryState[order.id] || deliveryState[order.order_id] || {};
  const hasItems = existingDelivery.items && Object.keys(existingDelivery.items).length > 0;
  return {
    ...order,
    id: order.id || order.order_id || orderIdFallback(order),
    delivery: {
      status: existingDelivery.status || order?.delivery?.status || order?.status || ORDER_STATUS.NOT_STARTED,
      items: existingDelivery.items || order?.delivery?.items || {},
      touched: existingDelivery.touched || hasItems,
    },
  };
}

function orderIdFallback(order) {
  return String(order.order_id || order.id || `row_${Math.random().toString(36).slice(2)}`);
}

function itemKey(item) {
  return item.sku || item.item_no || item.name;
}

function getItemStatus(order, key) {
  return order.delivery.items?.[key] || "";
}

function deriveOrderStatus(order, itemsMap, fallbackStatus, touched) {
  const totalItems = Array.isArray(order.items) ? order.items.length : 0;
  if (!totalItems) return fallbackStatus || ORDER_STATUS.NOT_STARTED;
  const checkedCount = order.items.reduce((count, item) => {
    const status = itemsMap?.[itemKey(item)];
    if (!status) return count;
    if (status === "pulled" || status === "unavailable") return count + 1;
    return count;
  }, 0);

  if (checkedCount === 0) {
    if (!touched && fallbackStatus) return fallbackStatus;
    return ORDER_STATUS.NOT_STARTED;
  }
  if (checkedCount === totalItems) return ORDER_STATUS.COMPLETE;
  return ORDER_STATUS.INCOMPLETE;
}

async function pushOrderStatus(orderId, status) {
  if (!AppClient?.updateOrderStatus) return;
  try {
    await AppClient.updateOrderStatus(orderId, status);
  } catch (err) {
    const message = err?.userMessage || err?.message || String(err);
    AppClient.showToast?.(`Failed to sync status: ${message}`, "warning");
  }
}

function setItemStatus(order, key, status) {
  const orderId = order.id;
  const next = deliveryState[orderId] || {
    status: order?.status || order?.delivery?.status || ORDER_STATUS.NOT_STARTED,
    items: {},
    touched: false,
  };
  const previousStatus = next.status || ORDER_STATUS.NOT_STARTED;
  if (!status) {
    delete next.items[key];
  } else {
    next.items[key] = status;
  }
  next.touched = true;
  const derivedStatus = deriveOrderStatus(order, next.items, previousStatus, next.touched);
  next.status = derivedStatus;
  deliveryState[orderId] = next;
  saveDeliveryState();
  if (derivedStatus !== previousStatus) {
    pushOrderStatus(orderId, derivedStatus);
  }
}

function renderOrders() {
  if (!ui.deliveryOrders) return;
  const today = todayDateValue();
  const openIds = new Set(
    Array.from(ui.deliveryOrders.querySelectorAll("details[open]"))
      .map((el) => el.getAttribute("data-order-id"))
  );

  ui.deliveryOrders.innerHTML = "";

  const normalizedOrders = orders
    .map(normalizeOrder);

  const todaysOrders = normalizedOrders
    .filter((order) => order.requested_date === today);

  if (todaysOrders.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emptyState";
    empty.textContent = "No delivery orders found for today.";
    ui.deliveryOrders.appendChild(empty);
    return;
  }

  todaysOrders.forEach((order) => {
    const details = document.createElement("details");
    details.className = "deliveryOrder";
    details.setAttribute("data-order-id", order.id);

    if (openIds.has(order.id)) {
      details.open = true;
    }

    const summary = document.createElement("summary");
    const summaryLeft = document.createElement("div");
    summaryLeft.innerHTML = `
      <div class="deliveryOrder__title">${escapeHtml(order.store || "Unknown Store")}</div>
      <div class="deliveryOrder__meta">${escapeHtml(order.placed_by || "Unknown")} • ${escapeHtml(order.requested_date || today)}</div>
    `;

    const summaryRight = document.createElement("div");
    const derivedStatus = deriveOrderStatus(
      order,
      order.delivery.items,
      order.delivery.status || order.status,
      order.delivery.touched
    );
    if (derivedStatus !== order.delivery.status) {
      deliveryState[order.id] = {
        status: derivedStatus,
        items: order.delivery.items,
        touched: order.delivery.touched,
      };
      saveDeliveryState();
    }
    const isComplete = derivedStatus === ORDER_STATUS.COMPLETE;
    summaryRight.className = isComplete ? "statusBadge" : "statusBadge statusBadge--pending";
    summaryRight.textContent = derivedStatus;

    summary.appendChild(summaryLeft);
    summary.appendChild(summaryRight);
    details.appendChild(summary);

    const itemList = document.createElement("div");
    itemList.className = "itemList";

    order.items.forEach((item) => {
      const key = itemKey(item);
      const status = getItemStatus(order, key);

      const row = document.createElement("div");
      row.className = "itemRow";
      if (status === "pulled") row.classList.add("itemRow--pulled");
      if (status === "unavailable") row.classList.add("itemRow--unavailable");

      const checks = document.createElement("div");
      checks.className = "itemRow__checks";

      const pulledId = `${order.id}-${key}-pulled`;
      const unavailableId = `${order.id}-${key}-unavailable`;

      const pulledLabel = document.createElement("label");
      pulledLabel.innerHTML = `
        <input type="checkbox" id="${escapeHtml(pulledId)}" ${status === "pulled" ? "checked" : ""} />
        Pulled
      `;

      const unavailableLabel = document.createElement("label");
      unavailableLabel.innerHTML = `
        <input type="checkbox" id="${escapeHtml(unavailableId)}" ${status === "unavailable" ? "checked" : ""} />
        Unavailable
      `;

      checks.appendChild(pulledLabel);
      checks.appendChild(unavailableLabel);

      const label = document.createElement("div");
      label.className = "itemRow__label";
      label.innerHTML = `
        <div>${escapeHtml(item.name || "Item")}</div>
        <div class="itemRow__meta">${escapeHtml([item.item_no, item.unit, item.pack_size, `Qty: ${item.qty}`].filter(Boolean).join(" • "))}</div>
      `;

      row.appendChild(checks);
      row.appendChild(label);

      const pulledInput = pulledLabel.querySelector("input");
      const unavailableInput = unavailableLabel.querySelector("input");

      pulledInput.addEventListener("change", () => {
        const nextStatus = pulledInput.checked ? "pulled" : "";
        if (pulledInput.checked) unavailableInput.checked = false;
        setItemStatus(order, key, nextStatus);
        renderOrders();
      });

      unavailableInput.addEventListener("change", () => {
        const nextStatus = unavailableInput.checked ? "unavailable" : "";
        if (unavailableInput.checked) pulledInput.checked = false;
        setItemStatus(order, key, nextStatus);
        renderOrders();
      });

      itemList.appendChild(row);
    });
    details.appendChild(itemList);
    ui.deliveryOrders.appendChild(details);
  });
}

function applyOrdersPayload(payload) {
  const normalizedOrders = normalizeOrderRows(payload.orders || []);
  const normalizedItems = normalizeItemRows(payload.items || []);
  const merged = attachItemsToOrders(normalizedOrders, normalizedItems);
  orders = merged.map((order) => ({
    ...order,
    id: String(order.id || order.order_id || order.orderId || ""),
    requested_date: normalizeDateValue(order.requested_date || ""),
  }));
  renderOrders();
}

async function refreshOrders(button) {
  AppClient.setRefreshState(button || ui.refreshBtn, true, "Refreshing…");
  try {
    const payload = await AppClient.refreshOrders({ force: true });
    applyOrdersPayload(payload);
    AppClient.showToast(`Loaded ${orders.length} orders.`, "success");
  } catch (err) {
    const message = err.userMessage || err.message || String(err);
    AppClient.showBanner(`Unable to refresh orders. ${message}`, "warning");
    AppClient.showToast("Order refresh failed.", "error");
  } finally {
    AppClient.setRefreshState(button || ui.refreshBtn, false);
  }
}

function loadFromCache() {
  const cachedOrders = AppClient.loadOrders?.();
  if (cachedOrders) {
    applyOrdersPayload(cachedOrders);
  }
}

function init() {
  loadDeliveryState();
  loadFromCache();
  setText(ui.deliveryDate, `Today: ${todayDateValue()}`);
  AppClient.bindRefreshButtons({
    orders: (button) => refreshOrders(button),
  });
  if (ui.refreshBtn) {
    ui.refreshBtn.addEventListener("click", () => refreshOrders(ui.refreshBtn));
  }
  AppClient.watchNetworkStatus((online) => {
    if (!online) {
      AppClient.showBanner("You are offline. Showing cached delivery orders.", "warning");
    } else {
      AppClient.hideBanner();
    }
  });
  refreshOrders(ui.refreshBtn);
}

init();
