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

    const itemsSummary = buildItemsSummary_(normalized.items);

    const ordersSheet = ensureSheet_(CONFIG.sheets.orders, orderHeaders);
    ensureOrdersEmailSentColumn_(ordersSheet, orderHeaders);
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
      "",
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
    const appendedRow = ordersSheet.getLastRow();

    Logger.log("doPost sendEmail requestId=%s", requestId);
    const emailError = sendOfficeEmail_(payload, orderId, itemsSummary, { sheet: ordersSheet, rowIndex: appendedRow });

    const response = { order_id: orderId, request_id: requestId };
    if (emailError) {
      response.warnings = [{ code: "EMAIL_FAILED", message: emailError }];
      response.email_status = "failed";
      response.email_error = emailError;
    } else {
      response.email_status = "sent";
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
    "email_sent_at",
  ];

  for (let i = 1; i <= maxProducts; i += 1) {
    headers.push(`Product ${i}`, `Qty ${i}`, `Product ${i} Status`);
  }

  return headers;
}

function getHeaderIndex_(sheet, headerName) {
  if (!sheet) return 0;
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) return 0;
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(normalizeHeader_);
  return headers.indexOf(normalizeHeader_(headerName)) + 1;
}

function ensureOrdersEmailSentColumn_(sheet, expectedHeaders) {
  if (!sheet) return;
  const expectedIndex = expectedHeaders.map(normalizeHeader_).indexOf("email_sent_at") + 1;
  if (!expectedIndex) return;
  const existingIndex = getHeaderIndex_(sheet, "email_sent_at");
  if (existingIndex) return;
  sheet.insertColumnBefore(expectedIndex);
  sheet.getRange(1, expectedIndex).setValue(expectedHeaders[expectedIndex - 1]);
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

function formatOrderItemsForEmail_(items) {
  if (!items || !items.length) return ["(No items provided)"];
  return items.map(item => {
    const name = item.name || item.sku || "Item";
    const qty = item.qty || "";
    const unit = item.unit || item.unit_size || "";
    const pack = item.pack_size || item.pack || "";
    const status = item.status || "";
    const parts = [];
    if (qty !== "") parts.push(`Qty: ${qty}`);
    if (unit) parts.push(`Unit: ${unit}`);
    if (pack) parts.push(`Size: ${pack}`);
    if (status) parts.push(`Status: ${status}`);
    const details = parts.length ? ` (${parts.join(" | ")})` : "";
    return `- ${name}${details}`;
  });
}

function sendOfficeEmail_(payload, orderId, itemsSummary, options) {
  const contactInfo = getOrderNotificationEmails_();
  if (contactInfo.error) {
    Logger.log("orderEmail contacts error order_id=%s message=%s", orderId, contactInfo.error);
    return contactInfo.error;
  }
  const recipients = contactInfo.emails || [];
  if (!recipients.length) {
    Logger.log("orderEmail recipients empty order_id=%s", orderId);
    return "No notification emails found in Contacts sheet.";
  }

  const sheet = options && options.sheet ? options.sheet : null;
  const rowIndex = options && options.rowIndex ? options.rowIndex : 0;
  const emailSentColumn = sheet ? getHeaderIndex_(sheet, "email_sent_at") : 0;
  if (sheet && rowIndex && emailSentColumn) {
    const existing = sheet.getRange(rowIndex, emailSentColumn).getValue();
    if (existing) {
      Logger.log("orderEmail already sent order_id=%s", orderId);
      return "";
    }
  }

  try {
    const subject = `New Retail Order ${orderId}`;
    const bodyLines = [
      `Order ID: ${orderId}`,
      `Store: ${payload.store || ""}`,
      `Requested date: ${payload.requested_date || ""}`,
      `Created timestamp: ${payload.timestamp || ""}`,
      `Placed by: ${payload.placed_by || ""}`,
      `Email: ${payload.email || ""}`,
      `Notes: ${payload.notes || ""}`,
      "Items:",
      ...formatOrderItemsForEmail_(payload.items || []),
      "",
      `Items summary: ${itemsSummary || ""}`,
    ];
    Logger.log("orderEmail sending order_id=%s recipients=%s", orderId, recipients.length);
    GmailApp.sendEmail(recipients.join(","), subject, bodyLines.join("\n"));
    if (sheet && rowIndex && emailSentColumn) {
      sheet.getRange(rowIndex, emailSentColumn).setValue(new Date().toISOString());
    }
    Logger.log("orderEmail sent order_id=%s", orderId);
    return "";
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    Logger.log("orderEmail failed order_id=%s error=%s", orderId, message);
    if (message.toLowerCase().includes("authorization") || message.toLowerCase().includes("not authorized")) {
      Logger.log("orderEmail authorization required. Run a manual testSendOrderEmail() to authorize GmailApp.");
    }
    return message;
  }
}

function testSendOrderEmail() {
  try {
    const sheet = getSpreadsheet_().getSheetByName(CONFIG.sheets.orders);
    if (!sheet) {
      Logger.log("testSendOrderEmail: Orders sheet not found.");
      return;
    }
    const rows = getSheetRows_(CONFIG.sheets.orders);
    if (!rows.length) {
      Logger.log("testSendOrderEmail: Orders sheet is empty.");
      return;
    }
    const lastRow = rows[rows.length - 1];
    const orderId = String(lastRow.order_id || "").trim();
    if (!orderId) {
      Logger.log("testSendOrderEmail: Missing order_id in last row.");
      return;
    }
    const payload = {
      store: lastRow.store || "",
      placed_by: lastRow.placed_by || "",
      email: lastRow.email || "",
      notes: lastRow.notes || "",
      timestamp: lastRow.timestamp || "",
      requested_date: lastRow.requested_date || "",
      items: collectOrderItemsFromRow_(lastRow),
    };
    const itemsSummary = String(lastRow.items_summary || "");
    const emailSentColumn = getHeaderIndex_(sheet, "email_sent_at");
    const orderIdColumn = getHeaderIndex_(sheet, "order_id");
    let rowIndex = 0;
    if (orderIdColumn) {
      const values = sheet.getRange(2, orderIdColumn, sheet.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < values.length; i += 1) {
        if (String(values[i][0] || "").trim() === orderId) {
          rowIndex = i + 2;
          break;
        }
      }
    }
    if (rowIndex && emailSentColumn) {
      const existing = sheet.getRange(rowIndex, emailSentColumn).getValue();
      if (existing) {
        Logger.log("testSendOrderEmail: Email already sent for order_id=%s at %s", orderId, existing);
        return;
      }
    }
    const emailError = sendOfficeEmail_(payload, orderId, itemsSummary, { sheet, rowIndex });
    if (emailError) {
      Logger.log("testSendOrderEmail: Failed order_id=%s error=%s", orderId, emailError);
    } else {
      Logger.log("testSendOrderEmail: Success order_id=%s", orderId);
    }
  } catch (err) {
    Logger.log("testSendOrderEmail: Unexpected error %s", err);
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
