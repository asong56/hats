package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadCreatesDefaultConfigWhenMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() failed: %v", err)
	}

	if cfg.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Port)
	}
	if cfg.Theme != "auto" {
		t.Errorf("expected default theme auto, got %q", cfg.Theme)
	}
	if !cfg.AllowPrivateFeeds {
		t.Errorf("expected AllowPrivateFeeds default true for local-first use")
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected config.toml to be written on first load: %v", err)
	}
}

func TestLoadParsesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	content := `
port = 9090
db_path = "custom.db"
theme = "dark"
hide_read = true
pull_interval_seconds = 600
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("failed to write test config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() failed: %v", err)
	}

	if cfg.Port != 9090 {
		t.Errorf("expected port 9090, got %d", cfg.Port)
	}
	if cfg.DBPath != "custom.db" {
		t.Errorf("expected db_path custom.db, got %q", cfg.DBPath)
	}
	if cfg.Theme != "dark" {
		t.Errorf("expected theme dark, got %q", cfg.Theme)
	}
	if !cfg.HideRead {
		t.Errorf("expected hide_read true")
	}
	if cfg.PullInterval != 600 {
		t.Errorf("expected pull_interval_seconds 600, got %d", cfg.PullInterval)
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	if err := os.WriteFile(path, []byte("port = 0\n"), 0o600); err != nil {
		t.Fatalf("failed to write test config: %v", err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("expected Load() to reject port = 0")
	}
}

func TestSaveRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() failed: %v", err)
	}

	cfg.HideRead = true
	cfg.Theme = "light"
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save() failed: %v", err)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("reload after Save() failed: %v", err)
	}
	if !reloaded.HideRead {
		t.Errorf("expected hide_read to persist as true")
	}
	if reloaded.Theme != "light" {
		t.Errorf("expected theme to persist as light, got %q", reloaded.Theme)
	}
}

func TestDefaultPathFallsBackToCurrentDirName(t *testing.T) {
	p := DefaultPath()
	if !strings.HasSuffix(p, "config.toml") {
		t.Errorf("expected DefaultPath() to end with config.toml, got %q", p)
	}
}

func TestSettingsJSONNeverIncludesPassword(t *testing.T) {
	cfg := Defaults()
	cfg.Password = "super-secret"

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	if strings.Contains(string(data), "super-secret") {
		t.Fatal("password leaked into JSON encoding of Config")
	}
}
