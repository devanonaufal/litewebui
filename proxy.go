package main

import (
	"net/http"
	"net/url"
	"strings"
	"time"
)

type proxy struct {
	st  *store
	cli *http.Client
}

func newProxy(st *store) *proxy {
	return &proxy{
		st: st,
		cli: &http.Client{
			Timeout: 0,
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				ResponseHeaderTimeout: 120 * time.Second,
				IdleConnTimeout:       90 * time.Second,
				ForceAttemptHTTP2:     true,
			},
		},
	}
}

// /api/v1/* -> {base}/*
func (p *proxy) handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodPost:
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}

	base, key, err := p.st.apiConfig()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if base == "" {
		http.Error(w, `{"error":"api_base_url not set — buka Settings"}`, http.StatusBadRequest)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if strings.Contains(path, "..") || strings.Contains(path, "://") {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}

	target := base + path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	if _, err := url.ParseRequestURI(target); err != nil {
		http.Error(w, "bad url", http.StatusBadRequest)
		return
	}

	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, 512<<20) // 512 MiB for multimodal
	}

	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if ct := r.Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	if a := r.Header.Get("Accept"); a != "" {
		req.Header.Set("Accept", a)
	} else {
		req.Header.Set("Accept", "application/json")
	}

	resp, err := p.cli.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
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
