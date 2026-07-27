// app.js — Redew's entire frontend logic. No framework: state lives in a
// plain object, rendering uses real DOM APIs, and the toolbar/shortcuts are
// wired directly to fetch calls through api.js.

import { api } from "./api.js";
import { startAccentClock } from "./accent.js";
import { highlightCodeBlocks } from "./highlight.js";
import { domainLabel, formatISODate, groupFeedsForSidebar, extractSummary } from "./util.js";

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

const state = {
  groups: [],
  feeds: [],
  items: [],
  currentView: { type: "all" }, // {type: "all"|"bookmarks"|"feed"|"group", id?}
  currentItem: null,
  currentBookmarkId: null, // bookmark id if the open item is favorited
  settings: null,
  searchQuery: "",
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------

async function boot() {
  startAccentClock();

  try {
    state.settings = await api.getSettings();
    applyTheme(state.settings.theme);
    el("setting-theme").value = state.settings.theme;
    el("setting-hide-read").checked = state.settings.hide_read;
    el("setting-pull-interval").value = String(state.settings.pull_interval_seconds);
    el("settings-config-path").textContent = "Config file: " + state.settings.config_path;
  } catch (err) {
    console.error("failed to load settings", err);
  }

  await Promise.all([loadGroupsAndFeeds()]);
  renderSidebar();

  wireGlobalEvents();
  await selectView({ type: "all" });
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }
}

async function loadGroupsAndFeeds() {
  const [groups, feeds] = await Promise.all([api.listGroups(), api.listFeeds()]);
  state.groups = groups || [];
  state.feeds = feeds || [];
}

// ---------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------

function renderSidebar() {
  const tree = el("group-tree");
  tree.innerHTML = "";

  const buckets = groupFeedsForSidebar(state.feeds, state.groups);

  for (const bucket of buckets) {
    const heading = document.createElement("li");
    const headingRow = document.createElement("p");
    headingRow.className = "group-heading";
    headingRow.textContent = bucket.label;
    heading.appendChild(headingRow);
    tree.appendChild(heading);

    for (const feed of bucket.feeds) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "feed-link";
      btn.dataset.feedId = String(feed.id);

      btn.appendChild(makeFavicon(feed.site_url || feed.link, feed.name));

      const nameSpan = document.createElement("span");
      nameSpan.className = "feed-name-text";
      nameSpan.textContent = feed.name;
      btn.appendChild(nameSpan);

      const dot = document.createElement("span");
      dot.className = "unread-dot";
      if (!feed.unread_count) dot.hidden = true;
      btn.appendChild(dot);

      btn.addEventListener("click", () => selectView({ type: "feed", id: feed.id, name: feed.name }));

      li.appendChild(btn);
      tree.appendChild(li);
    }
  }

  updateSidebarActiveState();
}

/**
 * Builds a small favicon element for a feed: tries the site's real favicon
 * via a lightweight, privacy-respecting proxy-free approach (browser
 * fetches the origin's own /favicon.ico directly), and falls back to a
 * colored initial if the image fails to load or there's no URL at all.
 */
function makeFavicon(pageUrl, name) {
  const wrap = document.createElement("span");
  wrap.className = "feed-favicon";

  let origin = null;
  try {
    origin = pageUrl ? new URL(pageUrl).origin : null;
  } catch {
    origin = null;
  }

  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";

  if (!origin) {
    wrap.textContent = initial;
    return wrap;
  }

  const img = document.createElement("img");
  img.src = origin + "/favicon.ico";
  img.alt = "";
  img.width = 16;
  img.height = 16;
  img.loading = "lazy";
  img.addEventListener("error", () => {
    wrap.innerHTML = "";
    wrap.textContent = initial;
  }, { once: true });
  wrap.appendChild(img);
  return wrap;
}

function updateSidebarActiveState() {
  document.querySelectorAll("#smart-views a").forEach((a) => a.removeAttribute("aria-current"));
  document.querySelectorAll("#group-tree button.feed-link").forEach((b) => b.removeAttribute("aria-current"));

  const view = state.currentView;
  if (view.type === "all") {
    el("smart-views").querySelector('[data-view="all"]').setAttribute("aria-current", "page");
  } else if (view.type === "bookmarks") {
    el("smart-views").querySelector('[data-view="bookmarks"]').setAttribute("aria-current", "page");
  } else if (view.type === "feed") {
    const btn = document.querySelector(`#group-tree button.feed-link[data-feed-id="${view.id}"]`);
    if (btn) btn.setAttribute("aria-current", "page");
  }
}

