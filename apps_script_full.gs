/**
 * Retail Order Portal - Google Apps Script Web App (Full)
 * -------------------------------------------------------
 * Endpoints:
 *  GET  /exec?action=categories
 *  GET  /exec?action=products
 *  GET  /exec?action=listOrders
 *  GET  /exec?action=health
 *  POST /exec?action=submitOrder
 *  POST /exec?action=updateOrderStatus
 *  POST /exec?action=updateOrderItemStatus
 */

const CONFIG = {
  spreadsheetId: "",
  apiVersion: "2026-01-21",
  officeEmail: "robbie@brewersak.com",
  auth: {
    requireToken: false,
    // Token auth intentionally disabled for "anyone with link" mode.
    sharedToken: "",
  },
  cors: {
    allowOrigin: "*",
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "Content-Type, Cache-Control, Pragma",
    maxAgeSeconds: "3600",
  },
  sheets: {
    categories: "Categories",
    products: "Products",
    orders: "Orders",
    orderItems: "OrderItems",
    orderErrors: "OrderErrors",
    contacts: "Contacts",
  },
};

function doGet(e) {
  const requestId = Utilities.getUuid();
  try {
    const action = getAction_(e).toLowerCase();
    Logger.log("doGet request %s action=%s cid=%s", requestId, action, getCorrelationId_(e));

    if (!action) {
      return jsonResponse(buildError_(
        "Missing action.",
        "MISSING_ACTION",
        { expected: ["categories", "products", "listOrders", "health"] },
        requestId
      ));
    }

    if (action === "categories") {
      const rows = getSheetRows_(CONFIG.sheets.categories)
        .filter(row => getFirstValue_(row, ["category", "category_name", "department", "dept"]) && isRowActive_(row))
        .map(row => ({
          category: String(getFirstValue_(row, ["category", "category_name", "department", "dept"]) || "").trim(),
          display_name: String(getFirstValue_(row, ["display_name", "display", "name", "category", "category_name"]) || "").trim(),
          sort: Number(getFirstValue_(row, ["sort", "order", "display_order"]) || 9999),
        }))
        .sort((a, b) => a.sort - b.sort);

      return jsonResponse(buildSuccess_({ action, request_id: requestId, categories: rows }, requestId));
    }

    if (action === "products") {
      const rows = getSheetRows_(CONFIG.sheets.products)
        .filter(row => {
          const sku = getFirstValue_(row, ["sku", "product_sku", "item_sku", "id", "product_id"]);
          const name = getFirstValue_(row, ["name", "product_name", "item_name", "description"]);
          const category = getFirstValue_(row, ["category", "category_name", "department", "dept"]);
          return sku && name && category && isRowActive_(row);
        })
        .map(row => ({
          item_no: String(getFirstValue_(row, ["item_no", "item_number", "item"]) || "").trim(),
          sku: String(getFirstValue_(row, ["sku", "product_sku", "item_sku", "id", "product_id"]) || "").trim(),
          name: String(getFirstValue_(row, ["name", "product_name", "item_name", "description"]) || "").trim(),
          category: String(getFirstValue_(row, ["category", "category_name", "department", "dept"]) || "").trim(),
          unit: String(getFirstValue_(row, ["unit", "uom"]) || "").trim(),
          pack_size: String(getFirstValue_(row, ["pack_size", "pack", "case_size", "case_pack"]) || "").trim(),
          sort: Number(getFirstValue_(row, ["sort", "order", "display_order"]) || 9999),
        }))
        .sort((a, b) => a.sort - b.sort);

      return jsonResponse(buildSuccess_({ action, request_id: requestId, products: rows }, requestId));
    }

    if (action === "order_history" || action === "listorders") {
      const getTime = (value) => {
        if (value instanceof Date) return value.getTime();
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
      };

      const orderRows = getSheetRows_(CONFIG.sheets.orders)
        .filter(row => row.order_id && row.store)
        .sort((a, b) => {
          const storeCompare = String(a.store || "").localeCompare(String(b.store || ""));
          if (storeCompare !== 0) return storeCompare;
          const bTime = getTime(getFirstValue_(b, ["created_at", "timestamp", "created", "submitted_at", "submitted", "order_date", "date"]));
          const aTime = getTime(getFirstValue_(a, ["created_at", "timestamp", "created", "submitted_at", "submitted", "order_date", "date"]));
          return bTime - aTime;
        });

      let itemRows = [];
      try {
        itemRows = getSheetRows_(CONFIG.sheets.orderItems);
      } catch (err) {
        itemRows = [];
      }

      const itemsByOrder = new Map();
      itemRows
        .filter(row => row.order_id && (row.sku || row.name))
        .forEach(row => {
          const orderId = String(row.order_id || "").trim();
          if (!orderId) return;
          const item = {
            order_id: orderId,
            item_no: String(row.item_no || "").trim(),
            sku: String(row.sku || "").trim(),
            name: String(row.name || row.sku || "").trim(),
            category: String(row.category || "").trim(),
            unit: String(row.unit || "").trim(),
            pack_size: String(row.pack_size || "").trim(),
            qty: row.qty || "",
          };
          if (!itemsByOrder.has(orderId)) itemsByOrder.set(orderId, []);
          itemsByOrder.get(orderId).push(item);
        });

      const orderItemsByOrder = new Map();
      const items = [];
      orderRows.forEach((row) => {
        const orderId = String(row.order_id || "").trim();
        if (!orderId) return;
        const rowItems = extractOrderItems_(row);
        const existingItems = itemsByOrder.get(orderId) || [];
        const mergedItems = existingItems.length
          ? mergeOrderItemsWithRow_(existingItems, rowItems)
          : rowItems.map(item => ({ ...item, order_id: orderId }));
        mergedItems.forEach(item => {
          if (!item.order_id) item.order_id = orderId;
        });
        orderItemsByOrder.set(orderId, mergedItems);
        items.push(...mergedItems);
      });

      const orders = orderRows.map(row => {
        const orderId = String(row.order_id || "").trim();
        const createdAt = String(getFirstValue_(row, [
          "created_at",
          "timestamp",
          "created",
          "submitted_at",
          "submitted",
          "order_date",
          "date",
        ]) || "").trim();
        const requestedDate = String(getFirstValue_(row, [
          "requested_date",
          "request_date",
          "requested",
          "delivery_date",
          "needed_by",
        ]) || "").trim();

        const orderItems = orderItemsByOrder.get(orderId) || [];
        const itemCount = row.item_count || orderItems.length || "";
        const totalQty = row.total_qty || orderItems.reduce((sum, item) => {
          const qty = Number(item.qty || 0);
          return sum + (Number.isFinite(qty) ? qty : 0);
        }, 0) || "";

        return {
          order_id: orderId,
          created_at: createdAt,
          store: String(row.store || "").trim(),
          placed_by: String(row.placed_by || "").trim(),
          email: String(row.email || "").trim(),
          requested_date: requestedDate,
          notes: String(row.notes || "").trim(),
          item_count: itemCount,
          total_qty: totalQty,
          status: String(row.status || "").trim(),
        };
      });

      items.sort((a, b) => {
        const orderCompare = String(a.order_id || "").localeCompare(String(b.order_id || ""));
        if (orderCompare !== 0) return orderCompare;
        return String(a.name || a.sku || "").localeCompare(String(b.name || b.sku || ""));
      });

      return jsonResponse(buildSuccess_({ action: "listOrders", request_id: requestId, orders, items }, requestId));
    }

    if (action === "health") {
      const categories = getSheetRows_(CONFIG.sheets.categories);
      const products = getSheetRows_(CONFIG.sheets.products);
      return jsonResponse(buildSuccess_({
        action,
        request_id: requestId,
        sheet_id: CONFIG.spreadsheetId || SpreadsheetApp.getActiveSpreadsheet().getId(),
        counts: { categories: categories.length, products: products.length },
      }, requestId));
    }

    return jsonResponse(buildError_(
      `Unknown action: ${action}`,
      "UNKNOWN_ACTION",
      { received: action, expected: ["categories", "products", "listOrders", "health"] },
      requestId
    ));
  } catch (err) {
    Logger.log("doGet error %s: %s", requestId, err);
    return jsonResponse(buildError_(String(err), "UNHANDLED_ERROR", null, requestId));
  }
}

