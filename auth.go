package main

import (
	"crypto/md5"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type auth struct {
	username string
	password string // SHA-256 hex (64) preferred; MD5 hex (32) still accepted
	st       *store
}

func newAuth(username, password string, st *store) *auth {
	if username == "" {
		username = "admin"
	}
	a := &auth{username: username, password: password, st: st}
	go a.gc()
	return a
}

func (a *auth) gc() {
	t := time.NewTicker(30 * time.Minute)
	for range t.C {
		_ = a.st.purgeExpiredSessions()
	}
}

func (a *auth) valid(r *http.Request) bool {
	c, err := r.Cookie("litewebui_session")
	if err != nil || c.Value == "" {
		return false
	}
	ok, err := a.st.sessionValid(c.Value)
	return err == nil && ok
}

func (a *auth) protect(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.valid(r) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

func (a *auth) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json")
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	if !strEQ(body.Username, a.username) || !passwordOK(body.Password, a.password) {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	tok := randToken(24)
	exp := time.Now().Add(30 * 24 * time.Hour)
	if err := a.st.createSession(tok, exp); err != nil {
		writeErr(w, http.StatusInternalServerError, "session")
		return
	}
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name:     "litewebui_session",
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   30 * 24 * 3600,
	})
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (a *auth) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("litewebui_session"); err == nil {
		_ = a.st.deleteSession(c.Value)
	}
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name:     "litewebui_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func strEQ(got, want string) bool {
	gb, wb := []byte(got), []byte(want)
	if len(gb) != len(wb) {
		subtle.ConstantTimeCompare(wb, wb)
		return false
	}
	return subtle.ConstantTimeCompare(gb, wb) == 1
}

// passwordOK: AUTH_PASSWORD is SHA-256 hex (64) preferred, or legacy MD5 hex (32).
func passwordOK(got, wantHash string) bool {
	want := strings.ToLower(strings.TrimSpace(wantHash))
	switch len(want) {
	case 64:
		if !isHexN(want, 64) {
			return false
		}
		sum := sha256.Sum256([]byte(got))
		gotHex := strings.ToLower(hex.EncodeToString(sum[:]))
		return subtle.ConstantTimeCompare([]byte(gotHex), []byte(want)) == 1
	case 32:
		if !isHexN(want, 32) {
			return false
		}
		sum := md5.Sum([]byte(got))
		gotHex := strings.ToLower(hex.EncodeToString(sum[:]))
		return subtle.ConstantTimeCompare([]byte(gotHex), []byte(want)) == 1
	default:
		return false
	}
}

func isHexN(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for i := 0; i < n; i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, `{"error":`+jsonString(msg)+`}`)
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
