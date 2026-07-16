package main

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	cfg := loadConfig()
	st, err := openStore(cfg.DataDir)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	if err := st.seedAPISettings(cfg.BaseURL, cfg.APIKey); err != nil {
		log.Fatal(err)
	}

	auth := newAuth(cfg.AuthUsername, cfg.AuthPassword, st)
	px := newProxy(st)
	fsStore, err := newFileStore(cfg.DataDir, st)
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/api/login", auth.handleLogin)
	mux.HandleFunc("/api/logout", auth.handleLogout)
	mux.HandleFunc("/api/me", auth.protect(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	mux.HandleFunc("/api/settings", auth.protect(st.handleSettings))
	mux.HandleFunc("/api/settings/test", auth.protect(st.handleSettingsTest))

	// OpenAI-compatible proxy (key from settings DB)
	mux.HandleFunc("/api/v1/", auth.protect(px.handle))

	// File uploads
	mux.HandleFunc("/api/files", auth.protect(fsStore.handleUpload))
	mux.HandleFunc("/api/files/", auth.protect(fsStore.handleGet))
	mux.HandleFunc("/api/chat", auth.protect(fsStore.handleChat))

	// Conversations CRUD
	mux.HandleFunc("/api/conversations", auth.protect(st.handleConversations))
	mux.HandleFunc("/api/conversations/", auth.protect(st.handleConversation))

	// Static UI
	mux.Handle("/", noCache(http.FileServer(http.FS(staticFS()))))

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           withSecurity(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("litewebui listening on %s", cfg.Listen)
	log.Fatal(srv.ListenAndServe())
}

type config struct {
	Listen       string
	BaseURL      string
	APIKey       string
	AuthUsername string
	AuthPassword string // SHA-256 hex (64) or legacy MD5 hex (32)
	DataDir      string
}

func loadConfig() config {
	// default password hash = SHA-256 of "changeme" — change via AUTH_PASSWORD in production
	const defaultPassSHA256 = "057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86"
	c := config{
		Listen:       env("LISTEN", ":3050"),
		BaseURL:      strings.TrimRight(env("NINEROUTER_BASE_URL", "http://127.0.0.1:20128/v1"), "/"),
		APIKey:       env("NINEROUTER_API_KEY", ""),
		AuthUsername: env("AUTH_USERNAME", "admin"),
		AuthPassword: env("AUTH_PASSWORD", defaultPassSHA256),
		DataDir:      env("DATA_DIR", "./data"),
	}
	if c.APIKey == "" {
		log.Println("info: NINEROUTER_API_KEY empty — set via Settings UI after login")
	}
	h := strings.ToLower(strings.TrimSpace(c.AuthPassword))
	if len(h) != 64 && len(h) != 32 {
		log.Println("warning: AUTH_PASSWORD should be SHA-256 hex (64) or legacy MD5 hex (32)")
	}
	if len(h) == 32 {
		log.Println("warning: AUTH_PASSWORD is MD5 — prefer SHA-256: echo -n 'pass' | sha256sum")
	}
	c.AuthPassword = h
	if c.AuthUsername == "" {
		c.AuthUsername = "admin"
	}
	if !strings.HasPrefix(c.BaseURL, "http://") && !strings.HasPrefix(c.BaseURL, "https://") {
		log.Println("warning: NINEROUTER_BASE_URL should start with http:// or https://")
	}
	return c
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func randToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// process cannot produce secure tokens
		panic("crypto/rand: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func withSecurity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		h.ServeHTTP(w, r)
	})
}