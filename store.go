package main

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type store struct {
	db      *sql.DB
	dataDir string
}

func openStore(dir string) (*store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	// modernc: one pragma per _pragma; enable FK for CASCADE
	dsn := filepath.Join(dir, "litewebui.db") +
		"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite-safe
	s := &store{db: db, dataDir: dir}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *store) Close() error { return s.db.Close() }

func (s *store) migrate() error {
	// modernc/database-sql: multi-statement Exec is unreliable — one at a time
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
		`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
)`,
		`CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`,
		`CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`,
		`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return err
		}
	}
	// optional columns for existing DBs
	_, _ = s.db.Exec(`ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`)
	_, _ = s.db.Exec(`ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`)
	_, _ = s.db.Exec(`ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
	_, _ = s.db.Exec(`ALTER TABLE conversations ADD COLUMN private INTEGER NOT NULL DEFAULT 0`)
	return nil
}

// Seed API settings only if missing (env/defaults as first-run bootstrap).
func (s *store) seedAPISettings(baseURL, apiKey string) error {
	if err := s.ensureSetting("api_base_url", strings.TrimRight(baseURL, "/")); err != nil {
		return err
	}
	return s.ensureSetting("api_key", apiKey)
}

func (s *store) ensureSetting(key, def string) error {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		_, err = s.db.Exec(`INSERT INTO settings(key,value) VALUES(?,?)`, key, def)
		return err
	}
	return err
}

