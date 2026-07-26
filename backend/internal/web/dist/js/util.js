// util.js — small pure helpers. Two of these encode locked product
// decisions: ISO dates, and domain-based auto-grouping for feeds that
// aren't in a real (non-Default) group.

/**
 * Extracts a human-friendly registrable-ish domain label from a URL, used
 * to auto-group feeds that are still sitting in the "Default" group. Not
 * configurable: this is the fixed fallback used whenever a feed has no
 * explicit group other than Default.
 */
export function domainLabel(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, "");
    return host || "Unsorted";
  } catch {
    return "Unsorted";
  }
}

/**
 * Locked date format: ISO 8601 date only (YYYY-MM-DD), no localization,
 * no relative time. unixSeconds may be 0/undefined for "unknown".
 */
export function formatISODate(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Groups feeds by their real group, except feeds sitting in the Default
 * group (id === 1, or matching name "Default") get bucketed by domain
 * instead. Returns an array of { key, label, feeds } in a stable order:
 * real (non-Default) groups first in their original order, then
 * domain-derived buckets sorted alphabetically.
 */
export function groupFeedsForSidebar(feeds, groups) {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const isDefault = (g) => !g || g.id === 1 || g.name === "Default";

  const realBuckets = new Map(); // groupId -> { label, feeds: [] }
  const domainBuckets = new Map(); // domain -> { label, feeds: [] }

  for (const feed of feeds) {
    const group = groupById.get(feed.group_id);
    if (group && !isDefault(group)) {
      if (!realBuckets.has(group.id)) {
        realBuckets.set(group.id, { key: `group:${group.id}`, label: group.name, feeds: [] });
      }
      realBuckets.get(group.id).feeds.push(feed);
    } else {
      const domain = domainLabel(feed.link || feed.site_url || "");
      if (!domainBuckets.has(domain)) {
        domainBuckets.set(domain, { key: `domain:${domain}`, label: domain, feeds: [] });
      }
      domainBuckets.get(domain).feeds.push(feed);
    }
  }

  const real = [...realBuckets.values()];
  const domains = [...domainBuckets.values()].sort((a, b) => a.label.localeCompare(b.label));

  return [...real, ...domains];
}

export function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
