/***************
 * ORDER SUBMISSION (doPost)
 *
 * Paste this into your Google Apps Script project alongside your existing
 * doGet() handler. It expects the JSON payload from app.js.
 ***************/
const SHEET_ORDERS = "Orders";
const SHEET_ORDER_ITEMS = "OrderItems";

function doPost(e) {
  try {
    const payload = parseJson_(e);
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

    const ordersSheet = ensureSheet_(SHEET_ORDERS, [
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

    const itemsSheet = ensureSheet_(SHEET_ORDER_ITEMS, [
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

function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  if (sheet.getLastRow() === 0 && headers && headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return sheet;
}