func (s *store) getSetting(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

func (s *store) setSetting(key, value string) error {
	_, err := s.db.Exec(
		`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		key, value,
	)
	return err
}

func (s *store) apiConfig() (baseURL, apiKey string, err error) {
	baseURL, err = s.getSetting("api_base_url")
	if err != nil {
		return "", "", err
	}
	apiKey, err = s.getSetting("api_key")
	if err != nil {
		return "", "", err
	}
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	return baseURL, apiKey, nil
}

func (s *store) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		base, key, err := s.apiConfig()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		masked := ""
		if key != "" {
			if len(key) <= 8 {
				masked = "••••••••"
			} else {
				masked = key[:4] + "••••" + key[len(key)-4:]
			}
		}
		writeJSON(w, map[string]any{
			"api_base_url":   base,
			"api_key_set":    key != "",
			"api_key_masked": masked,
		})
	case http.MethodPut:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var in struct {
			APIBaseURL string `json:"api_base_url"`
			APIKey     string `json:"api_key"` // empty = keep existing
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "bad json", 400)
			return
		}
		base := strings.TrimRight(strings.TrimSpace(in.APIBaseURL), "/")
		if base == "" {
			http.Error(w, "api_base_url required", 400)
			return
		}
		if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
			http.Error(w, "api_base_url must be http(s)", 400)
			return
		}
		if err := s.setSetting("api_base_url", base); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if strings.TrimSpace(in.APIKey) != "" {
			if err := s.setSetting("api_key", strings.TrimSpace(in.APIKey)); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

// POST /api/settings/test — probe {base}/models with optional draft credentials from form.
func (s *store) handleSettingsTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var in struct {
		APIBaseURL string `json:"api_base_url"`
		APIKey     string `json:"api_key"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)

	base, key, err := s.apiConfig()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if b := strings.TrimRight(strings.TrimSpace(in.APIBaseURL), "/"); b != "" {
		base = b
	}
	if k := strings.TrimSpace(in.APIKey); k != "" {
		key = k
	}
	if base == "" {
		writeJSONStatus(w, 400, map[string]any{"ok": false, "error": "api_base_url kosong"})
		return
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		writeJSONStatus(w, 400, map[string]any{"ok": false, "error": "api_base_url must be http(s)"})
		return
	}

	cli := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, base+"/models", nil)
	if err != nil {
		writeJSONStatus(w, 502, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	req.Header.Set("Accept", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := cli.Do(req)
	if err != nil {
		writeJSONStatus(w, 502, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(body))
		if len(msg) > 200 {
			msg = msg[:200] + "…"
		}
		if msg == "" {
			msg = resp.Status
		}
		writeJSONStatus(w, 200, map[string]any{
			"ok":     false,
			"status": resp.StatusCode,
			"error":  msg,
		})
		return
	}

	var parsed struct {
		Data []json.RawMessage `json:"data"`
	}
	n := 0
	if json.Unmarshal(body, &parsed) == nil {
		n = len(parsed.Data)
	}
	writeJSON(w, map[string]any{"ok": true, "status": resp.StatusCode, "models": n})
}

func writeJSONStatus(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

type conversation struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Model     string    `json:"model"`
	Pinned    bool      `json:"pinned"`
	Archived  bool      `json:"archived"`
	Private   bool      `json:"private"`
	CreatedAt int64     `json:"created_at"`
	UpdatedAt int64     `json:"updated_at"`
	Messages  []message `json:"messages,omitempty"`
}

type message struct {
	ID             string       `json:"id"`
	ConversationID string       `json:"conversation_id,omitempty"`
	Role           string       `json:"role"`
	Content        string       `json:"content"`
	Attachments    []attachment `json:"attachments,omitempty"`
	CreatedAt      int64        `json:"created_at"`
}

type fileMeta struct {
	ID          string
	Name        string
	ContentType string
	Size        int64
	CreatedAt   int64
}

func (s *store) insertFileMeta(id, name, contentType string, size int64) error {
	_, err := s.db.Exec(
		`INSERT INTO files(id,name,content_type,size,created_at) VALUES(?,?,?,?,?)`,
		id, name, contentType, size, time.Now().UnixMilli(),
	)
	return err
}

func (s *store) getFileMeta(id string) (*fileMeta, error) {
	var m fileMeta
	err := s.db.QueryRow(
		`SELECT id, name, content_type, size, created_at FROM files WHERE id=?`, id,
	).Scan(&m.ID, &m.Name, &m.ContentType, &m.Size, &m.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *store) createSession(token string, exp time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO sessions(token, expires_at) VALUES(?,?)`,
		token, exp.UnixMilli(),
	)
	return err
}

func (s *store) sessionValid(token string) (bool, error) {
	var exp int64
	err := s.db.QueryRow(`SELECT expires_at FROM sessions WHERE token=?`, token).Scan(&exp)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if time.Now().UnixMilli() >= exp {
		_, _ = s.db.Exec(`DELETE FROM sessions WHERE token=?`, token)
		return false, nil
	}
	return true, nil
}

func (s *store) deleteSession(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token=?`, token)
	return err
}

func (s *store) purgeExpiredSessions() error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at < ?`, time.Now().UnixMilli())
	return err
}

func (s *store) fileIDsForConversation(convID string) []string {
	rows, err := s.db.Query(`SELECT COALESCE(attachments,'[]') FROM messages WHERE conversation_id=?`, convID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	seen := map[string]struct{}{}
	var out []string
	for rows.Next() {
		var attRaw string
		if err := rows.Scan(&attRaw); err != nil {
			continue
		}
		var atts []attachment
		if json.Unmarshal([]byte(attRaw), &atts) != nil {
			continue
		}
		for _, a := range atts {
			if a.ID == "" {
				continue
			}
			if _, ok := seen[a.ID]; ok {
				continue
			}
			seen[a.ID] = struct{}{}
			out = append(out, a.ID)
		}
	}
	return out
}

// deleteFiles removes blobs under dataDir/uploads and file meta rows.
func (s *store) deleteFiles(ids []string) {
	up := filepath.Join(s.dataDir, "uploads")
	for _, id := range ids {
		if !isFileID(id) {
			continue
		}
		_ = os.Remove(filepath.Join(up, id))
		_, _ = s.db.Exec(`DELETE FROM files WHERE id=?`, id)
	}
}

func (s *store) handleConversations(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		// ?archived=1 → only archived; default = not archived
		showArchived := r.URL.Query().Get("archived") == "1"
		arch := 0
		if showArchived {
			arch = 1
		}
		rows, err := s.db.Query(
			`SELECT id, title, model, created_at, updated_at,
			        COALESCE(pinned,0), COALESCE(archived,0), COALESCE(private,0)
			 FROM conversations
			 WHERE COALESCE(archived,0)=? AND COALESCE(private,0)=0
			 ORDER BY COALESCE(pinned,0) DESC, updated_at DESC
			 LIMIT 200`,
			arch,
		)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer rows.Close()
		list := []conversation{}
		for rows.Next() {
			var c conversation
			var pin, ar, priv int
			if err := rows.Scan(&c.ID, &c.Title, &c.Model, &c.CreatedAt, &c.UpdatedAt, &pin, &ar, &priv); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			c.Pinned = pin != 0
			c.Archived = ar != 0
			c.Private = priv != 0
			list = append(list, c)
		}
		writeJSON(w, list)
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var in struct {
			Title   string `json:"title"`
			Model   string `json:"model"`
			Private bool   `json:"private"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in.Title == "" {
			if in.Private {
				in.Title = "Private chat"
			} else {
				in.Title = "New chat"
			}
		}
		now := time.Now().UnixMilli()
		id := randToken(12)
		priv := 0
		if in.Private {
			priv = 1
		}
		_, err := s.db.Exec(
			`INSERT INTO conversations(id,title,model,created_at,updated_at,pinned,archived,private) VALUES(?,?,?,?,?,0,0,?)`,
			id, in.Title, in.Model, now, now, priv,
		)
		if err != nil {
			// old schema without private
			_, err = s.db.Exec(
				`INSERT INTO conversations(id,title,model,created_at,updated_at,pinned,archived) VALUES(?,?,?,?,?,0,0)`,
				id, in.Title, in.Model, now, now,
			)
			if err != nil {
				_, err = s.db.Exec(
					`INSERT INTO conversations(id,title,model,created_at,updated_at) VALUES(?,?,?,?,?)`,
					id, in.Title, in.Model, now, now,
				)
				if err != nil {
					http.Error(w, err.Error(), 500)
					return
				}
			}
		}
		writeJSON(w, conversation{ID: id, Title: in.Title, Model: in.Model, Private: in.Private, CreatedAt: now, UpdatedAt: now})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *store) handleConversation(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/conversations/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "missing id", 400)
		return
	}
	id := parts[0]
	if !isConvID(id) {
		http.Error(w, "bad id", 400)
		return
	}

	// /api/conversations/{id}/messages...
	if len(parts) >= 2 && parts[1] == "messages" {
		// DELETE /messages/from/{mid}  — mid + all later messages
		if len(parts) >= 4 && parts[2] == "from" {
			s.handleMessagesFrom(w, r, id, parts[3])
			return
		}
		// PATCH|DELETE /messages/{mid}
		if len(parts) >= 3 && parts[2] != "" && parts[2] != "from" {
			s.handleMessageOne(w, r, id, parts[2])
			return
		}
		s.handleMessages(w, r, id)
		return
	}

	switch r.Method {
	case http.MethodGet:
		var c conversation
		var pin, ar, priv int
		err := s.db.QueryRow(
			`SELECT id, title, model, created_at, updated_at, COALESCE(pinned,0), COALESCE(archived,0), COALESCE(private,0)
			 FROM conversations WHERE id=?`, id,
		).Scan(&c.ID, &c.Title, &c.Model, &c.CreatedAt, &c.UpdatedAt, &pin, &ar, &priv)
		if err == sql.ErrNoRows {
			http.Error(w, "not found", 404)
			return
		}
		if err != nil {
			// fallback pre-migration columns
			err = s.db.QueryRow(
				`SELECT id, title, model, created_at, updated_at FROM conversations WHERE id=?`, id,
			).Scan(&c.ID, &c.Title, &c.Model, &c.CreatedAt, &c.UpdatedAt)
			if err == sql.ErrNoRows {
				http.Error(w, "not found", 404)
				return
			}
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		} else {
			c.Pinned = pin != 0
			c.Archived = ar != 0
			c.Private = priv != 0
		}
		msgs, err := s.listMessages(id)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		c.Messages = msgs
		writeJSON(w, c)
	case http.MethodPatch:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var in struct {
			Title    *string `json:"title"`
			Model    *string `json:"model"`
			Pinned   *bool   `json:"pinned"`
			Archived *bool   `json:"archived"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "bad json", 400)
			return
		}
		if in.Title == nil && in.Model == nil && in.Pinned == nil && in.Archived == nil {
			http.Error(w, "empty patch", 400)
			return
		}
		var exists int
		if err := s.db.QueryRow(`SELECT 1 FROM conversations WHERE id=?`, id).Scan(&exists); err != nil {
			if err == sql.ErrNoRows {
				http.Error(w, "not found", 404)
				return
			}
			http.Error(w, err.Error(), 500)
			return
		}
		now := time.Now().UnixMilli()
		if in.Title != nil {
			t := strings.TrimSpace(*in.Title)
			if t == "" {
				t = "New chat"
			}
			t = softTruncate(t, 120)
			if _, err := s.db.Exec(`UPDATE conversations SET title=?, updated_at=? WHERE id=?`, t, now, id); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}
		if in.Model != nil && strings.TrimSpace(*in.Model) != "" {
			if _, err := s.db.Exec(`UPDATE conversations SET model=?, updated_at=? WHERE id=?`, strings.TrimSpace(*in.Model), now, id); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}
		if in.Pinned != nil {
			v := 0
			if *in.Pinned {
				v = 1
			}
			// pin also un-archives so chat reappears in main list
			_, err := s.db.Exec(
				`UPDATE conversations SET pinned=?, archived=CASE WHEN ?=1 THEN 0 ELSE archived END, updated_at=? WHERE id=?`,
				v, v, now, id,
			)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}
		if in.Archived != nil {
			v := 0
			if *in.Archived {
				v = 1
			}
			// archiving clears pin
			if v == 1 {
				_, err := s.db.Exec(`UPDATE conversations SET archived=1, pinned=0, updated_at=? WHERE id=?`, now, id)
				if err != nil {
					http.Error(w, err.Error(), 500)
					return
				}
			} else {
				_, err := s.db.Exec(`UPDATE conversations SET archived=0, updated_at=? WHERE id=?`, now, id)
				if err != nil {
					http.Error(w, err.Error(), 500)
					return
				}
			}
		}
		writeJSON(w, map[string]any{"ok": true})
	case http.MethodDelete:
		ids := s.fileIDsForConversation(id)
		_, _ = s.db.Exec(`DELETE FROM messages WHERE conversation_id=?`, id)
		res, err := s.db.Exec(`DELETE FROM conversations WHERE id=?`, id)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			http.Error(w, "not found", 404)
			return
		}
		s.deleteFiles(ids)
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *store) handleMessages(w http.ResponseWriter, r *http.Request, convID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var exists int
	if err := s.db.QueryRow(`SELECT 1 FROM conversations WHERE id=?`, convID).Scan(&exists); err != nil {
		if err == sql.ErrNoRows {
			http.Error(w, "conversation not found", 404)
			return
		}
		http.Error(w, err.Error(), 500)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	var in struct {
		Role    string   `json:"role"`
		Content string   `json:"content"`
		FileIDs []string `json:"file_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Role == "" {
		http.Error(w, "bad json", 400)
		return
	}
	if in.Role != "user" && in.Role != "assistant" && in.Role != "system" {
		http.Error(w, "bad role", 400)
		return
	}
	if in.Role == "user" && strings.TrimSpace(in.Content) == "" && len(in.FileIDs) == 0 {
		http.Error(w, "empty message", 400)
		return
	}

	atts := []attachment{}
	for _, id := range in.FileIDs {
		if !isFileID(id) {
			continue
		}
		meta, err := s.getFileMeta(id)
		if err != nil || meta == nil {
			continue
		}
		atts = append(atts, attachment{
			ID:          meta.ID,
			Name:        meta.Name,
			ContentType: meta.ContentType,
			Size:        meta.Size,
			URL:         "/api/files/" + meta.ID,
		})
	}
	if in.Role == "user" && strings.TrimSpace(in.Content) == "" && len(atts) == 0 {
		http.Error(w, "empty message", 400)
		return
	}
	attJSON, _ := json.Marshal(atts)

	now := time.Now().UnixMilli()
	mid := randToken(12)
	_, err := s.db.Exec(
		`INSERT INTO messages(id, conversation_id, role, content, created_at, attachments) VALUES(?,?,?,?,?,?)`,
		mid, convID, in.Role, in.Content, now, string(attJSON),
	)
	if err != nil {
		// fallback if column missing mid-upgrade
		_, err = s.db.Exec(
			`INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES(?,?,?,?,?)`,
			mid, convID, in.Role, in.Content, now,
		)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}
	// bump conversation + auto title from first user msg
	_, _ = s.db.Exec(`UPDATE conversations SET updated_at=? WHERE id=?`, now, convID)
	if in.Role == "user" {
		var n int
		_ = s.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE conversation_id=? AND role='user'`, convID).Scan(&n)
		if n == 1 {
			titleSrc := in.Content
			if titleSrc == "" && len(atts) > 0 {
				titleSrc = atts[0].Name
			}
			title := truncateRunes(titleSrc, 48)
			if title == "" {
				title = "New chat"
			}
			_, _ = s.db.Exec(`UPDATE conversations SET title=? WHERE id=?`, title, convID)
		}
	}
	writeJSON(w, message{
		ID: mid, ConversationID: convID, Role: in.Role, Content: in.Content,
		Attachments: atts, CreatedAt: now,
	})
}


func isMsgID(id string) bool {
	return isConvID(id) // same hex token shape
}

// DELETE /api/conversations/{cid}/messages/from/{mid}
func (s *store) handleMessagesFrom(w http.ResponseWriter, r *http.Request, convID, mid string) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	if !isMsgID(mid) {
		http.Error(w, "bad id", 400)
		return
	}
	var created int64
	err := s.db.QueryRow(
		`SELECT created_at FROM messages WHERE id=? AND conversation_id=?`, mid, convID,
	).Scan(&created)
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	// delete target and all later (by created_at, then id for same timestamp)
	_, err = s.db.Exec(
		`DELETE FROM messages WHERE conversation_id=? AND (
			created_at > ? OR (created_at = ? AND id >= ?)
		)`,
		convID, created, created, mid,
	)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	now := time.Now().UnixMilli()
	_, _ = s.db.Exec(`UPDATE conversations SET updated_at=? WHERE id=?`, now, convID)
	writeJSON(w, map[string]any{"ok": true})
}

// PATCH content | DELETE one message
func (s *store) handleMessageOne(w http.ResponseWriter, r *http.Request, convID, mid string) {
	if !isMsgID(mid) {
		http.Error(w, "bad id", 400)
		return
	}
	switch r.Method {
	case http.MethodPatch:
		r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
		var in struct {
			Content *string `json:"content"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Content == nil {
			http.Error(w, "bad json", 400)
			return
		}
		res, err := s.db.Exec(
			`UPDATE messages SET content=? WHERE id=? AND conversation_id=?`,
			*in.Content, mid, convID,
		)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			http.Error(w, "not found", 404)
			return
		}
		now := time.Now().UnixMilli()
		_, _ = s.db.Exec(`UPDATE conversations SET updated_at=? WHERE id=?`, now, convID)
		writeJSON(w, map[string]any{"ok": true, "id": mid})
	case http.MethodDelete:
		res, err := s.db.Exec(`DELETE FROM messages WHERE id=? AND conversation_id=?`, mid, convID)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			http.Error(w, "not found", 404)
			return
		}
		now := time.Now().UnixMilli()
		_, _ = s.db.Exec(`UPDATE conversations SET updated_at=? WHERE id=?`, now, convID)
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func softTruncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// randToken(12) => 24 hex chars
func isConvID(id string) bool {
	if len(id) < 16 || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func (s *store) listMessages(convID string) ([]message, error) {
	rows, err := s.db.Query(
		`SELECT id, role, content, created_at, COALESCE(attachments,'[]') FROM messages WHERE conversation_id=? ORDER BY created_at ASC`,
		convID,
	)
	if err != nil {
		// old schema without attachments
		rows, err = s.db.Query(
			`SELECT id, role, content, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC`,
			convID,
		)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []message{}
		for rows.Next() {
			var m message
			if err := rows.Scan(&m.ID, &m.Role, &m.Content, &m.CreatedAt); err != nil {
				return nil, err
			}
			out = append(out, m)
		}
		return out, nil
	}
	defer rows.Close()
	out := []message{}
	for rows.Next() {
		var m message
		var attRaw string
		if err := rows.Scan(&m.ID, &m.Role, &m.Content, &m.CreatedAt, &attRaw); err != nil {
			return nil, err
		}
		if attRaw != "" && attRaw != "[]" {
			_ = json.Unmarshal([]byte(attRaw), &m.Attachments)
		}
		out = append(out, m)
	}
	return out, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}
