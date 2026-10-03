// Package logclient ships structured interaction events to admin-api, fire and
// forget: logging must never slow down or fail a request, so every send runs in
// its own goroutine with a short timeout and errors are swallowed.
package logclient

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type Client struct {
	service string
	baseURL string
	secret  string
	http    *http.Client
	enabled bool
}

// New returns a client that posts events tagged with service to
// {baseURL}/v1/internal/logs. If baseURL or secret is empty the client is
// disabled and Log is a no-op, so each service still runs standalone without
// admin-api configured. Always returns a non-nil client, so callers never guard.
func New(service, baseURL, secret string) *Client {
	return &Client{
		service: service,
		baseURL: baseURL,
		secret:  secret,
		http:    &http.Client{Timeout: 3 * time.Second},
		enabled: baseURL != "" && secret != "",
	}
}

type entry struct {
	Service string         `json:"service"`
	Event   string         `json:"event"`
	Level   string         `json:"level"`
	Status  *int           `json:"status,omitempty"`
	Detail  map[string]any `json:"detail,omitempty"`
}

// Log sends one event in the background. status may be nil for events with no
// HTTP status (e.g. a keeper bump or an indexer sync gap).
func (c *Client) Log(event, level string, status *int, detail map[string]any) {
	if !c.enabled {
		return
	}
	go c.send(entry{Service: c.service, Event: event, Level: level, Status: status, Detail: detail})
}

func (c *Client) send(e entry) {
	body, err := json.Marshal(e)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/internal/logs", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Cyphras-Admin-Key", c.secret)

	res, err := c.http.Do(req)
	if err != nil {
		return
	}
	_ = res.Body.Close()
}
