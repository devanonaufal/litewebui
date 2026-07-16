package main

import "testing"

func TestIsFileID(t *testing.T) {
	ok := randToken(16) // 32 hex
	if !isFileID(ok) {
		t.Fatalf("expected valid id %q", ok)
	}
	if isFileID("short") || isFileID("../etc") || isFileID("zzzz") {
		t.Fatal("invalid ids accepted")
	}
}

func TestFormatSize(t *testing.T) {
	if formatSize(500) != "500 B" {
		t.Fatal(formatSize(500))
	}
	if formatSize(2048) != "2 KB" {
		t.Fatal(formatSize(2048))
	}
}

func TestBuildUserContentEmpty(t *testing.T) {
	f := &fileStore{dir: t.TempDir(), st: nil}
	c, err := f.buildUserAPIContent("", nil)
	if err != nil {
		t.Fatal(err)
	}
	if c != "" {
		t.Fatalf("got %#v", c)
	}
	c, err = f.buildUserAPIContent("hi", nil)
	if err != nil || c != "hi" {
		t.Fatalf("%v %v", c, err)
	}
}
