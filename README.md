# Redew

A local-first RSS reader for one person, one computer.

Redew exists because two good RSS readers each had exactly one problem:
[Fusion](https://github.com/0x2E/fusion) is small, fast, and self-hosted,
but rough around the edges; [Folo](https://github.com/RSSNext/Folo) has a
much nicer interface and more features, but is built around Folo's own
cloud account system, AI features, and multi-platform sync — none of which
you want if all you need is `localhost` and a `feed.opml`.

Redew takes Fusion's backend (Go + SQLite, single static binary, no
account system, no cloud dependency) and gives it a fresh, hand-built
frontend inspired by Folo's look — with a very deliberately *small* feature
set. It runs as one process on your own machine. There is no sync, no
login (by default), and no telemetry.

## What's here, and what deliberately isn't

**Kept / added:**
- Feeds, groups, bookmarks (favorites), full-text search, unread tracking
- Fever API compatibility (so you can point Reeder, Unread, or similar
  mobile clients at your own Redew instance if you want)
- OPML import (one-time migration from Folo, Feedly, or anywhere else) and
  OPML export
- Export a single article as a clean Markdown file
- A small set of runtime settings (below), editable from a `config.toml`
  file or from the Settings dialog in the app — both write to the same
  file, so they never drift apart
- A soft, weak accent gradient that drifts with the local time of day
  (cool at night, warm at midday) — the one new visual idea this project
  adds on top of Fusion and Folo

**Deliberately not here** (these are things Folo does, but they only make
sense as part of Folo's own hosted product, not a local single-user
reader):
- No AI summarization, translation, or chat
- No account system, no cloud sync, no "your Folo subscriptions" login
- No community feed discovery, trending, wallet/points, or paid plans
- No rich media feeds (image walls, video/podcast cards) — just articles

## Locked-down design decisions

A number of settings are **intentionally not configurable** anywhere —
not in `config.toml`, not in the Settings dialog. This is a deliberate
product decision, not an oversight:

| Locked to | Notes |
|---|---|
| English-only UI | No language switcher |
| Auto-grouping by domain | Feeds with no explicit group are bucketed by their site's domain in the sidebar, instead of sitting in an unsorted pile |
| Dimmed (not hidden) read articles | Unless you turn on "Hide read articles" in Settings |
| Unread count shown as a small dot | Never a number |
| Date format | Always ISO 8601 (`YYYY-MM-DD`) |
| Font stack | `-apple-system` (SF Pro) → Segoe UI → Open Sans → sans-serif. No other fonts, no custom font settings |
| Body line height | Normal (`1.5`), not a "reader mode" override |
| Code block theme | [Catppuccin](https://github.com/catppuccin/catppuccin) Latte (light) / Mocha (dark), matched to your light/dark theme |
| Toolbar | Exactly four actions: **Favorite**, **Open in new tab**, **Export as Markdown**, **More**. Everything else (mark unread, mark all read, etc.) lives behind "More" |
| Keyboard shortcuts | Fixed Google-Reader-style bindings (`j`/`k` to move, `s` to favorite, `v` to open, `m` to toggle unread, `r` to refresh, `/` to search) — not remappable |

## Settings you *can* change

Everything else lives in `config.toml`, next to the `redew` binary (create
one automatically on first run), and is mirrored in the in-app Settings
dialog:

```toml
# --- Server ---
port = 8080
db_path = "redew.db"

# Leave empty for no login (recommended for pure localhost use).
password = ""

fever_username = "redew"

# --- Feed pulling / automation ---
pull_interval_seconds = 1800
pull_timeout_seconds = 30
pull_concurrency = 10
pull_max_backoff_seconds = 172800
allow_private_feeds = true

# --- Reading experience ---
hide_read = false
theme = "auto"   # "light", "dark", or "auto"

# --- Logging ---
log_level = "INFO"
log_format = "auto"
```

Changing `port` or `db_path` requires a restart. Everything else takes
effect immediately, whether you edit the file or use the Settings dialog.

## Getting started

1. Download the release for your platform from the
   [Releases page](../../releases) and unzip it.
2. (Optional) Put a `feed.opml` exported from your old reader in the same
   folder — you can also just import it from the Settings dialog after
   starting Redew.
3. Run the binary:
   - **macOS / Linux**: `./redew` (you may need to allow it in
     System Settings → Privacy & Security the first time, on macOS)
   - **Windows**: double-click `redew.exe`, or run it from a terminal
4. Open `http://localhost:8080` in your browser.
5. First run creates a `config.toml` next to the binary — edit it, or use
   the in-app Settings dialog, to adjust automation/theme/etc.
6. If you have an OPML file from another reader, use Settings → Import
   OPML to bring your subscriptions over. This is a one-time migration:
   Redew doesn't keep talking to your old reader's account afterward.

## Building from source

Requires Go 1.25+.

```sh
git clone <this-repo>
cd redew
./scripts.sh build        # runs backend tests, builds for your host platform
./scripts.sh release       # cross-builds zips + checksums for all platforms into ./dist
```

There is no frontend build step: the entire UI is plain HTML/CSS/JS
sitting in `backend/internal/web/dist`, embedded directly into the Go
binary at compile time. No React, no bundler, no `node_modules`.

## Architecture

- **Backend**: Go, `gin` for routing, `modernc.org/sqlite` (pure Go, no
  cgo — this is what makes cross-compiling for all three platforms from
  one CI matrix straightforward) for storage.
- **Frontend**: vanilla ES modules, semantic HTML (`<nav>`, `<main>`,
  `<article>`, `<search>`, `<menu>`, native `<dialog>` and Popover API) —
  no framework, no build step, and no `<div>` anywhere in the markup.
- **Fever API** endpoint at `/fever` for third-party client compatibility.

## License

Redew's backend is derived from [0x2E/fusion](https://github.com/0x2E/fusion).
Check that project's own license terms before redistributing this code;
this repository does not bundle a LICENSE file by request.
