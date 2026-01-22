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

    if (action !== "submitorder") {
      return jsonResponse(buildError_(
        `Unknown action: ${action}`,
        "UNKNOWN_ACTION",
        { expected: ["submitOrder", "updateOrderStatus"] },
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

    const itemsSummary = buildItemsSummary_(normalized.items);

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
    let errorCode = "UNHANDLED_ERROR";
    if (message === "Missing JSON body.") errorCode = "MISSING_JSON_BODY";
    if (message === "Invalid JSON body.") errorCode = "INVALID_JSON_BODY";
    if (message.indexOf("Unsupported content type:") === 0) {
      errorCode = "UNSUPPORTED_CONTENT_TYPE";
    }
    Logger.log("doPost error %s: %s", requestId, message);
    logOrderError_(requestId, "unhandled", message, null, err);
    return jsonResponse(buildError_(message, errorCode, null, requestId));
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

  const allowed = ["Not Started", "Incomplete", "Complete"];
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
    headers.push(`Product ${i}`, `Qty ${i}`);
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

function sendOfficeEmail_(payload, orderId, itemsSummary) {
  if (!CONFIG.officeEmail) return "";
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
    MailApp.sendEmail(CONFIG.officeEmail, subject, bodyLines.join("\n"));
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
