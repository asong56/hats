package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// settingsResponse mirrors the user-editable subset of config.Config.
// Password is deliberately excluded from JSON output (it never round-trips
// back to the client in plaintext once set).
type settingsResponse struct {
	Port              int    `json:"port"`
	DBPath            string `json:"db_path"`
	HasPassword       bool   `json:"has_password"`
	FeverUsername     string `json:"fever_username"`
	PullInterval      int    `json:"pull_interval_seconds"`
	PullTimeout       int    `json:"pull_timeout_seconds"`
	PullConcurrency   int    `json:"pull_concurrency"`
	PullMaxBackoff    int    `json:"pull_max_backoff_seconds"`
	AllowPrivateFeeds bool   `json:"allow_private_feeds"`
	HideRead          bool   `json:"hide_read"`
	Theme             string `json:"theme"`
	ConfigPath        string `json:"config_path"`
}

// getSettings returns the settings the frontend Settings page is allowed to
// show and edit. Everything locked down by product spec (language,
// auto-grouping, unread dots, date format, code theme, toolbar, shortcuts,
// fonts) simply has no field here — there is nothing for the UI to render.
func (h *Handler) getSettings(c *gin.Context) {
	cfg := h.config
	dataResponse(c, settingsResponse{
		Port:              cfg.Port,
		DBPath:            cfg.DBPath,
		HasPassword:       cfg.Password != "",
		FeverUsername:     cfg.FeverUsername,
		PullInterval:      cfg.PullInterval,
		PullTimeout:       cfg.PullTimeout,
		PullConcurrency:   cfg.PullConcurrency,
		PullMaxBackoff:    cfg.PullMaxBackoff,
		AllowPrivateFeeds: cfg.AllowPrivateFeeds,
		HideRead:          cfg.HideRead,
		Theme:             cfg.Theme,
		ConfigPath:        cfg.Path(),
	})
}

// updateSettingsRequest only exposes fields that are safe to change at
// runtime without a restart. Port and DBPath require a restart to take
// effect, so they are intentionally excluded here; edit config.toml and
// restart Redew to change those.
type updateSettingsRequest struct {
	HideRead     *bool   `json:"hide_read"`
	Theme        *string `json:"theme"`
	PullInterval *int    `json:"pull_interval_seconds"`
}

// updateSettings applies changes to the in-memory config and persists them
// to config.toml, so the web Settings UI and the config file never drift
// apart: both read and write through the same struct.
func (h *Handler) updateSettings(c *gin.Context) {
	var req updateSettingsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequestError(c, "invalid request")
		return
	}

	if req.HideRead != nil {
		h.config.HideRead = *req.HideRead
	}
	if req.Theme != nil {
		switch *req.Theme {
		case "light", "dark", "auto":
			h.config.Theme = *req.Theme
		default:
			badRequestError(c, "theme must be light, dark, or auto")
			return
		}
	}
	if req.PullInterval != nil {
		if *req.PullInterval < 60 {
			badRequestError(c, "pull_interval_seconds must be at least 60")
			return
		}
		h.config.PullInterval = *req.PullInterval
	}

	if err := h.config.Save(); err != nil {
		internalError(c, err, "save settings")
		return
	}

	h.getSettings(c)
}

type clearCacheResponse struct {
	ItemsDeleted int64 `json:"items_deleted"`
}

// clearCache deletes read items older than 30 days and reclaims disk space.
// Bookmarked/favorited articles are stored separately and are never touched
// by this.
func (h *Handler) clearCache(c *gin.Context) {
	const olderThanDays = 30

	deleted, err := h.store.ClearReadItemsCache(olderThanDays)
	if err != nil {
		internalError(c, err, "clear cache")
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": clearCacheResponse{ItemsDeleted: deleted}})
}
