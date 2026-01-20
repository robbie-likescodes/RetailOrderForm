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
    const maxProducts = 100;

    const normalized = normalizeItems_(payload.items);
    if (normalized.rejected.length) {
      return jsonResponse(buildError_(
        "Order has invalid items.",
        "INVALID_ITEMS",
        { rejected_items: normalized.rejected },
        requestId
      ));
    }

    const itemsSummary = buildItemsSummary_(normalized.items);

    const ordersSheet = ensureSheet_(
      CONFIG.sheets.orders,
      buildOrderHeaders_(maxProducts)
    );

    const itemCells = buildProductCells_(normalized.items, maxProducts);

    ordersSheet.appendRow([
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
    ]);

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
    headers.push(`Product ${i}`, `Qty ${i}`);
  }

  return headers;
}

function buildProductCells_(items, maxProducts) {
  const cells = new Array(maxProducts * 2).fill("");
  items.slice(0, maxProducts).forEach((item, index) => {
    cells[index * 2] = item.name;
    cells[index * 2 + 1] = item.qty;
  });
  return cells;
}

function buildItemsSummary_(items) {
  return items
    .map(item => `${item.name} x${item.qty}`)
    .join(", ");
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
