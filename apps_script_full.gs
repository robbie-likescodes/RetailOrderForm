/**
 * Retail Order Portal - Google Apps Script Web App
 * -------------------------------------------------
 * Endpoints:
 *  GET  /exec?action=categories
 *  GET  /exec?action=products
 *  POST /exec  (JSON body)
 *
 * Sheets expected:
 *  - Categories: category | sort | active | display_name
 *  - Products: item_no | sku | name | category | unit | pack_size | active | sort
 *  - Orders: order_id | created_at | store | placed_by | phone | email | requested_date |
 *            delivery_method (optional) | notes | item_count | total_qty | token | user_agent
 *  - OrderItems: order_id | item_no | sku | name | category | unit | pack_size | qty
 */

const CONFIG = {
  SHARED_TOKEN: "REPLACE_WITH_SECRET",
  OFFICE_EMAIL: "office@example.com",
  CACHE_TTL_SECONDS: 60 * 5,
  SHEETS: {
    CATEGORIES: "Categories",
    PRODUCTS: "Products",
    ORDERS: "Orders",
    ORDER_ITEMS: "OrderItems",
  },
};

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "")
      .trim()
      .toLowerCase();

    if (!action) {
      return jsonResponse({
        ok: false,
        error: "Missing action.",
        updated_at: new Date().toISOString(),
      });
    }

    if (action === "categories") {
      const cacheKey = "categories";
      const cached = getCache_(cacheKey);
      if (cached) return jsonResponse(cached);

      const categories = getSheetRows_(CONFIG.SHEETS.CATEGORIES)
        .filter(row => row.category && isRowActive_(row))
        .map(row => ({
          category: String(row.category || "").trim(),
          display_name: String(row.display_name || row.category || "").trim(),
          sort: Number(row.sort || 9999),
        }))
        .sort((a, b) => a.sort - b.sort);

      const payload = {
        ok: true,
        categories,
        updated_at: new Date().toISOString(),
      };
      setCache_(cacheKey, payload);
      return jsonResponse(payload);
    }

    if (action === "products") {
      const cacheKey = "products";
      const cached = getCache_(cacheKey);
      if (cached) return jsonResponse(cached);

      const products = getSheetRows_(CONFIG.SHEETS.PRODUCTS)
        .filter(row => row.sku && row.name && row.category && isRowActive_(row))
        .map(row => ({
          item_no: String(row.item_no || "").trim(),
          sku: String(row.sku || "").trim(),
          name: String(row.name || "").trim(),
          category: String(row.category || "").trim(),
          unit: String(row.unit || "").trim(),
          pack_size: String(row.pack_size || "").trim(),
          sort: Number(row.sort || 9999),
        }))
        .sort((a, b) => a.sort - b.sort);

      const payload = {
        ok: true,
        products,
        updated_at: new Date().toISOString(),
      };
      setCache_(cacheKey, payload);
      return jsonResponse(payload);
    }

    if (action === "order_history") {
      const getTime = (value) => {
        if (value instanceof Date) return value.getTime();
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
      };

      const orders = getSheetRows_(CONFIG.SHEETS.ORDERS)
        .filter(row => row.order_id && row.store)
        .map(row => ({
          order_id: String(row.order_id || "").trim(),
          created_at: String(row.created_at || "").trim(),
          store: String(row.store || "").trim(),
          placed_by: String(row.placed_by || "").trim(),
          email: String(row.email || "").trim(),
          requested_date: String(row.requested_date || "").trim(),
          notes: String(row.notes || "").trim(),
          item_count: row.item_count || "",
          total_qty: row.total_qty || "",
        }))
        .sort((a, b) => {
          const storeCompare = String(a.store || "").localeCompare(String(b.store || ""));
          if (storeCompare !== 0) return storeCompare;
          return getTime(b.created_at) - getTime(a.created_at);
        });

      const items = getSheetRows_(CONFIG.SHEETS.ORDER_ITEMS)
        .filter(row => row.order_id && row.sku)
        .map(row => ({
          order_id: String(row.order_id || "").trim(),
          item_no: String(row.item_no || "").trim(),
          sku: String(row.sku || "").trim(),
          name: String(row.name || "").trim(),
          category: String(row.category || "").trim(),
          unit: String(row.unit || "").trim(),
          pack_size: String(row.pack_size || "").trim(),
          qty: row.qty || "",
        }))
        .sort((a, b) => {
          const orderCompare = String(a.order_id || "").localeCompare(String(b.order_id || ""));
          if (orderCompare !== 0) return orderCompare;
          return String(a.name || a.sku || "").localeCompare(String(b.name || b.sku || ""));
        });

      return jsonResponse({
        ok: true,
        orders,
        items,
        updated_at: new Date().toISOString(),
      });
    }

    return jsonResponse({
      ok: false,
      error: `Unknown action: ${action}`,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: String(err),
      updated_at: new Date().toISOString(),
    });
  }
}

