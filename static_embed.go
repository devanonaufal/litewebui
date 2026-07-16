package main

import (
	"embed"
	"io/fs"
)

//go:embed static/*
var embedded embed.FS

func staticFS() fs.FS {
	sub, err := fs.Sub(embedded, "static")
	if err != nil {
		panic(err)
	}
	return sub
}
