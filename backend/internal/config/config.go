// Package config loads Redew's configuration from a single config.toml file
// that lives next to the binary (or database). Redew is designed to run as a
// single local process on localhost, so there is no OIDC, no CORS allowlist,
// and no multi-user session complexity: just a small set of knobs that a
// human can read and hand-edit.
//
// Everything that the product spec locks down (English-only UI, forced
// domain grouping, dimmed read items, the font stack, line height, unread
// dots instead of counts, ISO dates, the Catppuccin code themes, and the
// fixed 4-button toolbar) intentionally has NO config field here. Locked
// behavior lives in code/frontend constants, not in user-editable config.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// Config is the full set of user-editable settings for Redew.
// Every field here is safe to expose in the web Settings UI.
type Config struct {
	// -- Server --
	Port   int    `toml:"port" json:"port"`
	DBPath string `toml:"db_path" json:"db_path"`

	// Password is optional. Empty means "no login" (fine for a pure
	// localhost-only setup). Set it if you expose Redew beyond localhost.
	Password string `toml:"password" json:"-"`

	// FeverUsername is used to derive the Fever API key for third-party
	// clients (Reeder, Unread, FeedMe, etc.).
	FeverUsername string `toml:"fever_username" json:"fever_username"`

	// -- Feed pulling / automation --
	PullInterval    int `toml:"pull_interval_seconds" json:"pull_interval_seconds"`
	PullTimeout     int `toml:"pull_timeout_seconds" json:"pull_timeout_seconds"`
	PullConcurrency int `toml:"pull_concurrency" json:"pull_concurrency"`
	PullMaxBackoff  int `toml:"pull_max_backoff_seconds" json:"pull_max_backoff_seconds"`

	AllowPrivateFeeds bool `toml:"allow_private_feeds" json:"allow_private_feeds"`

	// -- Reading experience (user-editable) --
	// HideRead hides read items from the article list entirely instead of
	// just dimming them.
	HideRead bool `toml:"hide_read" json:"hide_read"`

	// Theme is "light", "dark", or "auto" (follow system).
	Theme string `toml:"theme" json:"theme"`

	// -- Logging --
	LogLevel  string `toml:"log_level" json:"log_level"`
	LogFormat string `toml:"log_format" json:"log_format"`

	// path is the resolved location of the config.toml file this Config was
	// loaded from (or will be saved to). Not serialized.
	path string `toml:"-" json:"-"`
}

// Defaults returns a Config populated with sensible defaults.
func Defaults() *Config {
	return &Config{
		Port:              8080,
		DBPath:            "redew.db",
		Password:          "",
		FeverUsername:     "redew",
		PullInterval:      1800,
		PullTimeout:       30,
		PullConcurrency:   10,
		PullMaxBackoff:    172800,
		AllowPrivateFeeds: true, // default true: this is a local-first single-user tool
		HideRead:          false,
		Theme:             "auto",
		LogLevel:          "INFO",
		LogFormat:         "auto",
	}
}

// DefaultPath returns the config.toml path next to the executable, falling
// back to the current working directory if the executable path can't be
// resolved. This is what makes "put a config.toml in the same folder as the
// binary" work.
func DefaultPath() string {
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		dir := filepath.Dir(exe)
		if dir != "" && dir != "." {
			return filepath.Join(dir, "config.toml")
		}
	}
	return "config.toml"
}

// Load reads config.toml from path. If the file does not exist, it writes a
// fresh one populated with defaults (with comments) and returns those
// defaults, so a first run always produces a config.toml a user can find and
// edit next to a feed.opml.
func Load(path string) (*Config, error) {
	if strings.TrimSpace(path) == "" {
		path = DefaultPath()
	}

	cfg := Defaults()
	cfg.path = path

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			if writeErr := cfg.Save(); writeErr != nil {
				return nil, fmt.Errorf("write default config: %w", writeErr)
			}
			return cfg, nil
		}
		return nil, fmt.Errorf("read config: %w", err)
	}

	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config.toml: %w", err)
	}
	cfg.path = path

	if err := cfg.normalize(); err != nil {
		return nil, err
	}

	return cfg, nil
}

func (c *Config) normalize() error {
	if c.Port <= 0 || c.Port > 65535 {
		return fmt.Errorf("invalid port: must be in range 1-65535")
	}
	if strings.TrimSpace(c.DBPath) == "" {
		c.DBPath = "redew.db"
	}
	if strings.TrimSpace(c.FeverUsername) == "" {
		c.FeverUsername = "redew"
	}
	if c.PullInterval <= 0 {
		c.PullInterval = 1800
	}
	if c.PullTimeout <= 0 {
		c.PullTimeout = 30
	}
	if c.PullConcurrency <= 0 {
		c.PullConcurrency = 10
	}
	if c.PullMaxBackoff <= 0 {
		c.PullMaxBackoff = 172800
	}
	switch c.Theme {
	case "light", "dark", "auto":
	default:
		c.Theme = "auto"
	}
	if strings.TrimSpace(c.LogLevel) == "" {
		c.LogLevel = "INFO"
	}
	if strings.TrimSpace(c.LogFormat) == "" {
		c.LogFormat = "auto"
	}
	return nil
}

// Save writes the current config back to its file (pretty, hand-editable
// TOML with section comments). Both the config.toml file and the web
// Settings UI write through this single function, so they can never drift.
func (c *Config) Save() error {
	path := c.path
	if strings.TrimSpace(path) == "" {
		path = DefaultPath()
		c.path = path
	}

	body := c.render()

	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create config directory: %w", err)
		}
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("finalize config: %w", err)
	}
	return nil
}

// Path returns the file this config was loaded from / saves to.
func (c *Config) Path() string {
	return c.path
}

func (c *Config) render() []byte {
	const tmpl = `# Redew configuration.
# Edit this file directly, or use the in-app Settings page (Settings changes
# are written back here). Put this file in the same directory as the redew
# binary, next to your feed.opml.
#
# Anything NOT listed here (language, auto-grouping, unread dots, date
# format, code theme, toolbar, shortcuts, font stack) is intentionally fixed
# and is not configurable, by design.

# --- Server ---
port = %d
db_path = %q

# Leave empty for no login (recommended for pure localhost use).
# Set a password if you expose Redew beyond localhost.
password = %q

# Username Fever-compatible clients (Reeder, Unread, FeedMe...) use to derive
# their API key.
fever_username = %q

# --- Feed pulling / automation ---
pull_interval_seconds = %d
pull_timeout_seconds = %d
pull_concurrency = %d
pull_max_backoff_seconds = %d
allow_private_feeds = %t

# --- Reading experience ---
# Hide read items entirely instead of dimming them.
hide_read = %t

# "light", "dark", or "auto" (follow the system).
theme = %q

# --- Logging ---
log_level = %q
log_format = %q
`
	return []byte(fmt.Sprintf(tmpl,
		c.Port,
		c.DBPath,
		c.Password,
		c.FeverUsername,
		c.PullInterval,
		c.PullTimeout,
		c.PullConcurrency,
		c.PullMaxBackoff,
		c.AllowPrivateFeeds,
		c.HideRead,
		c.Theme,
		c.LogLevel,
		c.LogFormat,
	))
}
