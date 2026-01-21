(() => {
  const DEFAULT_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz5pPLqQs4yEwqGXgkNF33J0FtdXUurTeMebjObAIuFf-_h0IUVkFy5UYiFAFss0nQ8/exec";
  const DEFAULT_TIMEOUT_MS = 15000;
  const RETRY_DELAY_MS = 700;
  const CACHE_VERSION = 3;
  const CACHE_KEYS = {
    CATALOG: "orderportal_catalog_v3",
    ORDERS: "orderportal_orders_v2",
  };

  const urlParams = new URLSearchParams(window.location.search);
  const debugFlag = (urlParams.get("debug") || "").toLowerCase() === "true";
  if (typeof window.DEBUG === "undefined") {
    window.DEBUG = debugFlag;
  }

  function log(...args) {
    if (window.DEBUG) console.log("[OrderPortal]", ...args);
  }

  function warn(...args) {
    if (window.DEBUG) console.warn("[OrderPortal]", ...args);
  }

  function getBaseUrl() {
    return window.APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL;
  }

  function createCorrelationId() {
    return `cid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function isHtmlResponse(text, contentType) {
    const trimmed = String(text || "").trim().toLowerCase();
    if (contentType && contentType.includes("text/html")) return true;
    return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.startsWith("<head");
  }

  function formatErrorMessage(err) {
    if (!err) return "Unknown error.";
    if (typeof err === "string") return err;
    if (err.userMessage) return err.userMessage;
    if (err.message) return err.message;
    return "Unexpected error.";
  }

  function showBanner(message, type = "error") {
    const banner = document.getElementById("globalBanner");
    if (!banner) return;
    banner.className = `banner banner--${type}`;
    banner.textContent = message;
    banner.hidden = !message;
  }

  function hideBanner() {
    const banner = document.getElementById("globalBanner");
    if (banner) banner.hidden = true;
  }

  function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("toast--visible"));
    setTimeout(() => {
      toast.classList.remove("toast--visible");
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  function setRefreshState(button, isLoading, label) {
    if (!button) return;
    if (isLoading) {
      if (!button.dataset.label) {
        button.dataset.label = button.textContent;
      }
      button.textContent = label || "Refreshing…";
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.classList.add("btn--loading");
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.classList.remove("btn--loading");
    }
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  }

  function normalizeCategory(category) {
    const safe = category || {};
    return {
      category: String(safe.category || "").trim(),
      display_name: String(safe.display_name || safe.category || "").trim(),
      sort: Number(safe.sort || 9999),
    };
  }

  function normalizeProduct(product) {
    const safe = product || {};
    return {
      item_no: String(safe.item_no || "").trim(),
      sku: String(safe.sku || "").trim(),
      name: String(safe.name || "").trim(),
      category: String(safe.category || "").trim(),
      unit: String(safe.unit || "").trim(),
      pack_size: String(safe.pack_size || "").trim(),
      sort: Number(safe.sort || 9999),
    };
  }

  function validateCategoriesResponse(data) {
    if (!data || typeof data !== "object") throw new Error("Missing categories response.");
    if (!Array.isArray(data.categories)) throw new Error("Categories payload missing array.");
    const categories = data.categories.map(normalizeCategory).filter((cat) => cat.category);
    return { categories, updatedAt: data.updated_at || "" };
  }

  function validateProductsResponse(data) {
    if (!data || typeof data !== "object") throw new Error("Missing products response.");
    if (!Array.isArray(data.products)) throw new Error("Products payload missing array.");
    const products = data.products.map(normalizeProduct).filter((prod) => prod.sku && prod.name && prod.category);
    return { products, updatedAt: data.updated_at || "" };
  }

  function validateOrdersResponse(data) {
    if (!data || typeof data !== "object") throw new Error("Missing orders response.");
    if (!Array.isArray(data.orders)) throw new Error("Orders payload missing array.");
    if (!Array.isArray(data.items)) throw new Error("Order items payload missing array.");
    return {
      orders: data.orders,
      items: data.items,
      updatedAt: data.updated_at || "",
    };
  }

  function saveCatalog(catalog) {
    if (!catalog) return;
    const payload = {
      version: CACHE_VERSION,
      cachedAt: new Date().toISOString(),
      updatedAt: catalog.updatedAt || "",
      categories: catalog.categories || [],
      products: catalog.products || [],
    };
    localStorage.setItem(CACHE_KEYS.CATALOG, JSON.stringify(payload));
  }

  function loadCatalog() {
    const raw = safeJsonParse(localStorage.getItem(CACHE_KEYS.CATALOG) || "");
    if (!raw || raw.version !== CACHE_VERSION) return null;
    return raw;
  }

  function saveOrders(payload) {
    if (!payload) return;
    const stored = {
      version: CACHE_VERSION,
      cachedAt: new Date().toISOString(),
      updatedAt: payload.updatedAt || "",
      orders: payload.orders || [],
      items: payload.items || [],
    };
    localStorage.setItem(CACHE_KEYS.ORDERS, JSON.stringify(stored));
  }

  function loadOrders() {
    const raw = safeJsonParse(localStorage.getItem(CACHE_KEYS.ORDERS) || "");
    if (!raw || raw.version !== CACHE_VERSION) return null;
    return raw;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function apiFetch(action, options = {}) {
    const {
      method = "GET",
      params = {},
      body,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      retry = 1,
      cacheBust = true,
    } = options;

    const correlationId = createCorrelationId();
    const url = new URL(getBaseUrl());
    url.searchParams.set("action", action);
    url.searchParams.set("cid", correlationId);
    if (cacheBust) url.searchParams.set("t", String(Date.now()));
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      url.searchParams.set(key, String(value));
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const fetchOptions = {
      method,
      signal: controller.signal,
      headers: {},
    };

    if (method !== "GET") {
      fetchOptions.headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify({
        ...(body || {}),
        correlation_id: correlationId,
      });
    }

    const attemptFetch = async (attempt) => {
      try {
        log("Request", { method, url: url.toString() });
        const res = await fetch(url.toString(), fetchOptions);
        const contentType = res.headers.get("content-type") || "";
        const text = await res.text();

        log("Response", {
          status: res.status,
          contentType,
          preview: text.slice(0, 300),
        });

        if (isHtmlResponse(text, contentType)) {
          const message = "The server returned HTML instead of JSON. This usually means the Apps Script web app requires authorization or is not publicly accessible.";
          const err = new Error(message);
          err.userMessage = `${message} Check the web app deployment permissions and access settings.`;
          err.isHtml = true;
          throw err;
        }

        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }

        const data = safeJsonParse(text);
        if (!data) {
          const err = new Error("Failed to parse JSON response.");
          err.raw = text;
          throw err;
        }

        if (data.ok === false) {
          const err = new Error(data.error || "Request failed.");
          err.payload = data;
          throw err;
        }

        return data;
      } catch (err) {
        clearTimeout(timeout);
        if (err && err.name === "TypeError") err.isNetworkError = true;
        if (attempt < retry && (err.name === "AbortError" || err.status >= 500 || err.isNetworkError)) {
          warn("Retrying request", { attempt, error: err });
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          return attemptFetch(attempt + 1);
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    };

    try {
      return await attemptFetch(0);
    } catch (err) {
      const message = formatErrorMessage(err);
      log("Request failed", message);
      throw err;
    }
  }

  async function refreshCategoriesAndProducts(options = {}) {
    const { force = false } = options;
    const cached = loadCatalog();
    if (cached && !force) {
      return { ...cached, source: "cache" };
    }

    const [categoriesResponse, productsResponse] = await Promise.all([
      apiFetch("categories", { cacheBust: true }),
      apiFetch("products", { cacheBust: true }),
    ]);

    const categoriesData = validateCategoriesResponse(categoriesResponse);
    const productsData = validateProductsResponse(productsResponse);

    const updatedAt = productsData.updatedAt || categoriesData.updatedAt || new Date().toISOString();
    const payload = {
      categories: categoriesData.categories,
      products: productsData.products,
      updatedAt,
    };
    saveCatalog(payload);
    return { ...payload, cachedAt: new Date().toISOString(), source: "network" };
  }

  async function refreshOrders(options = {}) {
    const { force = false } = options;
    const cached = loadOrders();
    if (cached && !force) {
      return { ...cached, source: "cache" };
    }

    const response = await apiFetch("listOrders", { cacheBust: true });
    const ordersData = validateOrdersResponse(response);
    saveOrders(ordersData);
    return { ...ordersData, cachedAt: new Date().toISOString(), source: "network" };
  }

  function enrichItemsWithCatalog(items, catalog) {
    if (!Array.isArray(items) || !catalog || !Array.isArray(catalog.products)) return items || [];
    const productMap = new Map();
    catalog.products.forEach((product) => {
      if (product.sku) productMap.set(String(product.sku), product);
    });
    return items.map((item) => {
      const sku = String(item.sku || "");
      const match = sku ? productMap.get(sku) : null;
      return {
        ...item,
        item_no: item.item_no || match?.item_no || "",
        name: item.name || match?.name || "",
        category: item.category || match?.category || "",
        unit: item.unit || match?.unit || "",
        pack_size: item.pack_size || match?.pack_size || "",
      };
    });
  }

  function bindRefreshButtons(handlers) {
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-refresh]");
      if (!button) return;
      const type = button.getAttribute("data-refresh");
      const handler = handlers?.[type];
      if (typeof handler === "function") handler(button);
    });
  }

  function watchNetworkStatus(onChange) {
    const handler = () => onChange?.(navigator.onLine);
    window.addEventListener("online", handler);
    window.addEventListener("offline", handler);
    handler();
  }

  function testValidateCategoriesResponse() {
    const good = validateCategoriesResponse({ categories: [{ category: "Test", display_name: "Test", sort: 1 }] });
    let bad = false;
    try {
      validateCategoriesResponse({ categories: "oops" });
    } catch (err) {
      bad = true;
    }
    return { good: !!good.categories.length, bad };
  }

  function testValidateProductsResponse() {
    const good = validateProductsResponse({ products: [{ sku: "SKU1", name: "Test", category: "Cat" }] });
    let bad = false;
    try {
      validateProductsResponse({ products: {} });
    } catch (err) {
      bad = true;
    }
    return { good: !!good.products.length, bad };
  }

  function testValidateOrdersResponse() {
    const good = validateOrdersResponse({ orders: [], items: [] });
    let bad = false;
    try {
      validateOrdersResponse({ orders: [] });
    } catch (err) {
      bad = true;
    }
    return { good: Array.isArray(good.orders), bad };
  }

  window.AppClient = {
    getBaseUrl,
    apiFetch,
    refreshCategoriesAndProducts,
    refreshOrders,
    loadCatalog,
    saveCatalog,
    loadOrders,
    saveOrders,
    enrichItemsWithCatalog,
    validateCategoriesResponse,
    validateProductsResponse,
    validateOrdersResponse,
    setRefreshState,
    showBanner,
    hideBanner,
    showToast,
    bindRefreshButtons,
    watchNetworkStatus,
    testValidateCategoriesResponse,
    testValidateProductsResponse,
    testValidateOrdersResponse,
    log,
  };
})();
