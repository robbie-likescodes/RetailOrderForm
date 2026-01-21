const CONFIG = {
  // Optional: set to a specific Google Sheet ID if running as a standalone script.
  // Leave blank to use the container-bound spreadsheet.
  spreadsheetId: "",
  sheets: {
    categories: "Categories",
    products: "Products",
    orders: "Orders",
    orderItems: "OrderItems",
  },
};

function jsonResponse(payload) {
  const output = ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);

  return withCors_(output);
}

function doOptions() {
  const output = ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.JSON);

  return withCors_(output);
}

function withCors_(output) {
  output.setHeader("Access-Control-Allow-Origin", "*");
  output.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  output.setHeader("Access-Control-Allow-Headers", "Content-Type, Cache-Control, Pragma");
  output.setHeader("Access-Control-Max-Age", "3600");
  return output;
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
