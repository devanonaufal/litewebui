package main

import (
	"strings"
	"testing"
)

func TestPasswordOK(t *testing.T) {
	// sha256("secret")
	sha := "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b"
	if !passwordOK("secret", sha) {
		t.Fatal("expected sha256 match")
	}
	if passwordOK("wrong", sha) {
		t.Fatal("expected reject")
	}
	if !passwordOK("secret", strings.ToUpper(sha)) {
		t.Fatal("expected case-insensitive hex match")
	}
	// md5("secret") legacy
	md5 := "5ebe2294ecd0e0f08eab7690d2a6ee69"
	if !passwordOK("secret", md5) {
		t.Fatal("expected md5 legacy match")
	}
	if passwordOK("secret", "not-a-hash") {
		t.Fatal("expected reject bad hash")
	}
	// default app password changeme
	const devHash = "057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86"
	if !passwordOK("changeme", devHash) {
		t.Fatal("expected changeme match")
	}
	if passwordOK("admin", devHash) {
		t.Fatal("admin must not match changeme hash")
	}
}

func TestStrEQ(t *testing.T) {
	if !strEQ("admin", "admin") {
		t.Fatal("eq")
	}
	if strEQ("admin", "Admin") {
		t.Fatal("case")
	}
	if strEQ("a", "ab") {
		t.Fatal("len")
	}
}

func TestIsConvID(t *testing.T) {
	id := randToken(12) // 24 hex
	if !isConvID(id) {
		t.Fatalf("want valid id %q", id)
	}
	if isConvID("../x") || isConvID("") || isConvID("short") {
		t.Fatal("want invalid")
	}
}

func TestProxyPathJoin(t *testing.T) {
	base := strings.TrimRight("http://127.0.0.1:20128/v1", "/")
	path := "/models"
	got := base + path
	want := "http://127.0.0.1:20128/v1/models"
	if got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}