function doPost(e) {
  const requestId = Utilities.getUuid();
  try {
    const payload = parseJson_(e);
    const action = getAction_(e).toLowerCase() || "submitorder";
    Logger.log("doPost request %s action=%s cid=%s", requestId, action, getCorrelationId_(e, payload));
    Logger.log("doPost parseJson ok requestId=%s", requestId);

    if (action === "updateorderstatus") {
      const tokenError = validateToken_(payload);
      if (tokenError) {
        Logger.log("doPost validateToken failed requestId=%s", requestId);
        logOrderError_(requestId, "validateToken", tokenError.message, payload);
        return jsonResponse(buildError_(
          tokenError.message,
          tokenError.code,
          tokenError.details,
          requestId
        ));
      }

      return jsonResponse(updateOrderStatus_(payload, requestId));
    }

    if (action === "updateorderitemstatus") {
      const tokenError = validateToken_(payload);
      if (tokenError) {
        Logger.log("doPost validateToken failed requestId=%s", requestId);
        logOrderError_(requestId, "validateToken", tokenError.message, payload);
        return jsonResponse(buildError_(
          tokenError.message,
          tokenError.code,
          tokenError.details,
          requestId
        ));
      }

      return jsonResponse(updateOrderItemStatus_(payload, requestId));
    }

    if (action !== "submitorder") {
      return jsonResponse(buildError_(
        `Unknown action: ${action}`,
        "UNKNOWN_ACTION",
        { expected: ["submitOrder", "updateOrderStatus", "updateOrderItemStatus"] },
        requestId
      ));
    }

    const tokenError = validateToken_(payload);
    if (tokenError) {
      Logger.log("doPost validateToken failed requestId=%s", requestId);
      logOrderError_(requestId, "validateToken", tokenError.message, payload);
      return jsonResponse(buildError_(
        tokenError.message,
        tokenError.code,
        tokenError.details,
        requestId
      ));
    }

    const validationError = validateOrder_(payload);
    if (validationError) {
      Logger.log("doPost validateOrder failed requestId=%s", requestId);
      logOrderError_(requestId, "validateOrder", validationError.message, payload);
      return jsonResponse(buildError_(
        validationError.message,
        validationError.code,
        validationError.details,
        requestId
      ));
    }

    const orderId = Utilities.getUuid();
    const maxProducts = 100;
    const orderHeaders = buildOrderHeaders_(maxProducts);

    const normalized = normalizeItems_(payload.items);
    if (normalized.rejected.length) {
      Logger.log("doPost normalizeItems rejected requestId=%s", requestId);
      logOrderError_(requestId, "normalizeItems", "Invalid items.", payload, normalized.rejected);
      return jsonResponse(buildError_(
        "Order has invalid items.",
        "INVALID_ITEMS",
        { rejected_items: normalized.rejected },
        requestId
      ));
    }

    const ordersSheet = ensureSheet_(CONFIG.sheets.orders, orderHeaders);
    const headerError = validateOrdersHeader_(ordersSheet, orderHeaders);
    if (headerError) {
      Logger.log("doPost validateHeaders failed requestId=%s", requestId);
      logOrderError_(requestId, "validateHeaders", headerError.message, payload, headerError.details);
      return jsonResponse(buildError_(
        headerError.message,
        headerError.code,
        headerError.details,
        requestId
      ));
    }

    const itemCells = buildProductCells_(normalized.items, maxProducts);
    const itemsSummary = buildItemsSummary_(normalized.items);

    const row = [
      orderId,
      payload.timestamp,
      payload.store,
      payload.placed_by,
      payload.phone || "",
      payload.email || "",
      payload.notes || "",
      JSON.stringify(normalized.items),
      itemsSummary,
      payload.status || "",
      ...itemCells,
    ];

    if (row.length !== orderHeaders.length) {
      const errorMessage = `Order row length mismatch. Expected ${orderHeaders.length}, got ${row.length}.`;
      Logger.log("doPost row length mismatch requestId=%s", requestId);
      logOrderError_(requestId, "appendRow", errorMessage, payload, { expected: orderHeaders.length, actual: row.length });
      return jsonResponse(buildError_(errorMessage, "ROW_LENGTH_MISMATCH", null, requestId));
    }

    Logger.log("doPost appendRow requestId=%s", requestId);
    ordersSheet.appendRow(row);

    Logger.log("doPost sendEmail requestId=%s", requestId);
    const emailError = sendOfficeEmail_(payload, orderId, itemsSummary);

    const response = { order_id: orderId, request_id: requestId };
    if (emailError) {
      response.warnings = [{ code: "EMAIL_FAILED", message: emailError }];
    }
    return jsonResponse(buildSuccess_(response, requestId));
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    Logger.log("doPost error %s: %s", requestId, message);
    logOrderError_(requestId, "unhandled", message, null, err);
    return jsonResponse(buildError_(message, "UNHANDLED_ERROR", null, requestId));
  }
}

