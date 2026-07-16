package main

import (
	"encoding/base64"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Soft ceiling for one multipart upload (not “product limit”; protects RAM/disk).
const maxUploadBytes = 512 << 20 // 512 MiB

type fileStore struct {
	dir string
	st  *store
}

func newFileStore(dataDir string, st *store) (*fileStore, error) {
	dir := filepath.Join(dataDir, "uploads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &fileStore{dir: dir, st: st}, nil
}

func (f *fileStore) pathFor(id string) string {
	return filepath.Join(f.dir, id)
}

// POST /api/files  multipart field "file"
func (f *fileStore) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+1<<20) // file + multipart overhead
	// large multipart; ParseMultipartForm still needs a maxMemory for spill-to-disk
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "multipart: "+err.Error(), 400)
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file required", 400)
		return
	}
	defer file.Close()

	if hdr.Size > 0 && hdr.Size > maxUploadBytes {
		http.Error(w, "file too large", 413)
		return
	}

	id := randToken(16)
	dstPath := f.pathFor(id)
	dst, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	n, err := io.Copy(dst, io.LimitReader(file, maxUploadBytes+1))
	_ = dst.Close()
	if err != nil {
		_ = os.Remove(dstPath)
		http.Error(w, err.Error(), 500)
		return
	}
	if n > maxUploadBytes {
		_ = os.Remove(dstPath)
		http.Error(w, "file too large", 413)
		return
	}

	ct := hdr.Header.Get("Content-Type")
	if ct == "" || ct == "application/octet-stream" {
		if ext := filepath.Ext(hdr.Filename); ext != "" {
			if t := mime.TypeByExtension(ext); t != "" {
				ct = t
			}
		}
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	name := filepath.Base(hdr.Filename)
	if name == "" || name == "." {
		name = id
	}

	if err := f.st.insertFileMeta(id, name, ct, n); err != nil {
		_ = os.Remove(dstPath)
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]any{
		"id":           id,
		"name":         name,
		"content_type": ct,
		"size":         n,
		"url":          "/api/files/" + id,
	})
}

// GET /api/files/{id}
func (f *fileStore) handleGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/files/")
	id = strings.Trim(id, "/")
	if id == "" || strings.Contains(id, "/") || strings.Contains(id, "..") {
		http.Error(w, "bad id", 400)
		return
	}
	if !isFileID(id) {
		http.Error(w, "bad id", 400)
		return
	}
	meta, err := f.st.getFileMeta(id)
	if err != nil || meta == nil {
		http.Error(w, "not found", 404)
		return
	}
	p := f.pathFor(id)
	w.Header().Set("Content-Type", meta.ContentType)
	w.Header().Set("Content-Disposition", `inline; filename="`+sanitizeFilename(meta.Name)+`"`)
	http.ServeFile(w, r, p)
}

func isFileID(id string) bool {
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

func sanitizeFilename(s string) string {
	s = strings.ReplaceAll(s, `"`, "")
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\\", "_")
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.Map(func(r rune) rune {
		if r < 32 {
			return -1
		}
		return r
	}, s)
	if s == "" || s == "." || s == ".." {
		return "file"
	}
	return s
}

// Attachment stored on a message (JSON array in messages.attachments).
type attachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size,omitempty"`
	URL         string `json:"url,omitempty"`
}

func (f *fileStore) loadAttachments(ids []string) ([]attachment, error) {
	out := make([]attachment, 0, len(ids))
	for _, id := range ids {
		if !isFileID(id) {
			continue
		}
		meta, err := f.st.getFileMeta(id)
		if err != nil || meta == nil {
			continue
		}
		out = append(out, attachment{
			ID:          meta.ID,
			Name:        meta.Name,
			ContentType: meta.ContentType,
			Size:        meta.Size,
			URL:         "/api/files/" + meta.ID,
		})
	}
	return out, nil
}

// Build OpenAI chat message content: string or multimodal array.
func (f *fileStore) buildUserAPIContent(text string, atts []attachment) (any, error) {
	var parts []map[string]any
	if strings.TrimSpace(text) != "" {
		parts = append(parts, map[string]any{"type": "text", "text": text})
	}
	var fileNotes []string
	for _, a := range atts {
		if strings.HasPrefix(a.ContentType, "image/") {
			b64, err := f.readBase64(a.ID)
			if err != nil {
				fileNotes = append(fileNotes, "[image "+a.Name+": "+err.Error()+"]")
				continue
			}
			mime := a.ContentType
			if i := strings.IndexByte(mime, ';'); i >= 0 {
				mime = strings.TrimSpace(mime[:i])
			}
			if mime == "" {
				mime = "image/png"
			}
			url := "data:" + mime + ";base64," + b64
			parts = append(parts, map[string]any{
				"type": "image_url",
				"image_url": map[string]any{
					"url": url,
				},
			})
			continue
		}
		// text-like / pdf best-effort extract
		snippet, ok := f.extractText(a.ID, a.ContentType, a.Name)
		if ok {
			fileNotes = append(fileNotes, "--- file: "+a.Name+" ---\n"+snippet)
		} else {
			fileNotes = append(fileNotes, "[attached file: "+a.Name+" ("+a.ContentType+", "+formatSize(a.Size)+") — binary, content not inlined]")
		}
	}
	if len(fileNotes) > 0 {
		parts = append(parts, map[string]any{
			"type": "text",
			"text": strings.Join(fileNotes, "\n\n"),
		})
	}
	if len(parts) == 0 {
		return "", nil
	}
	// pure text only
	if len(parts) == 1 && parts[0]["type"] == "text" {
		return parts[0]["text"], nil
	}
	return parts, nil
}

