const ui = {
  deliveryDate: document.getElementById("deliveryDate"),
  deliveryOrders: document.getElementById("deliveryOrders"),
  refreshBtn: document.getElementById("deliveryRefreshBtn"),
};

const DELIVERY_STATE_KEY = "orderportal_delivery_state_v1";
const ORDER_STATUS = {
  NOT_STARTED: "Not Started",
  IN_PROGRESS: "In Progress",
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
    Object.values(deliveryState).forEach((state) => {
      if (!state || typeof state !== "object" || !state.items) return;
      Object.keys(state.items).forEach((key) => {
        const value = state.items[key];
        if (typeof value === "string") {
          if (value === "pulled") {
            state.items[key] = { status: "Collected" };
          } else if (value === "unavailable") {
            state.items[key] = { status: "Unavailable", pulledQty: 0 };
          }
        }
      });
    });
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
      status: normalized.status || item.status || "",
      product_index: Number(normalized.product_index ?? item.product_index ?? 0) || 0,
      order_id: normalized.order_id || item.order_id || item.orderId || "",
    };
  });
}

function normalizeOrderRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const normalized = normalizeRowKeys(row);
    const items = Array.isArray(row.items) ? row.items : normalized.items;
    const timestampValue = normalized.timestamp || row.timestamp || normalized.created_at || row.created_at || "";
    return {
      id: normalized.id || normalized.order_id || row.id || row.order_id || "",
      store: normalized.store || row.store || "",
      requested_date: normalizeDateValue(normalized.requested_date || row.requested_date || ""),
      placed_by: normalized.placed_by || row.placed_by || "",
      notes: normalized.notes || row.notes || "",
      items: Array.isArray(items) ? normalizeItemRows(items) : [],
      created_at: normalized.created_at || row.created_at || "",
      timestamp: timestampValue,
      created_date: normalizeDateValue(timestampValue),
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

function getItemOverride(order, key) {
  const orderState = deliveryState[order.id] || deliveryState[order.order_id] || {};
  const itemState = orderState.items?.[key];
  if (!itemState) return null;
  if (typeof itemState === "string") {
    return { status: itemState };
  }
  return itemState;
}

function parsePulledQtyFromStatus(status, orderedQty) {
  if (!status) return null;
  const normalized = String(status).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("unavailable")) return 0;
  if (normalized.startsWith("collected")) return orderedQty;
  const match = normalized.match(/partially collected\s+(\d+)\s+of\s+(\d+)/);
  if (match) {
    const pulled = Number(match[1]);
    if (Number.isFinite(pulled)) return pulled;
  }
  return null;
}

function buildItemStatusLabel(pulledQty, orderedQty) {
  if (pulledQty <= 0) return "Unavailable";
  if (pulledQty >= orderedQty) return "Collected";
  return `Partially Collected ${pulledQty} of ${orderedQty}`;
}

function getItemProgress(order, item) {
  const orderedQty = Number(item.qty || 0) || 0;
  const key = itemKey(item);
  const override = getItemOverride(order, key);
  const overridePulled = override?.pulledQty;
  const statusLabel = override?.status || item.status || "";
  const parsedPulled = parsePulledQtyFromStatus(statusLabel, orderedQty);
  const pulledQty = Number.isFinite(overridePulled) ? overridePulled : (Number.isFinite(parsedPulled) ? parsedPulled : 0);
  const state = pulledQty <= 0 ? "unavailable" : (pulledQty >= orderedQty ? "collected" : "partial");
  const touched = Boolean(statusLabel) || Number.isFinite(overridePulled);
  return { orderedQty, pulledQty, state, statusLabel, touched };
}

function deriveOrderStatusFromItems(order, fallbackStatus) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) return fallbackStatus || ORDER_STATUS.NOT_STARTED;
  let collectedCount = 0;
  let touchedCount = 0;
  items.forEach((item) => {
    const progress = getItemProgress(order, item);
    if (progress.touched) touchedCount += 1;
    if (progress.state === "collected") collectedCount += 1;
  });
  if (collectedCount === items.length) return ORDER_STATUS.COMPLETE;
  if (touchedCount === 0) return ORDER_STATUS.NOT_STARTED;
  return ORDER_STATUS.IN_PROGRESS;
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

async function pushItemStatus(orderId, item, status) {
  if (!AppClient?.updateOrderItemStatus) return;
  try {
    await AppClient.updateOrderItemStatus({
      orderId,
      productIndex: item.product_index || item.productIndex || "",
      productName: item.name || "",
      status,
    });
  } catch (err) {
    const message = err?.userMessage || err?.message || String(err);
    AppClient.showToast?.(`Failed to sync item status: ${message}`, "warning");
  }
}