function updateOrderStatus_(payload, requestId) {
  const orderId = String(payload.order_id || payload.orderId || "").trim();
  const status = String(payload.status || "").trim();
  if (!orderId) {
    return buildError_("Missing order_id.", "MISSING_ORDER_ID", null, requestId);
  }
  if (!status) {
    return buildError_("Missing status.", "MISSING_STATUS", null, requestId);
  }

  const allowed = ["Not Started", "In Progress", "Complete"];
  if (!allowed.includes(status)) {
    return buildError_("Invalid status.", "INVALID_STATUS", { allowed }, requestId);
  }

  const sheet = getSpreadsheet_().getSheetByName(CONFIG.sheets.orders);
  if (!sheet) {
    return buildError_(`Missing sheet: ${CONFIG.sheets.orders}`, "MISSING_SHEET", null, requestId);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return buildError_("Orders sheet is empty.", "NO_ORDERS", null, requestId);
  }

  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(normalizeHeader_);
  const orderIdColumn = headers.indexOf("order_id") + 1;
  const statusColumn = headers.indexOf("status") + 1;

  if (!orderIdColumn || !statusColumn) {
    return buildError_("Orders sheet missing required columns.", "MISSING_COLUMNS", {
      required: ["order_id", "status"],
    }, requestId);
  }

  const orderIds = sheet.getRange(2, orderIdColumn, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (var i = 0; i < orderIds.length; i += 1) {
    if (String(orderIds[i][0] || "").trim() === orderId) {
      targetRow = i + 2;
      break;
    }
  }

  if (targetRow < 0) {
    return buildError_("Order not found.", "ORDER_NOT_FOUND", { order_id: orderId }, requestId);
  }

  sheet.getRange(targetRow, statusColumn).setValue(status);
  return buildSuccess_({ order_id: orderId, status }, requestId);
}

function updateOrderItemStatus_(payload, requestId) {
  const orderId = String(payload.order_id || payload.orderId || "").trim();
  const productIndex = Number(payload.product_index || payload.productIndex || 0);
  const productName = String(payload.product_name || payload.productName || "").trim();
  const status = String(payload.status || "").trim();
  if (!orderId) {
    return buildError_("Missing order_id.", "MISSING_ORDER_ID", null, requestId);
  }
  if (!status) {
    return buildError_("Missing status.", "MISSING_STATUS", null, requestId);
  }

  const allowed = ["Unavailable", "Pulled", "Not Pulled"];
  const partialMatch = status.match(/^Partially Collected\s+\d+\s+of\s+\d+$/i);
  if (!allowed.includes(status) && !partialMatch) {
    return buildError_("Invalid status.", "INVALID_STATUS", { allowed: ["Unavailable", "Pulled", "Not Pulled", "Partially Collected X of Y"] }, requestId);
  }

  const sheet = getSpreadsheet_().getSheetByName(CONFIG.sheets.orders);
  if (!sheet) {
    return buildError_(`Missing sheet: ${CONFIG.sheets.orders}`, "MISSING_SHEET", null, requestId);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return buildError_("Orders sheet is empty.", "NO_ORDERS", null, requestId);
  }

  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(normalizeHeader_);
  const orderIdColumn = headers.indexOf("order_id") + 1;
  if (!orderIdColumn) {
    return buildError_("Orders sheet missing required columns.", "MISSING_COLUMNS", {
      required: ["order_id"],
    }, requestId);
  }

  const orderIds = sheet.getRange(2, orderIdColumn, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (var i = 0; i < orderIds.length; i += 1) {
    if (String(orderIds[i][0] || "").trim() === orderId) {
      targetRow = i + 2;
      break;
    }
  }

  if (targetRow < 0) {
    return buildError_("Order not found.", "ORDER_NOT_FOUND", { order_id: orderId }, requestId);
  }

  let statusColumn = 0;
  if (Number.isFinite(productIndex) && productIndex > 0) {
    statusColumn = headers.indexOf(`product_${productIndex}_status`) + 1;
  }

  if (!statusColumn && productName) {
    for (var col = 0; col < headers.length; col += 1) {
      const header = headers[col];
      const match = header.match(/^product_(\d+)$/);
      if (!match) continue;
      const cellValue = String(sheet.getRange(targetRow, col + 1).getValue() || "").trim();
      if (cellValue && cellValue.toLowerCase() === productName.toLowerCase()) {
        const idx = Number(match[1]);
        const candidate = headers.indexOf(`product_${idx}_status`) + 1;
        if (candidate) {
          statusColumn = candidate;
          break;
        }
      }
    }
  }

  if (!statusColumn) {
    return buildError_("Orders sheet missing product status column.", "MISSING_COLUMNS", {
      required: ["product_#_status"],
    }, requestId);
  }

  sheet.getRange(targetRow, statusColumn).setValue(status);
  return buildSuccess_({ order_id: orderId, status }, requestId);
}

function doOptions() {
  const output = ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.JSON);

  return withCors_(output);
}

function jsonResponse(payload) {
  const base = Object.assign({}, payload, {
    version: CONFIG.apiVersion,
    timestamp: new Date().toISOString(),
  });
  const output = ContentService
    .createTextOutput(JSON.stringify(base))
    .setMimeType(ContentService.MimeType.JSON);

  return withCors_(output);
}

function withCors_(output) {
  const cors = CONFIG.cors || {};
  setHeaderSafe_(output, "Access-Control-Allow-Origin", cors.allowOrigin || "*");
  setHeaderSafe_(output, "Access-Control-Allow-Methods", cors.allowMethods || "GET,POST,OPTIONS");
  setHeaderSafe_(output, "Access-Control-Allow-Headers", cors.allowHeaders || "Content-Type, Cache-Control, Pragma");
  setHeaderSafe_(output, "Access-Control-Max-Age", cors.maxAgeSeconds || "3600");
  setHeaderSafe_(output, "Vary", "Origin");
  setHeaderSafe_(output, "Cache-Control", "no-store, max-age=0");
  setHeaderSafe_(output, "Pragma", "no-cache");
  return output;
}

function setHeaderSafe_(output, name, value) {
  if (!output || typeof output.setHeader !== "function") return;
  output.setHeader(name, value);
}

function buildError_(message, code, details, requestId) {
  const payload = {
    ok: false,
    error: message,
    error_code: code || "UNKNOWN_ERROR",
    updated_at: new Date().toISOString(),
  };

  if (requestId) payload.request_id = requestId;
  if (details) payload.details = details;

  return payload;
}

function buildSuccess_(data, requestId) {
  const payload = Object.assign({}, data, {
    ok: true,
    updated_at: new Date().toISOString(),
  });
  if (requestId) payload.request_id = requestId;
  return payload;
}

function getAction_(e) {
  if (e && e.parameter && e.parameter.action) return String(e.parameter.action).trim();
  return "";
}

function getCorrelationId_(e, payload) {
  const paramId = e && e.parameter && e.parameter.cid ? String(e.parameter.cid).trim() : "";
  if (paramId) return paramId;
  const bodyId = payload && payload.correlation_id ? String(payload.correlation_id).trim() : "";
  return bodyId;
}

function normalizeHeader_(header) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^\w]/g, "");
}

