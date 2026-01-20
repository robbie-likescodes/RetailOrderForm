function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "").trim();
    if (!action) {
      return jsonResponse({ ok: false, error: "Missing action." });
    }

    if (action === "categories") {
      const rows = getSheetRows_(SHEET_CATEGORIES)
        .filter(row => row.category && isRowActive_(row))
        .map(row => ({
          category: String(row.category || "").trim(),
          display_name: String(row.display_name || row.category || "").trim(),
          sort: Number(row.sort || 9999),
        }))
        .sort((a, b) => a.sort - b.sort);

      return jsonResponse({
        ok: true,
        categories: rows,
        updated_at: new Date().toISOString(),
      });
    }

    if (action === "products") {
      const rows = getSheetRows_(SHEET_PRODUCTS)
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
        products: rows,
        updated_at: new Date().toISOString(),
      });
    }

    return jsonResponse({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: String(err),
      updated_at: new Date().toISOString(),
    });
  }
}