// ---------------------------------------------------------------------
// View selection + article list
// ---------------------------------------------------------------------

async function selectView(view) {
  state.currentView = view;
  updateSidebarActiveState();
  closeReadingPane();

  const titleEl = el("list-title");
  titleEl.textContent = view.type === "all" ? "All articles"
    : view.type === "bookmarks" ? "Favorites"
    : view.name || "Feed";

  await loadItemsForCurrentView();
}

async function loadItemsForCurrentView() {
  const view = state.currentView;
  const listEl = el("article-list");
  const emptyEl = el("article-list-empty");
  listEl.innerHTML = "";
  emptyEl.hidden = true;

  let items = [];
  try {
    if (view.type === "bookmarks") {
      const bookmarks = await api.listBookmarks({ limit: 100 });
      items = bookmarks.map(bookmarkToItemShape);
    } else {
      const params = { limit: 50 };
      if (view.type === "feed") params.feed_id = view.id;
      if (state.settings && state.settings.hide_read) params.unread = true;
      const res = await api.listItems(params);
      items = res.data || [];
    }
  } catch (err) {
    console.error("failed to load items", err);
  }

  state.items = items;
  renderArticleList();
}

function bookmarkToItemShape(b) {
  return {
    id: b.item_id, // may be null for orphaned bookmarks
    bookmark_id: b.id,
    feed_id: b.feed_id,
    title: b.title,
    link: b.link,
    content: b.content,
    pub_date: b.pub_date,
    unread: b.unread,
    _isBookmark: true,
  };
}

function feedNameFor(feedId) {
  const feed = state.feeds.find((f) => f.id === feedId);
  return feed ? feed.name : "";
}