function setItemStatus(order, item, status, pulledQty) {
  const orderId = order.id;
  const next = deliveryState[orderId] || {
    status: order?.status || order?.delivery?.status || ORDER_STATUS.NOT_STARTED,
    items: {},
    touched: false,
  };
  const previousStatus = next.status || ORDER_STATUS.NOT_STARTED;
  const key = itemKey(item);
  next.items[key] = { status, pulledQty };
  next.touched = true;
  const derivedStatus = deriveOrderStatusFromItems(order, previousStatus);
  next.status = derivedStatus;
  deliveryState[orderId] = next;
  saveDeliveryState();
  if (derivedStatus !== previousStatus) {
    pushOrderStatus(orderId, derivedStatus);
  }
  pushItemStatus(orderId, item, status);
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
    .filter((order) => (order.requested_date === today || order.created_date === today))
    .sort((a, b) => String(a.store || "").localeCompare(String(b.store || "")));

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
      <div class="deliveryOrder__meta">${escapeHtml(order.placed_by || "Unknown")} • ${escapeHtml(order.requested_date || order.created_date || today)}</div>
    `;

    const summaryRight = document.createElement("div");
    summaryRight.className = "deliveryOrder__summaryRight";
    const derivedStatus = deriveOrderStatusFromItems(order, order.delivery.status || order.status);
    if (derivedStatus !== order.delivery.status) {
      deliveryState[order.id] = {
        status: derivedStatus,
        items: order.delivery.items,
        touched: order.delivery.touched,
      };
      saveDeliveryState();
    }
    const isComplete = derivedStatus === ORDER_STATUS.COMPLETE;
    const statusBadge = document.createElement("div");
    statusBadge.className = isComplete ? "statusBadge" : "statusBadge statusBadge--pending";
    statusBadge.textContent = derivedStatus;

    const toggleHint = document.createElement("div");
    toggleHint.className = "deliveryOrder__toggle";
    toggleHint.innerHTML = `
      <span>Items</span>
      <svg class="deliveryOrder__chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M5 7.5l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `;

    summaryRight.appendChild(statusBadge);
    summaryRight.appendChild(toggleHint);

    summary.appendChild(summaryLeft);
    summary.appendChild(summaryRight);
    details.appendChild(summary);

    const itemList = document.createElement("div");
    itemList.className = "itemList";

    order.items.forEach((item) => {
      const progress = getItemProgress(order, item);
      const statusLabel = progress.touched
        ? (progress.statusLabel || buildItemStatusLabel(progress.pulledQty, progress.orderedQty))
        : "Not Started";

      const row = document.createElement("div");
      row.className = "itemRow";
      if (progress.touched) {
        if (progress.state === "collected") row.classList.add("itemRow--collected");
        if (progress.state === "partial") row.classList.add("itemRow--partial");
        if (progress.state === "unavailable") row.classList.add("itemRow--unavailable");
      }

      const controls = document.createElement("div");
      controls.className = "itemRow__controls";

      const selectLabel = document.createElement("label");
      selectLabel.className = "itemRow__controlLabel";
      selectLabel.textContent = "Pulled";

      const select = document.createElement("select");
      select.className = "itemRow__select";
      select.setAttribute("aria-label", `Pulled quantity for ${item.name || "item"}`);

      const maxQty = Math.max(Number(item.qty || 0) || 0, 0);
      for (let i = 0; i <= maxQty; i += 1) {
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = String(i);
        if (i === progress.pulledQty) option.selected = true;
        select.appendChild(option);
      }

      controls.appendChild(selectLabel);
      controls.appendChild(select);

      const label = document.createElement("div");
      label.className = "itemRow__label";
      label.innerHTML = `
        <div>${escapeHtml(item.name || "Item")}</div>
        <div class="itemRow__meta">${escapeHtml([item.item_no, item.unit, item.pack_size, `Ordered: ${item.qty}`].filter(Boolean).join(" • "))}</div>
        <div class="itemRow__status">${escapeHtml(statusLabel)}</div>
      `;

      row.appendChild(controls);
      row.appendChild(label);

      select.addEventListener("change", () => {
        const nextPulled = Number(select.value || 0);
        const nextStatus = buildItemStatusLabel(nextPulled, progress.orderedQty);
        setItemStatus(order, item, nextStatus, nextPulled);
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
