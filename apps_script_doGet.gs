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
      const rawOrders = getSheetRows_(CONFIG.sheets.orders)
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
