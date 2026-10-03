// Package config reads service configuration from the environment, mirroring the
// variable names the TypeScript services already use so a single .env fits both.
package config

import (
	"os"
	"strconv"
)

func Get(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func MustGet(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic("missing required env " + key)
	}
	return v
}

func GetInt64(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}
