function doGet(e) {
  const requestId = Utilities.getUuid();
  try {
    const action = getAction_(e).toLowerCase();
    Logger.log("doGet request %s action=%s cid=%s", requestId, action, getCorrelationId_(e));
    if (!action) {
      return jsonResponse(buildError_(
        "Missing action.",
        "MISSING_ACTION",
        { expected: ["categories", "products", "listOrders", "health"] },
        requestId
      ));
    }

    if (action === "categories") {
      const rows = getSheetRows_(CONFIG.sheets.categories)
        .filter(row => getFirstValue_(row, ["category", "category_name", "department", "dept"]) && isRowActive_(row))
        .map(row => ({
          category: String(getFirstValue_(row, ["category", "category_name", "department", "dept"]) || "").trim(),
          display_name: String(getFirstValue_(row, ["display_name", "display", "name", "category", "category_name"]) || "").trim(),
          sort: Number(getFirstValue_(row, ["sort", "order", "display_order"]) || 9999),
        }))
        .sort((a, b) => a.sort - b.sort);

      return jsonResponse(buildSuccess_({
        action,
        request_id: requestId,
        categories: rows,
      }, requestId));
    }

    if (action === "products") {
      const rows = getSheetRows_(CONFIG.sheets.products)
        .filter(row => {
          const sku = getFirstValue_(row, ["sku", "product_sku", "item_sku", "id", "product_id"]);
          const name = getFirstValue_(row, ["name", "product_name", "item_name", "description"]);
          const category = getFirstValue_(row, ["category", "category_name", "department", "dept"]);
          return sku && name && category && isRowActive_(row);
        })
        .map(row => ({
          item_no: String(getFirstValue_(row, ["item_no", "item_number", "item"]) || "").trim(),
          sku: String(getFirstValue_(row, ["sku", "product_sku", "item_sku", "id", "product_id"]) || "").trim(),
          name: String(getFirstValue_(row, ["name", "product_name", "item_name", "description"]) || "").trim(),
          category: String(getFirstValue_(row, ["category", "category_name", "department", "dept"]) || "").trim(),
          unit: String(getFirstValue_(row, ["unit", "uom"]) || "").trim(),
          pack_size: String(getFirstValue_(row, ["pack_size", "pack", "case_size", "case_pack"]) || "").trim(),
          sort: Number(getFirstValue_(row, ["sort", "order", "display_order"]) || 9999),
        }))
        .sort((a, b) => a.sort - b.sort);

      return jsonResponse(buildSuccess_({
        action,
        request_id: requestId,
        products: rows,
      }, requestId));
    }

    if (action === "order_history" || action === "listorders") {
      const getTime = (value) => {
        if (value instanceof Date) return value.getTime();
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
      };

      const orderRows = getSheetRows_(CONFIG.sheets.orders)
        .filter(row => row.order_id && row.store)
        .sort((a, b) => {
          const storeCompare = String(a.store || "").localeCompare(String(b.store || ""));
          if (storeCompare !== 0) return storeCompare;
          const bTime = getTime(getFirstValue_(b, ["created_at", "timestamp", "created", "submitted_at", "submitted", "order_date", "date"]));
          const aTime = getTime(getFirstValue_(a, ["created_at", "timestamp", "created", "submitted_at", "submitted", "order_date", "date"]));
          return bTime - aTime;
        });

      let itemRows = [];
      try {
        itemRows = getSheetRows_(CONFIG.sheets.orderItems);
      } catch (err) {
        itemRows = [];
      }

      const itemsByOrder = new Map();
      itemRows
        .filter(row => row.order_id && (row.sku || row.name))
        .forEach(row => {
          const orderId = String(row.order_id || "").trim();
          if (!orderId) return;
          const item = {
            order_id: orderId,
            item_no: String(row.item_no || "").trim(),
            sku: String(row.sku || "").trim(),
            name: String(row.name || row.sku || "").trim(),
            category: String(row.category || "").trim(),
            unit: String(row.unit || "").trim(),
            pack_size: String(row.pack_size || "").trim(),
            qty: row.qty || "",
          };
          if (!itemsByOrder.has(orderId)) itemsByOrder.set(orderId, []);
          itemsByOrder.get(orderId).push(item);
        });

      const orderItemsByOrder = new Map();
      const items = [];
      orderRows.forEach((row) => {
        const orderId = String(row.order_id || "").trim();
        if (!orderId) return;
        const rowItems = extractOrderItems_(row);
        const existingItems = itemsByOrder.get(orderId) || [];
        const mergedItems = existingItems.length
          ? mergeOrderItemsWithRow_(existingItems, rowItems)
          : rowItems.map(item => ({ ...item, order_id: orderId }));
        mergedItems.forEach(item => {
          if (!item.order_id) item.order_id = orderId;
        });
        orderItemsByOrder.set(orderId, mergedItems);
        items.push(...mergedItems);
      });

      const orders = orderRows.map(row => {
        const orderId = String(row.order_id || "").trim();
        const createdAt = String(getFirstValue_(row, [
          "created_at",
          "timestamp",
          "created",
          "submitted_at",
          "submitted",
          "order_date",
          "date",
        ]) || "").trim();
        const requestedDate = String(getFirstValue_(row, [
          "requested_date",
          "request_date",
          "requested",
          "delivery_date",
          "needed_by",
        ]) || "").trim();

        const orderItems = orderItemsByOrder.get(orderId) || [];
        const itemCount = row.item_count || orderItems.length || "";
        const totalQty = row.total_qty || orderItems.reduce((sum, item) => {
          const qty = Number(item.qty || 0);
          return sum + (Number.isFinite(qty) ? qty : 0);
        }, 0) || "";

        return {
          order_id: orderId,
          created_at: createdAt,
          store: String(row.store || "").trim(),
          placed_by: String(row.placed_by || "").trim(),
          email: String(row.email || "").trim(),
          requested_date: requestedDate,
          notes: String(row.notes || "").trim(),
          item_count: itemCount,
          total_qty: totalQty,
          status: String(row.status || "").trim(),
        };
      });

      items.sort((a, b) => {
        const orderCompare = String(a.order_id || "").localeCompare(String(b.order_id || ""));
        if (orderCompare !== 0) return orderCompare;
        return String(a.name || a.sku || "").localeCompare(String(b.name || b.sku || ""));
      });

      return jsonResponse(buildSuccess_({
        action: "listOrders",
        request_id: requestId,
        orders,
        items,
      }, requestId));
    }

    if (action === "health") {
      const categories = getSheetRows_(CONFIG.sheets.categories);
      const products = getSheetRows_(CONFIG.sheets.products);
      return jsonResponse(buildSuccess_({
        action,
        request_id: requestId,
        sheet_id: CONFIG.spreadsheetId || SpreadsheetApp.getActiveSpreadsheet().getId(),
        counts: {
          categories: categories.length,
          products: products.length,
        },
      }, requestId));
    }

    return jsonResponse(buildError_(
      `Unknown action: ${action}`,
      "UNKNOWN_ACTION",
      { received: action, expected: ["categories", "products", "listOrders", "health"] },
      requestId
    ));
  } catch (err) {
    Logger.log("doGet error %s: %s", requestId, err);
    return jsonResponse(buildError_(
      String(err),
      "UNHANDLED_ERROR",
      null,
      requestId
    ));
  }
}
