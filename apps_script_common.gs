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
    if (!name && (qty === "" || qty === null || typeof qty === "undefined")) {
      return;
    }
    items.push({ name, qty });
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
  }));
}