function getFirstValue_(row, keys) {
  if (!row || typeof row !== "object") return null;
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    var value = row[key];
    if (value === "" || value === null || typeof value === "undefined") continue;
    return value;
  }
  return null;
}

function getSheetRows_(sheetName) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(`Missing sheet: ${sheetName}`);
  }

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(normalizeHeader_);
  return values.slice(1)
    .filter(row => row.some(cell => String(cell || "").trim() !== ""))
    .map(row => headers.reduce((acc, header, idx) => {
      if (header) acc[header] = row[idx];
      return acc;
    }, {}));
}

function getSpreadsheet_() {
  if (CONFIG.spreadsheetId) {
    return SpreadsheetApp.openById(CONFIG.spreadsheetId);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function isRowActive_(row) {
  const raw = getFirstValue_(row, [
    "active",
    "enabled",
    "is_active",
    "is_enabled",
    "status",
  ]);
  if (raw === null) return true;
  if (raw === true) return true;
  if (raw === false || raw === 0) return false;
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return false;
  if (["false", "no", "n", "0", "inactive", "disabled"].includes(normalized)) return false;
  return ["true", "yes", "y", "1", "active", "enabled"].includes(normalized);
}

function getOrderNotificationEmails_() {
  let rows = [];
  try {
    rows = getSheetRows_(CONFIG.sheets.contacts);
  } catch (err) {
    Logger.log("Contacts sheet unavailable: %s", err);
    rows = [];
  }

  const emails = [];
  rows
    .filter(row => isRowActive_(row))
    .forEach((row) => {
      const email = String(getFirstValue_(row, [
        "email",
        "notification_email",
        "order_email",
        "contact_email",
      ]) || "").trim();
      if (email) emails.push(email);
    });

  if (!emails.length && CONFIG.officeEmail) {
    emails.push(CONFIG.officeEmail);
  }

  const deduped = [];
  const seen = new Set();
  emails.forEach((email) => {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    deduped.push(email);
  });

  return deduped;
}

function extractOrderItems_(row) {
  const items = [];
  const productKeys = Object.keys(row || {})
    .filter(key => key.startsWith("product_"))
    .map(key => {
      const match = key.match(/^product_(\d+)$/);
      return match ? Number(match[1]) : null;
    })
    .filter(num => Number.isFinite(num))
    .sort((a, b) => a - b);

  productKeys.forEach((num) => {
    const name = String(row[`product_${num}`] || "").trim();
    const qty = row[`qty_${num}`];
    const status = String(row[`product_${num}_status`] || "").trim();
    if (!name && (qty === "" || qty === null || typeof qty === "undefined")) {
      return;
    }
    items.push({ name, qty, status, product_index: num });
  });

  return items;
}

function parseItemsJson_(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  return [];
}

function collectOrderItemsFromRow_(row) {
  const fromJson = parseItemsJson_(row.items_json || row.items || "");
  if (fromJson.length) {
    return fromJson.map(item => ({
      item_no: String(item.item_no || item.item || "").trim(),
      sku: String(item.sku || "").trim(),
      name: String(item.name || item.description || item.sku || "Item").trim(),
      category: String(item.category || "").trim(),
      unit: String(item.unit || "").trim(),
      pack_size: String(item.pack_size || item.pack || "").trim(),
      qty: item.qty || "",
    }));
  }
  return extractOrderItems_(row).map(item => ({
    name: String(item.name || "Item").trim(),
    qty: item.qty || "",
    status: String(item.status || "").trim(),
    product_index: item.product_index || "",
  }));
}

function normalizeItemKey_(value) {
  return String(value || "").trim().toLowerCase();
}

function mergeOrderItemsWithRow_(items, rowItems) {
  const pool = new Map();
  (rowItems || []).forEach((item) => {
    const key = normalizeItemKey_(item.name || item.sku);
    if (!key) return;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(item);
  });

  const merged = (items || []).map((item) => {
    const key = normalizeItemKey_(item.name || item.sku);
    const candidates = pool.get(key);
    const rowItem = candidates && candidates.length ? candidates.shift() : null;
    return {
      ...item,
      qty: item.qty || rowItem?.qty || "",
      status: rowItem?.status || item.status || "",
      product_index: rowItem?.product_index || item.product_index || "",
    };
  });

  pool.forEach((list) => {
    list.forEach((item) => merged.push(item));
  });

  return merged;
}

function parseJson_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("Missing JSON body.");
  }

  const contentType = String(e.postData.type || "").toLowerCase();
  if (contentType && !(contentType.includes("application/json") || contentType.includes("text/plain"))) {
    throw new Error(`Unsupported content type: ${e.postData.type}`);
  }

  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error("Invalid JSON body.");
  }
}

