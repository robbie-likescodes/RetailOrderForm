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
 *  - Orders: date | store | placed_by | Product 1 | Qty 1 | Product 2 | Qty 2 | ...
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
      const rawOrders = getSheetRows_(CONFIG.SHEETS.ORDERS)
        .filter(row => row.store);
      const orders = rawOrders.map((row, index) => {
        const items = extractOrderItems_(row);
        const totals = items.reduce(
          (acc, item) => {
            acc.itemCount += 1;
            acc.totalQty += Number(item.qty || 0);
            return acc;
          },
          { itemCount: 0, totalQty: 0 }
        );

        return {
          order_id: `row_${index + 2}`,
          created_at: String(row.date || "").trim(),
          store: String(row.store || "").trim(),
          placed_by: String(row.placed_by || "").trim(),
          email: String(row.email || "").trim(),
          notes: String(row.notes || "").trim(),
          item_count: totals.itemCount,
          total_qty: totals.totalQty,
        };
      });

      const items = rawOrders.flatMap((row, index) => (
        extractOrderItems_(row).map(item => ({
          order_id: `row_${index + 2}`,
          name: item.name,
          qty: item.qty,
        }))
      ));

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
        "date",
        "store",
        "placed_by",
      ]);

      const itemCells = items.flatMap(item => ([item.name, item.qty]));

      ordersSheet.appendRow([
        createdAt,
        payload.store,
        payload.placed_by,
        ...itemCells,
      ]);
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
      `Email: ${payload.email || ""}\n` +
      `Notes: ${payload.notes || ""}\n` +
      `Items (${totals.itemCount} / qty ${totals.totalQty}):\n${itemsSummary}`,
  });
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
