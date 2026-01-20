function doGet(e) {
  const requestId = Utilities.getUuid();
  try {
    const action = String((e && e.parameter && e.parameter.action) || "").trim();
    if (!action) {
      return jsonResponse(buildError_(
        "Missing action.",
        "MISSING_ACTION",
        { expected: ["categories", "products", "order_history"] },
        requestId
      ));
    }

    if (action === "categories") {
      const rows = getSheetRows_(CONFIG.sheets.categories)
        .filter(row => row.category && isRowActive_(row))
        .map(row => ({
          category: String(row.category || "").trim(),
          display_name: String(row.display_name || row.category || "").trim(),
          sort: Number(row.sort || 9999),
        }))
        .sort((a, b) => a.sort - b.sort);

      return jsonResponse({
        ok: true,
        action,
        request_id: requestId,
        categories: rows,
        updated_at: new Date().toISOString(),
      });
    }

    if (action === "products") {
      const rows = getSheetRows_(CONFIG.sheets.products)
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

      return jsonResponse({
        ok: true,
        action,
        request_id: requestId,
        products: rows,
        updated_at: new Date().toISOString(),
      });
    }

    if (action === "order_history") {
      const getTime = (value) => {
        if (value instanceof Date) return value.getTime();
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
      };

      const orders = getSheetRows_(CONFIG.sheets.orders)
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

      const items = getSheetRows_(CONFIG.sheets.orderItems)
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
        action,
        request_id: requestId,
        orders,
        items,
        updated_at: new Date().toISOString(),
      });
    }

    return jsonResponse(buildError_(
      `Unknown action: ${action}`,
      "UNKNOWN_ACTION",
      { received: action, expected: ["categories", "products", "order_history"] },
      requestId
    ));
  } catch (err) {
    return jsonResponse(buildError_(
      String(err),
      "UNHANDLED_ERROR",
      null,
      requestId
    ));
  }
}