function doPost(e) {
  try {
    const payload = parseJson_(e);
    const authError = validateToken_(payload);
    if (authError) {
      return jsonResponse({
        ok: false,
        error: authError,
        updated_at: new Date().toISOString(),
      });
    }

    const validationError = validateOrder_(payload);
    if (validationError) {
      return jsonResponse({
        ok: false,
        error: validationError,
        updated_at: new Date().toISOString(),
      });
    }

    const orderId = Utilities.getUuid();
    const createdAt = new Date().toISOString();

    const items = payload.items
      .map(item => ({
        item_no: String(item.item_no || "").trim(),
        sku: String(item.sku || "").trim(),
        name: String(item.name || "").trim(),
        category: String(item.category || "").trim(),
        unit: String(item.unit || "").trim(),
        pack_size: String(item.pack_size || "").trim(),
        qty: Number(item.qty || 0),
      }))
      .filter(item => item.sku && item.name && item.qty > 0);

    if (items.length === 0) {
      return jsonResponse({
        ok: false,
        error: "Order has no items with quantities.",
        updated_at: createdAt,
      });
    }

    const totals = items.reduce(
      (acc, item) => {
        acc.itemCount += 1;
        acc.totalQty += item.qty;
        return acc;
      },
      { itemCount: 0, totalQty: 0 }
    );

    const lock = LockService.getDocumentLock();
    lock.waitLock(10000);

    try {
      const ordersSheet = ensureSheet_(CONFIG.SHEETS.ORDERS, [
        "order_id",
        "created_at",
        "store",
        "placed_by",
        "phone",
        "email",
        "requested_date",
        "delivery_method",
        "notes",
        "item_count",
        "total_qty",
        "token",
        "user_agent",
      ]);

      ordersSheet.appendRow([
        orderId,
        createdAt,
        payload.store,
        payload.placed_by,
        payload.phone || "",
        payload.email || "",
        payload.requested_date,
        payload.delivery_method || "",
        payload.notes || "",
        totals.itemCount,
        totals.totalQty,
        payload.token || "",
        (payload.client && payload.client.userAgent) || "",
      ]);

      const itemsSheet = ensureSheet_(CONFIG.SHEETS.ORDER_ITEMS, [
        "order_id",
        "item_no",
        "sku",
        "name",
        "category",
        "unit",
        "pack_size",
        "qty",
      ]);

      const itemRows = items.map(item => ([
        orderId,
        item.item_no,
        item.sku,
        item.name,
        item.category,
        item.unit,
        item.pack_size,
        item.qty,
      ]));

      if (itemRows.length) {
        itemsSheet
          .getRange(itemsSheet.getLastRow() + 1, 1, itemRows.length, itemRows[0].length)
          .setValues(itemRows);
      }
    } finally {
      lock.releaseLock();
    }

    maybeSendEmail_(orderId, payload, items, totals);

    return jsonResponse({
      ok: true,
      order_id: orderId,
      updated_at: createdAt,
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: String(err),
      updated_at: new Date().toISOString(),
    });
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseJson_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("Missing JSON body.");
  }

  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error("Invalid JSON body.");
  }
}

function validateToken_(payload) {
  if (!CONFIG.SHARED_TOKEN) return "";
  if (!payload || !payload.token) return "Missing token.";
  if (payload.token !== CONFIG.SHARED_TOKEN) return "Unauthorized.";
  return "";
}

function validateOrder_(payload) {
  if (!payload) return "Missing order payload.";
  if (!payload.store) return "Store is required.";
  if (!payload.placed_by) return "Placed by is required.";
  if (!payload.requested_date) return "Requested date is required.";
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return "Order must include at least one item.";
  }
  return "";
}

function normalizeHeader_(header) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^\w]/g, "");
}

function getSheetRows_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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

function isRowActive_(row) {
  if (!Object.prototype.hasOwnProperty.call(row, "active")) return true;
  const raw = row.active;
  if (raw === true) return true;
  if (raw === false || raw === 0) return false;
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return false;
  return ["true", "yes", "y", "1"].includes(normalized);
}

function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  if (sheet.getLastRow() === 0 && headers && headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return sheet;
}

function getCache_(key) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get(key);
  return raw ? JSON.parse(raw) : null;
}

function setCache_(key, value) {
  CacheService.getScriptCache().put(
    key,
    JSON.stringify(value),
    CONFIG.CACHE_TTL_SECONDS
  );
}

function maybeSendEmail_(orderId, payload, items, totals) {
  if (!CONFIG.OFFICE_EMAIL) return;

  const itemsSummary = items
    .map(item => `${item.qty}x ${item.name}`)
    .join("\n");

  MailApp.sendEmail({
    to: CONFIG.OFFICE_EMAIL,
    subject: `Retail Order ${orderId} — ${payload.store}`,
    body:
      `New retail order\n\n` +
      `Store: ${payload.store}\n` +
      `Placed by: ${payload.placed_by}\n` +
      `Requested date: ${payload.requested_date}\n` +
      `Delivery: ${payload.delivery_method}\n` +
      `Phone: ${payload.phone || ""}\n` +
      `Email: ${payload.email || ""}\n` +
      `Notes: ${payload.notes || ""}\n` +
      `Items (${totals.itemCount} / qty ${totals.totalQty}):\n${itemsSummary}`,
  });
}
