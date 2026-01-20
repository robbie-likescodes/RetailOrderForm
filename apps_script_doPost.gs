/***************
 * ORDER SUBMISSION (doPost)
 *
 * Paste this into your Google Apps Script project alongside your existing
 * doGet() handler. It expects the JSON payload from app.js.
 ***************/
function doPost(e) {
  const requestId = Utilities.getUuid();
  try {
    const payload = parseJson_(e);
    const validationError = validateOrder_(payload);
    if (validationError) {
      return jsonResponse(buildError_(
        validationError.message,
        validationError.code,
        validationError.details,
        requestId
      ));
    }

    const orderId = Utilities.getUuid();
    const createdAt = new Date().toISOString();

    const normalized = normalizeItems_(payload.items);
    if (normalized.rejected.length) {
      return jsonResponse(buildError_(
        "Order has invalid items.",
        "INVALID_ITEMS",
        { rejected_items: normalized.rejected },
        requestId
      ));
    }

    if (normalized.items.length === 0) {
      return jsonResponse(buildError_(
        "Order has no items with quantities.",
        "NO_VALID_ITEMS",
        null,
        requestId
      ));
    }

    const totals = normalized.items.reduce(
      (acc, item) => {
        acc.itemCount += 1;
        acc.totalQty += item.qty;
        return acc;
      },
      { itemCount: 0, totalQty: 0 }
    );

    const ordersSheet = ensureSheet_(CONFIG.sheets.orders, [
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

    const itemsSheet = ensureSheet_(CONFIG.sheets.orderItems, [
      "order_id",
      "item_no",
      "sku",
      "name",
      "category",
      "unit",
      "pack_size",
      "qty",
    ]);

    const itemRows = normalized.items.map(item => ([
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
      request_id: requestId,
      updated_at: createdAt,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    let errorCode = "UNHANDLED_ERROR";
    if (message === "Missing JSON body.") errorCode = "MISSING_JSON_BODY";
    if (message === "Invalid JSON body.") errorCode = "INVALID_JSON_BODY";
    if (message.indexOf("Unsupported content type:") === 0) {
      errorCode = "UNSUPPORTED_CONTENT_TYPE";
    }
    return jsonResponse(buildError_(message, errorCode, null, requestId));
  }
}

function parseJson_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("Missing JSON body.");
  }

  const contentType = String(e.postData.type || "").toLowerCase();
  if (contentType && !contentType.includes("application/json")) {
    throw new Error(`Unsupported content type: ${e.postData.type}`);
  }

  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error("Invalid JSON body.");
  }
}

function validateOrder_(payload) {
  if (!payload) {
    return { message: "Missing order payload.", code: "MISSING_PAYLOAD" };
  }
  if (!payload.store) {
    return { message: "Store is required.", code: "MISSING_STORE" };
  }
  if (!payload.placed_by) {
    return { message: "Placed by is required.", code: "MISSING_PLACED_BY" };
  }
  if (!payload.requested_date) {
    return { message: "Requested date is required.", code: "MISSING_REQUESTED_DATE" };
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return { message: "Order must include at least one item.", code: "MISSING_ITEMS" };
  }
  return null;
}

function normalizeItems_(items) {
  const normalizedItems = [];
  const rejectedItems = [];

  (items || []).forEach((item, index) => {
    const normalized = {
      item_no: String(item.item_no || "").trim(),
      sku: String(item.sku || "").trim(),
      name: String(item.name || "").trim(),
      category: String(item.category || "").trim(),
      unit: String(item.unit || "").trim(),
      pack_size: String(item.pack_size || "").trim(),
      qty: Number(item.qty || 0),
    };
    const reasons = [];
    if (!normalized.sku) reasons.push("Missing sku.");
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

function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  if (sheet.getLastRow() === 0 && headers && headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return sheet;
}
