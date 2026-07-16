package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Shared client for upstream chat (avoid new Transport per request).
var chatUpstream = &http.Client{
	Timeout: 0,
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ResponseHeaderTimeout: 180 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		ForceAttemptHTTP2:     true,
	},
}

// POST /api/chat — build OpenAI messages (with attachments) and proxy stream/non-stream.
func (f *fileStore) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var in struct {
		ConversationID string `json:"conversation_id"`
		Model          string `json:"model"`
		Stream         *bool  `json:"stream"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", 400)
		return
	}
	if !isConvID(in.ConversationID) {
		http.Error(w, "bad conversation_id", 400)
		return
	}
	if strings.TrimSpace(in.Model) == "" {
		http.Error(w, "model required", 400)
		return
	}
	stream := true
	if in.Stream != nil {
		stream = *in.Stream
	}

	var exists int
	if err := f.st.db.QueryRow(`SELECT 1 FROM conversations WHERE id=?`, in.ConversationID).Scan(&exists); err != nil {
		if err == sql.ErrNoRows {
			http.Error(w, "conversation not found", 404)
			return
		}
		http.Error(w, err.Error(), 500)
		return
	}

	msgs, err := f.st.listMessages(in.ConversationID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if len(msgs) == 0 {
		http.Error(w, "no messages", 400)
		return
	}
	apiMsgs := make([]map[string]any, 0, len(msgs))
	for _, m := range msgs {
		var content any = m.Content
		if m.Role == "user" {
			var err error
			content, err = f.buildUserAPIContent(m.Content, m.Attachments)
			if err != nil {
				http.Error(w, "attachment: "+err.Error(), 500)
				return
			}
		}
		apiMsgs = append(apiMsgs, map[string]any{
			"role":    m.Role,
			"content": content,
		})
	}

	base, key, err := f.st.apiConfig()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if base == "" {
		http.Error(w, `{"error":"api_base_url not set"}`, 400)
		return
	}

	payload, err := json.Marshal(map[string]any{
		"model":    in.Model,
		"messages": apiMsgs,
		"stream":   stream,
	})
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, base+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream, application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := chatUpstream.Do(req)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()

	for k, vv := range resp.Header {
		lk := strings.ToLower(k)
		switch lk {
		case "connection", "transfer-encoding", "keep-alive", "proxy-authenticate",
			"proxy-authorization", "te", "trailers", "upgrade":
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	fl, canFlush := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, er := resp.Body.Read(buf)
		if n > 0 {
			if _, ew := w.Write(buf[:n]); ew != nil {
				return
			}
			if canFlush {
				fl.Flush()
			}
		}
		if er != nil {
			return
		}
	}
}
