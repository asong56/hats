// api.js — thin fetch wrapper around Redew's REST API. No framework, no
// build step: this is plain ES modules loaded directly by the browser.

const BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    credentials: "same-origin",
    headers: options.body instanceof FormData
      ? undefined
      : { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res;
}

export const api = {
  // Groups
  listGroups: () => request("/groups").then((r) => r.data),
  createGroup: (name) =>
    request("/groups", { method: "POST", body: JSON.stringify({ name }) }).then((r) => r.data),

  // Feeds
  listFeeds: () => request("/feeds").then((r) => r.data),
  createFeed: (payload) =>
    request("/feeds", { method: "POST", body: JSON.stringify(payload) }).then((r) => r.data),
  validateFeed: (url) =>
    request("/feeds/validate", { method: "POST", body: JSON.stringify({ url }) }).then((r) => r.data),
  deleteFeed: (id) => request(`/feeds/${id}`, { method: "DELETE" }),
  refreshAllFeeds: () => request("/feeds/refresh", { method: "POST" }).then((r) => r.data),
  refreshFeed: (id) => request(`/feeds/${id}/refresh`, { method: "POST" }).then((r) => r.data),

  // Items
  listItems: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/items${qs ? "?" + qs : ""}`);
  },
  getItem: (id) => request(`/items/${id}`).then((r) => r.data),
  markItemsRead: (ids) =>
    request("/items/-/read", { method: "PATCH", body: JSON.stringify({ ids }) }),
  markItemsUnread: (ids) =>
    request("/items/-/unread", { method: "PATCH", body: JSON.stringify({ ids }) }),
  exportItemMarkdownURL: (id) => `${BASE}/items/${id}/markdown`,

  // Search
  search: (query) => request(`/search?q=${encodeURIComponent(query)}`).then((r) => r.data),

  // Bookmarks (favorites)
  listBookmarks: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/bookmarks${qs ? "?" + qs : ""}`).then((r) => r.data);
  },
  createBookmark: (payload) =>
    request("/bookmarks", { method: "POST", body: JSON.stringify(payload) }).then((r) => r.data),
  deleteBookmark: (id) => request(`/bookmarks/${id}`, { method: "DELETE" }),

  // Settings
  getSettings: () => request("/settings").then((r) => r.data),
  updateSettings: (payload) =>
    request("/settings", { method: "PATCH", body: JSON.stringify(payload) }).then((r) => r.data),
  clearCache: () => request("/cache/clear", { method: "POST" }).then((r) => r.data),

  // OPML
  importOPML: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request("/opml/import", { method: "POST", body: form }).then((r) => r.data);
  },
};
