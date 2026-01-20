const CACHE = {
  ORDERS: "orderportal_orders_v1",
};

const ui = {
  deliveryDate: document.getElementById("deliveryDate"),
  deliveryOrders: document.getElementById("deliveryOrders"),
  refreshBtn: document.getElementById("deliveryRefreshBtn"),
};

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

let orders = [];

function loadOrders() {
  const stored = safeJsonParse(localStorage.getItem(CACHE.ORDERS) || "[]", []);
  orders = Array.isArray(stored) ? stored : [];
}

function saveOrders() {
  localStorage.setItem(CACHE.ORDERS, JSON.stringify(orders));
}

function normalizeOrder(order) {
  return {
    ...order,
    delivery: {
      status: order?.delivery?.status || "pending",
      items: order?.delivery?.items || {},
    },
  };
}

function itemKey(item) {
  return item.sku || item.item_no || item.name;
}

function getItemStatus(order, key) {
  return order.delivery.items?.[key] || "";
}

function setItemStatus(orderId, key, status) {
  orders = orders.map((order) => {
    if (order.id !== orderId) return order;
    const updated = normalizeOrder(order);
    if (!status) {
      delete updated.delivery.items[key];
    } else {
      updated.delivery.items[key] = status;
    }
    if (!isOrderComplete(updated)) {
      updated.delivery.status = "pending";
    }
    return updated;
  });
  saveOrders();
}

function markReady(orderId) {
  orders = orders.map((order) => {
    if (order.id !== orderId) return order;
    const updated = normalizeOrder(order);
    updated.delivery.status = "ready";
    return updated;
  });
  saveOrders();
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
    Array.from(ui.deliveryOrders.querySelectorAll("details[open]"))
      .map((el) => el.getAttribute("data-order-id"))
  );

  ui.deliveryOrders.innerHTML = "";

  const normalizedOrders = orders
    .map(normalizeOrder)
    .map(syncOrderStatus);

  const statusChanged = normalizedOrders.some((order, index) => {
    const prev = orders[index];
    return prev?.delivery?.status !== order.delivery.status;
  });

  if (statusChanged) {
    orders = normalizedOrders;
    saveOrders();
  }

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

    details.appendChild(itemList);

    const footer = document.createElement("div");
    footer.className = "deliveryFooter";

    if (order.delivery.status === "ready") {
      const readyBadge = document.createElement("div");
      readyBadge.className = "statusBadge";
      readyBadge.textContent = "✓ Marked ready for delivery";
      footer.appendChild(readyBadge);
    } else if (isOrderComplete(order)) {
      const readyBtn = document.createElement("button");
      readyBtn.type = "button";
      readyBtn.className = "btn btn--primary";
      readyBtn.textContent = "Mark as Ready for Delivery";
      readyBtn.addEventListener("click", () => {
        markReady(order.id);
        renderOrders();
      });
      footer.appendChild(readyBtn);
    } else {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Mark all items pulled or unavailable to enable delivery.";
      footer.appendChild(hint);
    }

    details.appendChild(footer);
    ui.deliveryOrders.appendChild(details);
  });
}

function init() {
  if (ui.deliveryDate) {
    ui.deliveryDate.textContent = `Orders for ${todayDateValue()}`;
  }
  loadOrders();
  renderOrders();
  ui.refreshBtn?.addEventListener("click", () => {
    loadOrders();
    renderOrders();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === CACHE.ORDERS) {
      loadOrders();
      renderOrders();
    }
  });
}

init();