function validateToken_(payload) {
  const auth = CONFIG.auth || {};
  const expected = String(auth.sharedToken || "").trim();
  if (!expected || !auth.requireToken) {
    // Token auth intentionally disabled for "anyone with link" mode.
    return null;
  }
  const provided = payload && payload.token ? String(payload.token) : "";
  if (provided !== expected) {
    return { message: "Invalid token.", code: "INVALID_TOKEN" };
  }
  return null;
}

function validateOrder_(payload) {
  if (!payload) {
    return { message: "Missing order payload.", code: "MISSING_PAYLOAD" };
  }
  if (!payload.store) {
    return { message: "Store is required.", code: "MISSING_STORE" };
  }
  if (!payload.timestamp) {
    return { message: "Timestamp is required.", code: "MISSING_TIMESTAMP" };
  }
  if (!payload.placed_by) {
    return { message: "Placed by is required.", code: "MISSING_PLACED_BY" };
  }
  return null;
}

function normalizeItems_(items) {
  const normalizedItems = [];
  const rejectedItems = [];

  (items || []).forEach((item, index) => {
    const normalized = {
      name: String(item.name || "").trim(),
      qty: Number(item.qty || 0),
    };
    const reasons = [];
    if (!normalized.name) reasons.push("Missing name.");
    if (!Number.isFinite(normalized.qty) || normalized.qty <= 0) {
      reasons.push("Quantity must be greater than zero.");
    }

    if (reasons.length) {
      rejectedItems.push({
        index,
        reasons,
        item: normalized,
      });
    } else {
      normalizedItems.push(normalized);
    }
  });

  return { items: normalizedItems, rejected: rejectedItems };
}

