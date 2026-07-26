package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/redew/redew/internal/auth"
	"github.com/redew/redew/internal/config"
	"github.com/redew/redew/internal/store"
)

type Handler struct {
	store        *store.Store
	config       *config.Config
	passwordHash string // bcrypt hash computed at startup
	feverAPIKey  string // md5(username:password) used by Fever API
	allowAnonAPI bool   // true when no password is set (default for pure localhost use)
	puller       interface {
		RefreshFeed(ctx context.Context, feedID int64) error
		RefreshAll(ctx context.Context) (int, error)
	}
	sessions  map[string]int64 // sessionID -> unix expiry seconds
	mu        sync.RWMutex     // protects sessions state
	limiter   *loginLimiter
	lastSweep int64

	refreshAllMu      sync.Mutex
	refreshAllRunning bool
}

func New(store *store.Store, config *config.Config, puller interface {
	RefreshFeed(ctx context.Context, feedID int64) error
	RefreshAll(ctx context.Context) (int, error)
}) (*Handler, error) {
	// Hash password at startup for later verification
	passwordHash, err := auth.HashPassword(config.Password)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}

	h := &Handler{
		store:        store,
		config:       config,
		passwordHash: passwordHash,
		feverAPIKey:  deriveFeverAPIKey(config.FeverUsername, config.Password),
		allowAnonAPI: strings.TrimSpace(config.Password) == "",
		puller:       puller,
		sessions:     make(map[string]int64),
		// Login rate limiting only matters when a password is set; use fixed
		// sane defaults since this is no longer user-configurable.
		limiter: newLoginLimiter(10, 60, 300),
	}

	if h.allowAnonAPI {
		slog.Info("no password set: running without login (fine for pure localhost use)")
	}

	return h, nil
}

func (h *Handler) SetupRouter() *gin.Engine {
	r := gin.New()
	r.Use(requestLogMiddleware(), recoveryMiddleware())

	// Redew is designed to run on localhost only, so there is no trusted
	// proxy configuration and CORS is always permissive.
	if err := r.SetTrustedProxies(nil); err != nil {
		slog.Warn("failed to configure trusted proxies", "error", err)
	}

	r.Use(h.corsMiddleware())
	r.POST("/fever", h.fever)
	r.POST("/fever/", h.fever)
	r.POST("/fever.php", h.fever)

	api := r.Group("/api")
	{
		api.POST("/sessions", h.login)
		api.DELETE("/sessions", h.logout)

		auth := api.Group("")
		auth.Use(h.authMiddleware())
		{
			auth.GET("/groups", h.listGroups)
			auth.POST("/groups", h.createGroup)
			auth.GET("/groups/:id", h.getGroup)
			auth.PATCH("/groups/:id", h.updateGroup)
			auth.DELETE("/groups/:id", h.deleteGroup)

			auth.GET("/feeds", h.listFeeds)
			auth.POST("/feeds", h.createFeed)
			auth.POST("/feeds/batch", h.batchCreateFeeds)
			auth.POST("/feeds/refresh", h.refreshAllFeeds)
			auth.GET("/feeds/:id", h.getFeed)
			auth.PATCH("/feeds/:id", h.updateFeed)
			auth.DELETE("/feeds/:id", h.deleteFeed)
			auth.POST("/feeds/validate", h.validateFeed)
			auth.POST("/feeds/:id/refresh", h.refreshFeed)

			auth.GET("/items", h.listItems)
			auth.GET("/items/:id", h.getItem)
			auth.PATCH("/items/-/read", h.markItemsRead)
			auth.PATCH("/items/-/unread", h.markItemsUnread)
			auth.GET("/items/:id/markdown", h.exportItemMarkdown)

			auth.GET("/search", h.search)

			auth.GET("/bookmarks", h.listBookmarks)
			auth.POST("/bookmarks", h.createBookmark)
			auth.GET("/bookmarks/:id", h.getBookmark)
			auth.DELETE("/bookmarks/:id", h.deleteBookmark)

			auth.GET("/opml/export", h.exportOPML)
			auth.POST("/opml/import", h.importOPML)

			auth.GET("/settings", h.getSettings)
			auth.PATCH("/settings", h.updateSettings)
			auth.POST("/cache/clear", h.clearCache)
		}
	}

	if err := h.setupFrontendRoutes(r); err != nil {
		slog.Warn("failed to configure frontend routes", "error", err)
	}

	return r
}

func (h *Handler) corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := strings.TrimSpace(c.Request.Header.Get("Origin"))
		if origin != "" {
			c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
			c.Writer.Header().Set("Vary", "Origin")
			c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		} else {
			c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		}
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, PATCH, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}

func (h *Handler) authMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if h.allowAnonAPI {
			c.Next()
			return
		}

		sessionID, err := c.Cookie("session")
		if err != nil {
			unauthorizedError(c)
			c.Abort()
			return
		}

		if !h.isSessionValid(sessionID) {
			unauthorizedError(c)
			c.Abort()
			return
		}

		c.Next()
	}
}

func dataResponse(c *gin.Context, data any) {
	c.JSON(200, gin.H{"data": data})
}

func listResponse(c *gin.Context, data any, total int) {
	c.JSON(200, gin.H{"data": data, "total": total})
}

// paginatedListResponse emits a list payload with a cursor-based next_cursor.
// nextCursor is non-nil only when more pages may exist; nil means "no more".
func paginatedListResponse(c *gin.Context, data any, total int, nextCursor *string) {
	c.JSON(200, gin.H{"data": data, "total": total, "next_cursor": nextCursor})
}

// parseCursor decodes a "<value>_<id>" cursor into its two int64 components.
// Shared by list endpoints that paginate on a composite (timestamp, id) key.
func parseCursor(cursor string) (first int64, second int64, err error) {
	parts := strings.SplitN(cursor, "_", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("malformed cursor")
	}
	first, err = strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("malformed cursor")
	}
	second, err = strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("malformed cursor")
	}
	return first, second, nil
}