function renderArticleList() {
  const listEl = el("article-list");
  const emptyEl = el("article-list-empty");
  listEl.innerHTML = "";

  const hideRead = state.settings && state.settings.hide_read;
  const visibleItems = hideRead ? state.items.filter((it) => it.unread) : state.items;

  if (visibleItems.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const item of visibleItems) {
    const li = document.createElement("li");
    const row = document.createElement("button");
    row.type = "button";
    row.className = "article-row" + (item.unread ? "" : " is-read");
    row.dataset.itemId = String(item.id ?? "");
    if (item._isBookmark) row.dataset.bookmarkId = String(item.bookmark_id);

    const dot = document.createElement("span");
    dot.className = "unread-dot";
    if (!item.unread) dot.hidden = true;
    row.appendChild(dot);

    const texts = document.createElement("span");
    texts.className = "article-texts";

    const title = document.createElement("span");
    title.className = "article-title";
    title.textContent = item.title || "(untitled)";
    texts.appendChild(title);

    const summaryText = extractSummary(item.content, 140);
    if (summaryText) {
      const summary = document.createElement("span");
      summary.className = "article-summary";
      summary.textContent = summaryText;
      texts.appendChild(summary);
    }

    const subline = document.createElement("span");
    subline.className = "article-subline";
    const feed = state.feeds.find((f) => f.id === item.feed_id);
    const feedName = item.feed_name || (feed ? feed.name : "");
    if (feedName) {
      subline.appendChild(makeFavicon(feed && (feed.site_url || feed.link), feedName));
      const feedSpan = document.createElement("span");
      feedSpan.className = "feed-name";
      feedSpan.textContent = feedName;
      subline.appendChild(feedSpan);
    }
    const dateSpan = document.createElement("time");
    if (feedName) dateSpan.className = "dot-sep";
    dateSpan.textContent = formatISODate(item.pub_date);
    subline.appendChild(dateSpan);
    texts.appendChild(subline);

    row.appendChild(texts);
    row.addEventListener("click", () => openItem(item));

    li.appendChild(row);
    listEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------
// Reading pane
// ---------------------------------------------------------------------

async function openItem(itemSummary) {
  let item = itemSummary;

  // Full item detail (content) is only in the single-item endpoint; the
  // bookmark listing already embeds content, so skip the extra fetch there.
  if (!item._isBookmark && item.id) {
    try {
      item = await api.getItem(item.id);
    } catch (err) {
      console.error("failed to load item", err);
      return;
    }
  }

  state.currentItem = item;
  state.currentBookmarkId = itemSummary._isBookmark ? itemSummary.bookmark_id : await findExistingBookmarkId(item);

  el("reading-placeholder").hidden = true;
  const pane = el("reading-pane");
  pane.hidden = false;

  el("reading-title").textContent = item.title || "(untitled)";
  const feedName = item.feed_name || feedNameFor(item.feed_id);
  const feedLink = el("reading-feed-name");
  feedLink.textContent = feedName || "";
  feedLink.href = item.link || "#";
  el("reading-date").textContent = formatISODate(item.pub_date);

  const body = el("reading-body");
  body.innerHTML = item.content || "<p>(no content)</p>";
  highlightCodeBlocks(body);

  el("toolbar").hidden = false;
  updateToolbarState();

  if (item.unread && item.id && !item._isBookmark) {
    try {
      await api.markItemsRead([item.id]);
      item.unread = false;
      const row = document.querySelector(`.article-row[data-item-id="${item.id}"]`);
      if (row) {
        row.classList.add("is-read");
        const dot = row.querySelector(".unread-dot");
        if (dot) dot.hidden = true;
      }
      decrementSidebarUnreadDot(item.feed_id);
    } catch (err) {
      console.error("failed to mark item read", err);
    }
  }

  // Update the article-list row to "current" for visual feedback.
  document.querySelectorAll(".article-row[aria-current]").forEach((r) => r.removeAttribute("aria-current"));
  const activeRow = document.querySelector(`.article-row[data-item-id="${item.id ?? ""}"]`);
  if (activeRow) activeRow.setAttribute("aria-current", "page");
}

async function findExistingBookmarkId(item) {
  if (!item.link) return null;
  try {
    const bookmarks = await api.listBookmarks({ limit: 100 });
    const match = bookmarks.find((b) => b.link === item.link);
    return match ? match.id : null;
  } catch {
    return null;
  }
}

function decrementSidebarUnreadDot(feedId) {
  const feed = state.feeds.find((f) => f.id === feedId);
  if (feed && feed.unread_count > 0) {
    feed.unread_count -= 1;
    if (feed.unread_count === 0) {
      const btn = document.querySelector(`#group-tree button.feed-link[data-feed-id="${feedId}"]`);
      if (btn) {
        const dot = btn.querySelector(".unread-dot");
        if (dot) dot.hidden = true;
      }
    }
  }
}

function closeReadingPane() {
  state.currentItem = null;
  state.currentBookmarkId = null;
  el("reading-pane").hidden = true;
  el("reading-placeholder").hidden = false;
  el("toolbar").hidden = true;
}

function updateToolbarState() {
  const favBtn = el("toolbar-favorite");
  const isFav = !!state.currentBookmarkId;
  favBtn.setAttribute("aria-pressed", String(isFav));
}

// ---------------------------------------------------------------------
// Toolbar actions (exactly 4 buttons; everything else lives in More)
// ---------------------------------------------------------------------

async function toggleFavorite() {
  const item = state.currentItem;
  if (!item) return;

  if (state.currentBookmarkId) {
    try {
      await api.deleteBookmark(state.currentBookmarkId);
      state.currentBookmarkId = null;
      updateToolbarState();
    } catch (err) {
      console.error("failed to remove favorite", err);
    }
    return;
  }

  try {
    const bookmark = await api.createBookmark({
      item_id: item.id ?? null,
      link: item.link,
      title: item.title,
      content: item.content,
      pub_date: item.pub_date,
      feed_name: item.feed_name || feedNameFor(item.feed_id),
    });
    state.currentBookmarkId = bookmark.id;
    updateToolbarState();
  } catch (err) {
    console.error("failed to favorite item", err);
  }
}

function openInNewTab() {
  const item = state.currentItem;
  if (item && item.link) window.open(item.link, "_blank", "noopener,noreferrer");
}

function exportAsMarkdown() {
  const item = state.currentItem;
  if (!item || !item.id) return;
  window.open(api.exportItemMarkdownURL(item.id), "_blank");
}

function toggleMoreMenu() {
  const menu = el("more-menu");
  const moreBtn = el("toolbar-more");
  const willOpen = !menu.matches(":popover-open");
  if (willOpen) {
    positionMoreMenu(menu, moreBtn);
    menu.showPopover();
  } else {
    menu.hidePopover();
  }
  moreBtn.setAttribute("aria-expanded", String(willOpen));
}

function positionMoreMenu(menu, anchorBtn) {
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.left = Math.max(8, rect.right - 220) + "px";
  menu.style.top = rect.top - 8 + "px";
  menu.style.transform = "translateY(-100%)";
}

async function markCurrentUnread() {
  const item = state.currentItem;
  if (!item || !item.id) return;
  try {
    await api.markItemsUnread([item.id]);
    item.unread = true;
    const row = document.querySelector(`.article-row[data-item-id="${item.id}"]`);
    if (row) {
      row.classList.remove("is-read");
      const dot = row.querySelector(".unread-dot");
      if (dot) dot.hidden = false;
    }
  } catch (err) {
    console.error("failed to mark unread", err);
  }
  el("more-menu").hidePopover();
}

async function markAllReadInCurrentFeed() {
  const view = state.currentView;
  const feedId = view.type === "feed" ? view.id : state.currentItem && state.currentItem.feed_id;
  if (!feedId) return;

  const ids = state.items.filter((it) => it.unread && it.feed_id === feedId).map((it) => it.id).filter(Boolean);
  if (ids.length > 0) {
    try {
      await api.markItemsRead(ids);
      await loadItemsForCurrentView();
    } catch (err) {
      console.error("failed to mark all read", err);
    }
  }
  el("more-menu").hidePopover();
}

// ---------------------------------------------------------------------
// Add feed dialog
// ---------------------------------------------------------------------

async function submitAddFeed(ev) {
  ev.preventDefault();
  const input = el("add-feed-url");
  const url = input.value.trim();
  if (!url) return;

  try {
    const result = await api.validateFeed(url);
    const discovered = result.feeds || [];

    if (discovered.length === 1) {
      await createFeedFromDiscovered(discovered[0]);
      el("add-feed-dialog").close();
      input.value = "";
      return;
    }

    if (discovered.length > 1) {
      renderDiscoveredChoices(discovered);
      return;
    }

    alert("No feed found at that URL.");
  } catch (err) {
    alert("Could not add feed: " + err.message);
  }
}

function renderDiscoveredChoices(feeds) {
  const list = el("add-feed-discovered");
  list.innerHTML = "";
  list.hidden = false;

  for (const f of feeds) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = f.title || f.link;
    btn.addEventListener("click", async () => {
      await createFeedFromDiscovered(f);
      el("add-feed-dialog").close();
      list.hidden = true;
      el("add-feed-url").value = "";
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function createFeedFromDiscovered(feed) {
  await api.createFeed({
    group_id: 1, // Default group; auto-grouped by domain in the sidebar
    name: feed.title || domainLabel(feed.link),
    link: feed.link,
  });
  await loadGroupsAndFeeds();
  renderSidebar();
}

// ---------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------

async function saveThemeSetting() {
  const theme = el("setting-theme").value;
  applyTheme(theme);
  try {
    state.settings = await api.updateSettings({ theme });
  } catch (err) {
    console.error("failed to save theme", err);
  }
}

async function saveHideReadSetting() {
  const hideRead = el("setting-hide-read").checked;
  try {
    state.settings = await api.updateSettings({ hide_read: hideRead });
    renderArticleList();
  } catch (err) {
    console.error("failed to save hide_read", err);
  }
}

async function savePullIntervalSetting() {
  const seconds = parseInt(el("setting-pull-interval").value, 10);
  try {
    state.settings = await api.updateSettings({ pull_interval_seconds: seconds });
  } catch (err) {
    console.error("failed to save pull interval", err);
  }
}

async function runClearCache() {
  const output = el("clear-cache-result");
  output.textContent = "Clearing…";
  try {
    const result = await api.clearCache();
    output.textContent = `Removed ${result.items_deleted} cached read article(s).`;
  } catch (err) {
    output.textContent = "Failed to clear cache.";
    console.error(err);
  }
}

async function runImportOPML(ev) {
  ev.preventDefault();
  const fileInput = el("import-opml-file");
  const output = el("import-opml-result");
  if (!fileInput.files || fileInput.files.length === 0) return;

  output.textContent = "Importing…";
  try {
    const result = await api.importOPML(fileInput.files[0]);
    output.textContent = `Imported ${result.created} feed(s), ${result.failed} skipped.`;
    await loadGroupsAndFeeds();
    renderSidebar();
  } catch (err) {
    output.textContent = "Import failed: " + err.message;
  }
}

// ---------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------

async function runSearch(query) {
  state.searchQuery = query;
  if (!query) {
    await selectView({ type: "all" });
    return;
  }

  el("list-title").textContent = `Search: "${query}"`;
  try {
    const results = await api.search(query);
    const items = (results && results.items) || [];
    // Search results only carry id/feed_id/title/pub_date; unread state and
    // link are resolved lazily when the article is opened.
    state.items = items.map((r) => ({
      id: r.id,
      feed_id: r.feed_id,
      title: r.title,
      pub_date: r.pub_date,
      unread: false, // unknown until opened; avoid a misleading dot
      feed_name: feedNameFor(r.feed_id),
    }));
    renderArticleList();
  } catch (err) {
    console.error("search failed", err);
  }
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

function wireGlobalEvents() {
  el("smart-views").querySelector('[data-view="all"]').addEventListener("click", (e) => {
    e.preventDefault();
    selectView({ type: "all" });
  });
  el("smart-views").querySelector('[data-view="bookmarks"]').addEventListener("click", (e) => {
    e.preventDefault();
    selectView({ type: "bookmarks" });
  });

  el("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(el("search-input").value.trim());
  });

  el("refresh-all-button").addEventListener("click", async () => {
    try {
      await api.refreshAllFeeds();
      await loadGroupsAndFeeds();
      renderSidebar();
      await loadItemsForCurrentView();
    } catch (err) {
      console.error("refresh all failed", err);
    }
  });

  el("add-feed-button").addEventListener("click", () => el("add-feed-dialog").showModal());
  el("add-feed-cancel").addEventListener("click", () => el("add-feed-dialog").close());
  el("add-feed-form").addEventListener("submit", submitAddFeed);

  el("settings-button").addEventListener("click", () => el("settings-dialog").showModal());
  el("settings-close").addEventListener("click", () => el("settings-dialog").close());
  el("setting-theme").addEventListener("change", saveThemeSetting);
  el("setting-hide-read").addEventListener("change", saveHideReadSetting);
  el("setting-pull-interval").addEventListener("change", savePullIntervalSetting);
  el("clear-cache-button").addEventListener("click", runClearCache);
  el("import-opml-form").addEventListener("submit", runImportOPML);

  el("toolbar-favorite").addEventListener("click", toggleFavorite);
  el("toolbar-open-tab").addEventListener("click", openInNewTab);
  el("toolbar-export-md").addEventListener("click", exportAsMarkdown);
  el("toolbar-more").addEventListener("click", toggleMoreMenu);
  el("more-mark-unread").addEventListener("click", markCurrentUnread);
  el("more-mark-all-read").addEventListener("click", markAllReadInCurrentFeed);

  // Locked keyboard shortcuts (Google Reader-style), not user-remappable.
  document.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;

    switch (e.key) {
      case "j": // next article
        moveSelection(1);
        break;
      case "k": // previous article
        moveSelection(-1);
        break;
      case "m": // toggle read/unread
        if (state.currentItem) markCurrentUnread();
        break;
      case "s": // favorite/star
        if (state.currentItem) toggleFavorite();
        break;
      case "v": // open in new tab
        if (state.currentItem) openInNewTab();
        break;
      case "r": // refresh all
        el("refresh-all-button").click();
        break;
      case "/": // focus search
        e.preventDefault();
        el("search-input").focus();
        break;
      case "Escape":
        el("search-input").blur();
        break;
      default:
        break;
    }
  });
}

function isTypingTarget(target) {
  const tag = (target && target.tagName) || "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target && target.isContentEditable);
}

function moveSelection(delta) {
  const rows = [...document.querySelectorAll(".article-row")];
  if (rows.length === 0) return;
  const currentIndex = rows.findIndex((r) => r.getAttribute("aria-current") === "page");
  let nextIndex = currentIndex + delta;
  nextIndex = Math.max(0, Math.min(rows.length - 1, nextIndex));
  rows[nextIndex].click();
  rows[nextIndex].scrollIntoView({ block: "nearest" });
}

boot();