function buildOrderHeaders_(maxProducts) {
  const headers = [
    "order_id",
    "timestamp",
    "store",
    "placed_by",
    "phone",
    "email",
    "notes",
    "items_json",
    "items_summary",
    "status",
  ];

  for (let i = 1; i <= maxProducts; i += 1) {
    headers.push(`Product ${i}`, `Qty ${i}`, `Product ${i} Status`);
  }

  return headers;
}

function validateOrdersHeader_(sheet, expectedHeaders) {
  if (!sheet || !expectedHeaders || !expectedHeaders.length) return null;
  const lastColumn = Math.max(sheet.getLastColumn(), expectedHeaders.length);
  const actual = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(cell => String(cell || "").trim());
  const expected = expectedHeaders.map(header => String(header || "").trim());
  const mismatches = [];

  expected.forEach((header, index) => {
    const actualValue = actual[index] || "";
    if (actualValue !== header) {
      mismatches.push({ index: index + 1, expected: header, actual: actualValue });
    }
  });

  const extra = actual.slice(expected.length).filter(value => String(value || "").trim() !== "");
  if (extra.length) {
    mismatches.push({ index: expected.length + 1, expected: "(no extra columns)", actual: extra.join(", ") });
  }

  if (!mismatches.length) return null;
  return {
    message: "Orders sheet header mismatch. Fix row 1 headers before submitting orders.",
    code: "HEADER_MISMATCH",
    details: { mismatches },
  };
}

