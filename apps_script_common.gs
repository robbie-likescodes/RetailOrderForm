const CONFIG = {
  // Optional: set to a specific Google Sheet ID if running as a standalone script.
  // Leave blank to use the container-bound spreadsheet.
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

function doOptions() {
  const output = ContentService.createTextOutput("")
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
  let readError = "";
  try {
    rows = getSheetRows_(CONFIG.sheets.contacts);
  } catch (err) {
    Logger.log("Contacts sheet unavailable: %s", err);
    readError = err && err.message ? err.message : String(err);
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

  const deduped = [];
  const seen = new Set();
  emails.forEach((email) => {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    deduped.push(email);
  });

  if (readError) {
    return { emails: [], error: "Contacts sheet unavailable. Check the Contacts tab and permissions." };
  }
  if (!deduped.length) {
    return { emails: [], error: "No notification emails found in Contacts sheet." };
  }
  return { emails: deduped, error: "" };
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

function normalizeMatchKey_(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*:\s*/g, ":")
    .toLowerCase();
}

function formatIifDate_(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MM/dd/yyyy");
  }
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "MM/dd/yyyy");
}

function escapeIifField_(value) {
  return String(value == null ? "" : value)
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

function normalizeQbItemName_(qbListValue, fallbackName) {
  const raw = String(qbListValue || "").trim();
  if (!raw) return String(fallbackName || "").trim();
  const parts = raw.split(":");
  if (parts.length < 2) return raw;
  const prefix = parts.shift().trim();
  const rest = parts.join(":").trim();
  if (!prefix || !rest) return raw;
  const restLower = rest.toLowerCase();
  const prefixLower = prefix.toLowerCase();
  if (restLower.startsWith(`${prefixLower} `)) {
    return `${prefix}: ${rest.slice(prefix.length).trim()}`;
  }
  return raw;
}

function isUuid_(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

function buildIifDocNum_(orderRow, fallbackId) {
  const candidates = [
    getFirstValue_(orderRow, [
      "order_number",
      "order_num",
      "ordernumber",
      "order_no",
      "orderno",
      "order_id",
      "orderid",
      "id",
    ]),
    fallbackId,
  ];
  for (var i = 0; i < candidates.length; i += 1) {
    var candidate = String(candidates[i] || "").trim();
    if (!candidate) continue;
    if (!isUuid_(candidate)) return candidate;
  }
  const createdAt = getFirstValue_(orderRow, [
    "created_at",
    "timestamp",
    "created",
    "submitted_at",
    "submitted",
    "order_date",
    "date",
  ]);
  const fallbackDate = createdAt instanceof Date ? createdAt : new Date(createdAt || Date.now());
  return `SO-${Utilities.formatDate(fallbackDate, Session.getScriptTimeZone(), "yyyyMMddHHmmss")}`;
}

/**
 * Builds a QuickBooks IIF Sales Order export for a single order.
 *
 * Example IIF block:
 * !TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tDOCNUM\tMEMO
 * !SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tQNTY\tITEM\tMEMO
 * !ENDTRNS
 * TRNS\tSALESORD\t01/15/2024\tSales Orders\tExample Store\tSO-1001\tImported from Retail Order Portal
 * SPL\tSALESORD\t01/15/2024\tSales Orders\tExample Store\t2\tSHOTT: Banana\tBanana
 * ENDTRNS
 *
 * Order headers used:
 * - order_id (Orders sheet)
 * - created_at / timestamp / submitted_at / order_date / date (Orders sheet)
 * - store (Orders sheet)
 * - Product N / Qty N (Orders sheet columns)
 *
 * Product mapping headers used:
 * - Item Name (Products sheet -> item_name)
 * - QB List (Products sheet -> qb_list)
 */
function buildOrderIifExport_(orderId) {
  const orders = getSheetRows_(CONFIG.sheets.orders);
  const products = getSheetRows_(CONFIG.sheets.products);
  const orderRow = orders.find(row => String(row.order_id || "").trim() === String(orderId || "").trim());
  if (!orderRow) {
    return { error: "Order not found.", details: { order_id: orderId } };
  }

  const items = extractOrderItems_(orderRow)
    .map(item => ({
      name: String(item.name || "").trim(),
      qty: Number(item.qty || 0),
    }))
    .filter(item => item.name && Number.isFinite(item.qty) && item.qty > 0);

  if (!items.length) {
    return { error: "No line items with quantity greater than zero were found for this order." };
  }

  const productMap = new Map();
  products.forEach((product) => {
    const primaryName = String(product.item_name || "").trim();
    const fallbackName = String(product.name || "").trim();
    const qbListValue = String(product.qb_list || "").trim();
    const candidates = [primaryName, fallbackName].filter(Boolean);
    candidates.forEach((name) => {
      const normalized = normalizeMatchKey_(name);
      if (!normalized) return;
      if (!productMap.has(normalized)) {
        productMap.set(normalized, product);
        return;
      }
      const existing = productMap.get(normalized);
      const existingQbList = String(existing?.qb_list || "").trim();
      if (!existingQbList && qbListValue) {
        productMap.set(normalized, product);
      }
    });
  });

  const missingItems = [];
  const mappedItems = items.map((item) => {
    const normalized = normalizeMatchKey_(item.name);
    const product = productMap.get(normalized);
    const qbList = String(product?.qb_list || "").trim();
    if (!qbList) missingItems.push(item.name);
    return {
      name: item.name,
      qty: item.qty,
      qb_list: qbList,
    };
  });

  const orderDate = formatIifDate_(getFirstValue_(orderRow, [
    "created_at",
    "timestamp",
    "created",
    "submitted_at",
    "submitted",
    "order_date",
    "date",
  ]));
  const customerName = String(orderRow.store || "Unknown Store").trim();
  const memo = "Imported from Retail Order Portal";
  const accountName = "Sales Orders";
  const docNum = buildIifDocNum_(orderRow, orderId);

  const lines = [
    "!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tDOCNUM\tMEMO",
    "!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tQNTY\tITEM\tMEMO",
    "!ENDTRNS",
  ];
  lines.push([
    "TRNS",
    "SALESORD",
    orderDate,
    accountName,
    customerName,
    docNum,
    memo,
  ].map(escapeIifField_).join("\t"));

  mappedItems.forEach((item) => {
    const itemName = normalizeQbItemName_(item.qb_list, item.name);
    lines.push([
      "SPL",
      "SALESORD",
      orderDate,
      accountName,
      customerName,
      String(item.qty || ""),
      itemName,
      item.name,
    ].map(escapeIifField_).join("\t"));
  });

  lines.push("ENDTRNS");

  return {
    iif_text: `${lines.join("\n")}\n`,
    missing_items: missingItems,
    items: mappedItems,
  };
}
