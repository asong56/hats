package handler

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redew/redew/internal/pkg/httpc"
	"github.com/redew/redew/internal/store"
)

// --- OPML XML shapes ---

type opmlDocument struct {
	XMLName xml.Name `xml:"opml"`
	Version string   `xml:"version,attr"`
	Head    opmlHead `xml:"head"`
	Body    opmlBody `xml:"body"`
}

type opmlHead struct {
	Title string `xml:"title"`
}

type opmlBody struct {
	Outlines []opmlOutline `xml:"outline"`
}

type opmlOutline struct {
	Text     string        `xml:"text,attr"`
	Title    string        `xml:"title,attr,omitempty"`
	Type     string        `xml:"type,attr,omitempty"`
	XMLURL   string        `xml:"xmlUrl,attr,omitempty"`
	HTMLURL  string        `xml:"htmlUrl,attr,omitempty"`
	Outlines []opmlOutline `xml:"outline,omitempty"`
}

// exportOPML streams every feed as an OPML 2.0 document, grouped by their
// real group. This is the "one-time export" side of migrating away from
// another reader (or backing Redew's own subscriptions up).
func (h *Handler) exportOPML(c *gin.Context) {
	groups, err := h.store.ListGroups()
	if err != nil {
		internalError(c, err, "list groups for opml export")
		return
	}
	feeds, err := h.store.ListFeeds()
	if err != nil {
		internalError(c, err, "list feeds for opml export")
		return
	}

	feedsByGroup := make(map[int64][]opmlOutline)
	for _, f := range feeds {
		feedsByGroup[f.GroupID] = append(feedsByGroup[f.GroupID], opmlOutline{
			Text:    f.Name,
			Title:   f.Name,
			Type:    "rss",
			XMLURL:  f.Link,
			HTMLURL: f.SiteURL,
		})
	}

	doc := opmlDocument{
		Version: "2.0",
		Head:    opmlHead{Title: "Redew subscriptions"},
	}
	for _, g := range groups {
		outlines := feedsByGroup[g.ID]
		if len(outlines) == 0 {
			continue
		}
		doc.Body.Outlines = append(doc.Body.Outlines, opmlOutline{
			Text:     g.Name,
			Title:    g.Name,
			Outlines: outlines,
		})
	}

	out, err := xml.MarshalIndent(doc, "", "  ")
	if err != nil {
		internalError(c, err, "marshal opml")
		return
	}

	filename := fmt.Sprintf("redew-subscriptions-%s.opml", time.Now().Format("2006-01-02"))
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Data(http.StatusOK, "text/x-opml; charset=utf-8", append([]byte(xml.Header), out...))
}

type opmlImportResponse struct {
	Created int      `json:"created"`
	Failed  int      `json:"failed"`
	Errors  []string `json:"errors"`
}

// importOPML accepts a multipart form upload (field name "file") containing
// an OPML document, and creates any groups/feeds it doesn't already have.
// This is the intended one-time migration path: export once from your old
// reader (e.g. Folo), import here, and Redew runs independently from then on.
func (h *Handler) importOPML(c *gin.Context) {
	file, _, err := c.Request.FormFile("file")
	if err != nil {
		badRequestError(c, "missing OPML file (field name: file)")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, 20<<20)) // 20 MiB is generous for OPML
	if err != nil {
		badRequestError(c, "failed to read uploaded file")
		return
	}

	var doc opmlDocument
	if err := xml.Unmarshal(data, &doc); err != nil {
		badRequestError(c, "invalid OPML file")
		return
	}

	existingGroups, err := h.store.ListGroups()
	if err != nil {
		internalError(c, err, "list groups for opml import")
		return
	}
	groupIDByName := make(map[string]int64, len(existingGroups))
	for _, g := range existingGroups {
		groupIDByName[strings.ToLower(strings.TrimSpace(g.Name))] = g.ID
	}

	var inputs []store.BatchCreateFeedsInput
	var walk func(outlines []opmlOutline, groupID int64)
	walk = func(outlines []opmlOutline, groupID int64) {
		for _, o := range outlines {
			if o.XMLURL != "" {
				// A leaf feed outline. If it has nested outlines too (some
				// exporters do this), we still treat it as a feed first.
				name := o.Title
				if name == "" {
					name = o.Text
				}
				inputs = append(inputs, store.BatchCreateFeedsInput{
					GroupID: groupID,
					Name:    name,
					Link:    o.XMLURL,
					SiteURL: o.HTMLURL,
				})
				continue
			}

			// A folder outline: resolve or create its group, then recurse.
			name := o.Title
			if name == "" {
				name = o.Text
			}
			key := strings.ToLower(strings.TrimSpace(name))
			gid, ok := groupIDByName[key]
			if !ok {
				g, err := h.store.CreateGroup(name)
				if err != nil {
					slog.Warn("opml import: failed to create group", "name", name, "error", err)
					gid = groupID // fall back to parent group
				} else {
					gid = g.ID
					groupIDByName[key] = gid
				}
			}
			walk(o.Outlines, gid)
		}
	}
	walk(doc.Body.Outlines, 1) // 1 = Default group for top-level feeds with no folder

	resp := opmlImportResponse{}
	var validInputs []store.BatchCreateFeedsInput
	for _, in := range inputs {
		if err := httpc.ValidateRequestURL(c.Request.Context(), in.Link, h.config.AllowPrivateFeeds); err != nil {
			resp.Errors = append(resp.Errors, fmt.Sprintf("invalid link skipped: %s", in.Link))
			continue
		}
		validInputs = append(validInputs, in)
	}

	if len(validInputs) > 0 {
		result, err := h.store.BatchCreateFeeds(validInputs)
		if err != nil {
			internalError(c, err, "batch create feeds from opml")
			return
		}
		resp.Created = result.Created
		resp.Errors = append(resp.Errors, result.Errors...)

		refreshTimeout := time.Duration(h.config.PullTimeout) * time.Second
		for _, id := range result.CreatedIDs {
			go func(feedID int64) {
				ctx, cancel := context.WithTimeout(context.Background(), refreshTimeout)
				defer cancel()
				if err := h.puller.RefreshFeed(ctx, feedID); err != nil {
					slog.Warn("initial feed pull failed after opml import", "feed_id", feedID, "error", err)
				}
			}(id)
		}
	}
	resp.Failed = len(resp.Errors)

	dataResponse(c, resp)
}
