const ui = {
  deliveryDate: document.getElementById("deliveryDate"),
  deliveryOrders: document.getElementById("deliveryOrders"),
  refreshBtn: document.getElementById("deliveryRefreshBtn"),
};

const DELIVERY_STATE_KEY = "orderportal_delivery_state_v1";

let orders = [];
let deliveryState = {};

function setText(el, txt) {
  if (!el) return;
  el.textContent = txt;
}

function todayDateValue() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
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
    const orderId = String(item.order_id || "").trim();
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

function normalizeOrder(order) {
  const existingDelivery = deliveryState[order.id] || deliveryState[order.order_id] || {};
  return {
    ...order,
    id: order.id || order.order_id || orderIdFallback(order),
    delivery: {
      status: existingDelivery.status || order?.delivery?.status || "pending",
      items: existingDelivery.items || order?.delivery?.items || {},
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

function setItemStatus(orderId, key, status) {
  const next = deliveryState[orderId] || { status: "pending", items: {} };
  if (!status) {
    delete next.items[key];
  } else {
    next.items[key] = status;
  }
  if (!isOrderCompleteByMap(next.items)) {
    next.status = "pending";
  }
  deliveryState[orderId] = next;
  saveDeliveryState();
}

function markReady(orderId) {
  const next = deliveryState[orderId] || { status: "pending", items: {} };
  next.status = "ready";
  deliveryState[orderId] = next;
  saveDeliveryState();
}

function isOrderCompleteByMap(itemsMap) {
  return Object.values(itemsMap || {}).every((status) => status === "pulled" || status === "unavailable");
}

function isOrderComplete(order) {
  return order.items.every((item) => {
    const status = getItemStatus(order, itemKey(item));
    return status === "pulled" || status === "unavailable";
  });
}

function syncOrderStatus(order) {
  if (order.delivery.status === "ready" && !isOrderComplete(order)) {
    return { ...order, delivery: { ...order.delivery, status: "pending" } };
  }
  return order;
}

function renderOrders() {
  if (!ui.deliveryOrders) return;
  const today = todayDateValue();
  const openIds = new Set(
    Array.from(ui.deliveryOrders.querySelectorAll("details[open]")
      .map((el) => el.getAttribute("data-order-id"))
  );

  ui.deliveryOrders.innerHTML = "";

  const normalizedOrders = orders
    .map(normalizeOrder)
    .map(syncOrderStatus);

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
    const ready = order.delivery.status === "ready";
    summaryRight.className = ready ? "statusBadge" : "statusBadge statusBadge--pending";
    summaryRight.textContent = ready ? "✓ Ready" : "In progress";

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
        setItemStatus(order.id, key, nextStatus);
        renderOrders();
      });

      unavailableInput.addEventListener("change", () => {
        const nextStatus = unavailableInput.checked ? "unavailable" : "";
        if (unavailableInput.checked) pulledInput.checked = false;
        setItemStatus(order.id, key, nextStatus);
        renderOrders();
      });

      itemList.appendChild(row);
    });

    const footer = document.createElement("div");
    footer.className = "deliveryFooter";

    const readyBtn = document.createElement("button");
    readyBtn.className = "btn btn--primary";
    readyBtn.textContent = "Mark Ready";
    readyBtn.disabled = !isOrderComplete(order);
    readyBtn.addEventListener("click", () => {
      markReady(order.id);
      renderOrders();
    });

    footer.appendChild(readyBtn);
    details.appendChild(itemList);
    details.appendChild(footer);
    ui.deliveryOrders.appendChild(details);
  });
}

function applyOrdersPayload(payload) {
  const merged = attachItemsToOrders(payload.orders || [], payload.items || []);
  orders = merged.map((order) => ({
    ...order,
    id: String(order.order_id || order.id || ""),
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