func (f *fileStore) readBase64(id string) (string, error) {
	// vision payloads: avoid multi-GB base64 in memory
	const maxImg = 40 << 20 // 40 MiB raw
	p := f.pathFor(id)
	fi, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if fi.Size() > maxImg {
		return "", errImageTooLarge
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

var errImageTooLarge = &simpleError{"image too large for vision inline (max 40MB)"}

type simpleError struct{ s string }

func (e *simpleError) Error() string { return e.s }

func (f *fileStore) extractText(id, ct, name string) (string, bool) {
	const maxExtract = 2 << 20 // 2 MiB into prompt
	p := f.pathFor(id)
	fd, err := os.Open(p)
	if err != nil {
		return "", false
	}
	defer fd.Close()
	// PDF may need more raw bytes for scrape (capped in scrapePDFText)
	limit := int64(maxExtract)
	if strings.Contains(strings.ToLower(ct+" "+name), "pdf") {
		limit = 8 << 20
	}
	b, err := io.ReadAll(io.LimitReader(fd, limit))
	if err != nil {
		return "", false
	}
	lower := strings.ToLower(ct + " " + name)
	if strings.HasPrefix(ct, "text/") ||
		strings.Contains(lower, "json") ||
		strings.Contains(lower, "xml") ||
		strings.Contains(lower, "javascript") ||
		strings.Contains(lower, "csv") ||
		strings.HasSuffix(lower, ".md") ||
		strings.HasSuffix(lower, ".txt") ||
		strings.HasSuffix(lower, ".log") ||
		strings.HasSuffix(lower, ".csv") ||
		strings.HasSuffix(lower, ".json") ||
		strings.HasSuffix(lower, ".html") ||
		strings.HasSuffix(lower, ".css") ||
		strings.HasSuffix(lower, ".go") ||
		strings.HasSuffix(lower, ".py") ||
		strings.HasSuffix(lower, ".js") ||
		strings.HasSuffix(lower, ".ts") {
		if utf8.Valid(b) {
			return string(b), true
		}
	}
	// naive PDF text scrape (streams of printable chars)
	if strings.Contains(lower, "pdf") || strings.HasSuffix(lower, ".pdf") {
		s := scrapePDFText(b)
		if len(s) > 40 {
			return s, true
		}
	}
	// if mostly UTF-8 text
	if utf8.Valid(b) {
		nonPrint := 0
		sample := b
		if len(sample) > 8192 {
			sample = sample[:8192]
		}
		for _, r := range string(sample) {
			if r < 9 || (r > 13 && r < 32) {
				nonPrint++
			}
		}
		if nonPrint*10 < len(sample) {
			return string(b), true
		}
	}
	return "", false
}

func scrapePDFText(b []byte) string {
	// pull sequences between parentheses in content streams — crude but zero-deps
	const maxScan = 8 << 20 // don't walk 512MB PDF
	if len(b) > maxScan {
		b = b[:maxScan]
	}
	var out strings.Builder
	for i := 0; i < len(b); i++ {
		if b[i] != '(' {
			continue
		}
		i++
		start := i
		for i < len(b) && b[i] != ')' {
			if b[i] == '\\' && i+1 < len(b) {
				i += 2
				continue
			}
			i++
		}
		if i > start && i-start < 500 {
			chunk := b[start:i]
			if utf8.Valid(chunk) {
				s := string(chunk)
				if strings.TrimSpace(s) != "" {
					out.WriteString(s)
					out.WriteByte(' ')
				}
			}
		}
		if out.Len() > 100000 {
			break
		}
	}
	s := out.String()
	if len(s) > 100000 {
		s = s[:100000] + "…"
	}
	return strings.TrimSpace(s)
}

func formatSize(n int64) string {
	if n < 1024 {
		return itoa(n) + " B"
	}
	const unit = 1024
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	units := []string{"KB", "MB", "GB", "TB"}
	if exp >= len(units) {
		exp = len(units) - 1
	}
	return itoa(n/div) + " " + units[exp]
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var neg bool
	if n < 0 {
		neg = true
		n = -n
	}
	var b [32]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