function buildProductCells_(items, maxProducts) {
  const cells = new Array(maxProducts * 3).fill("");
  items.slice(0, maxProducts).forEach((item, index) => {
    const offset = index * 3;
    cells[offset] = item.name;
    cells[offset + 1] = item.qty;
    cells[offset + 2] = "";
  });
  return cells;
}

function buildItemsSummary_(items) {
  return items
    .map(item => `${item.name} x${item.qty}`)
    .join(", ");
}

function sendOfficeEmail_(payload, orderId, itemsSummary) {
  const recipients = getOrderNotificationEmails_();
  if (!recipients.length) return "No notification emails configured.";
  try {
    const subject = `New Retail Order ${orderId}`;
    const bodyLines = [
      `Order ID: ${orderId}`,
      `Store: ${payload.store || ""}`,
      `Placed by: ${payload.placed_by || ""}`,
      `Requested date: ${payload.requested_date || ""}`,
      `Email: ${payload.email || ""}`,
      `Notes: ${payload.notes || ""}`,
      `Items: ${itemsSummary || ""}`,
      "",
      "Raw Items JSON:",
      JSON.stringify(payload.items || [], null, 2),
    ];
    MailApp.sendEmail(recipients.join(","), subject, bodyLines.join("\n"));
    return "";
  } catch (err) {
    Logger.log("sendOfficeEmail error: %s", err);
    return err && err.message ? err.message : String(err);
  }
}

function logOrderError_(requestId, stage, message, payload, err) {
  try {
    const sheet = ensureSheet_(CONFIG.sheets.orderErrors, [
      "timestamp",
      "request_id",
      "stage",
      "message",
      "stack",
      "payload_json",
    ]);
    const stack = err && err.stack ? err.stack : "";
    const payloadJson = payload ? JSON.stringify(payload) : "";
    sheet.appendRow([new Date().toISOString(), requestId || "", stage || "", message || "", stack, payloadJson]);
  } catch (error) {
    Logger.log("logOrderError failed: %s", error);
  }
}

function ensureSheet_(name, headers) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  if (sheet.getLastRow() === 0 && headers && headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return sheet;
}
