package handler

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	htmltomarkdown "github.com/JohannesKaufmann/html-to-markdown/v2"
	"github.com/gin-gonic/gin"
	"github.com/redew/redew/internal/store"
)

// exportItemMarkdown converts a single article's content to a Markdown file
// and streams it as a download. This is one of the four fixed toolbar
// actions ("Export as Markdown"); everything else the toolbar might have
// done lives behind the "More" menu instead.
func (h *Handler) exportItemMarkdown(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		badRequestError(c, "invalid id")
		return
	}

	item, err := h.store.GetItem(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			notFoundError(c, "item")
			return
		}
		internalError(c, err, "get item for markdown export")
		return
	}

	feedName := ""
	if feed, ferr := h.store.GetFeed(item.FeedID); ferr == nil && feed != nil {
		feedName = feed.Name
	}

	body, err := htmltomarkdown.ConvertString(item.Content)
	if err != nil {
		internalError(c, err, "convert item to markdown")
		return
	}

	var out strings.Builder
	out.WriteString("# " + item.Title + "\n\n")
	if feedName != "" {
		out.WriteString("Source: " + feedName + "\n")
	}
	if item.Link != "" {
		out.WriteString("Link: " + item.Link + "\n")
	}
	if item.PubDate > 0 {
		out.WriteString("Date: " + time.Unix(item.PubDate, 0).UTC().Format("2006-01-02") + "\n")
	}
	out.WriteString("\n---\n\n")
	out.WriteString(body)
	out.WriteString("\n")

	filename := fmt.Sprintf("%s.md", slugify(item.Title))
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Data(http.StatusOK, "text/markdown; charset=utf-8", []byte(out.String()))
}

// slugify produces a filesystem-safe, human-readable filename stem from an
// arbitrary article title.
func slugify(title string) string {
	if title == "" {
		return "article"
	}
	runes := []rune(title)
	out := make([]rune, 0, len(runes))
	lastDash := false
	for _, r := range runes {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			out = append(out, r)
			lastDash = false
		case r >= 'A' && r <= 'Z':
			out = append(out, r+('a'-'A'))
			lastDash = false
		case r == ' ' || r == '-' || r == '_':
			if !lastDash && len(out) > 0 {
				out = append(out, '-')
				lastDash = true
			}
		default:
			// Drop punctuation and non-ASCII rather than guessing.
		}
	}
	for len(out) > 0 && out[len(out)-1] == '-' {
		out = out[:len(out)-1]
	}
	if len(out) == 0 {
		return "article"
	}
	if len(out) > 80 {
		out = out[:80]
	}
	return string(out)
}
