package handler

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
)

// Redew is designed to run on localhost only, so CORS is always permissive:
// there is no origin allowlist to configure or test against.
func TestCORSMiddleware(t *testing.T) {
	tests := []struct {
		name            string
		method          string
		origin          string
		wantStatus      int
		wantAllowOrigin string
	}{
		{
			name:            "preflight from any origin is allowed",
			method:          http.MethodOptions,
			origin:          "https://anything.example.com",
			wantStatus:      http.StatusNoContent,
			wantAllowOrigin: "https://anything.example.com",
		},
		{
			name:            "request with an origin header is echoed back",
			method:          http.MethodGet,
			origin:          "http://localhost:5173",
			wantStatus:      http.StatusOK,
			wantAllowOrigin: "http://localhost:5173",
		},
		{
			name:            "request without an origin header still succeeds",
			method:          http.MethodGet,
			origin:          "",
			wantStatus:      http.StatusOK,
			wantAllowOrigin: "*",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &Handler{}

			r := newTestRouter()
			r.Use(h.corsMiddleware())
			r.GET("/api/test", func(c *gin.Context) { c.Status(http.StatusOK) })

			headers := map[string]string{}
			if tt.origin != "" {
				headers["Origin"] = tt.origin
			}
			w := performRequest(r, tt.method, "/api/test", nil, headers)

			if w.Code != tt.wantStatus {
				t.Fatalf("expected status %d, got %d", tt.wantStatus, w.Code)
			}
			if got := w.Header().Get("Access-Control-Allow-Origin"); got != tt.wantAllowOrigin {
				t.Fatalf("expected allow-origin header %q, got %q", tt.wantAllowOrigin, got)
			}
		})
	}
}
