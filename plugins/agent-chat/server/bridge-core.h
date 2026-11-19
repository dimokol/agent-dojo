// The platform-free half of the agent-chat bridge, shared by bridge.c (macOS, Linux) and
// agent-chat-win.c (Windows): the hello's environment allowlist, a growable buffer with JSON
// quoting, and the bookkeeping that fails calls still in flight when the daemon goes away.
// The including file defines out_write(), which writes to the tab's stdout.
#ifndef AGENT_CHAT_BRIDGE_CORE_H
#define AGENT_CHAT_BRIDGE_CORE_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int out_write(const char *data, size_t len);

static const char *HELLO_ENV[] = {"CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "AGENT_CHAT_CODEX_HOME", "AGENT_CHAT_VERIFY_CHILD", "AGENT_CHAT_ROOT", "AGENT_CHAT_STATE_ROOT", "AGENT_CHAT_VERSION_CHECK",
  "AGENT_CHAT_DIR", "AGENT_CHAT_PROJECT", "AGENT_CHAT_WAKE", "AGENT_CHAT_WAKE_DIR", NULL};

static void die(const char *message) {
  fprintf(stderr, "Agent-chat bridge: %s\n", message);
  exit(1);
}

typedef struct { char *data; size_t len, cap; } buf_t;
static void buf_add(buf_t *b, const char *s, size_t n) {
  if (b->len + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 1024;
    while (b->len + n + 1 > cap) cap *= 2;
    char *grown = realloc(b->data, cap);
    if (!grown) die("out of memory");
    b->data = grown; b->cap = cap;
  }
  memcpy(b->data + b->len, s, n); b->len += n; b->data[b->len] = 0;
}
static void buf_str(buf_t *b, const char *s) { buf_add(b, s, strlen(s)); }
static void buf_json(buf_t *b, const char *s) {
  buf_add(b, "\"", 1);
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    char esc[8];
    if (*p == '"' || *p == '\\') { esc[0] = '\\'; esc[1] = (char)*p; buf_add(b, esc, 2); }
    else if (*p < 0x20) { snprintf(esc, sizeof esc, "\\u%04x", *p); buf_add(b, esc, 6); }
    else buf_add(b, (const char *)p, 1);
  }
  buf_add(b, "\"", 1);
}

typedef struct { char **ids; size_t len, cap; } idset_t;
static idset_t pending;
static void pending_add(const char *id) {
  if (pending.len == pending.cap) {
    size_t cap = pending.cap ? pending.cap * 2 : 16;
    char **grown = realloc(pending.ids, cap * sizeof *grown);
    if (!grown) die("out of memory");
    pending.ids = grown; pending.cap = cap;
  }
  char *copy = strdup(id);
  if (!copy) die("out of memory");
  pending.ids[pending.len++] = copy;
}
static void pending_remove(const char *id) {
  for (size_t i = 0; i < pending.len; i++) if (strcmp(pending.ids[i], id) == 0) {
    free(pending.ids[i]); pending.ids[i] = pending.ids[--pending.len]; return;
  }
}

// Reads the top-level "id" of one JSON-RPC line into out (its raw text: a number or a quoted
// string) and reports whether the line has a top-level "method". Returns 1 when it has an id.
static int scan_line(const char *s, size_t n, char *out, size_t cap, int *method) {
  int depth = 0, key = 0, found = 0;
  *method = 0;
  size_t i = 0;
  while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r')) i++;
  if (i >= n || s[i] != '{') return 0;
  for (; i < n; i++) {
    char c = s[i];
    if (c == '"') {
      size_t start = ++i;
      while (i < n && s[i] != '"') { if (s[i] == '\\') i++; i++; }
      if (i >= n) return 0;
      if (depth != 1 || !key) continue;
      key = 0;
      size_t klen = i - start, j = i + 1;
      while (j < n && (s[j] == ' ' || s[j] == '\t')) j++;
      if (j >= n || s[j] != ':') return 0;
      for (j++; j < n && (s[j] == ' ' || s[j] == '\t'); ) j++;
      if (klen == 6 && memcmp(s + start, "method", 6) == 0) *method = 1;
      if (klen == 2 && memcmp(s + start, "id", 2) == 0) {
        size_t v = j;
        if (v < n && s[v] == '"') {
          for (v++; v < n && s[v] != '"'; v++) if (s[v] == '\\') v++;
          if (v >= n) return 0;
          v++;
        } else while (v < n && s[v] != ',' && s[v] != '}' && s[v] != ' ' && s[v] != '\t' && s[v] != '\r') v++;
        if (v == j || v - j >= cap) return 0;
        memcpy(out, s + j, v - j); out[v - j] = 0; found = 1;
      }
      i = j - 1;
    } else if (c == '{' || c == '[') { if (++depth == 1) key = 1; }
    else if (c == '}' || c == ']') depth--;
    else if (c == ',' && depth == 1) key = 1;
  }
  return found;
}

// Tracks each whole line: a request the tab sends is pending until a response with its id comes back.
static void track(const char *data, size_t len, int outgoing) {
  char id[256]; int method;
  for (const char *line = data, *end = data + len; line < end; ) {
    const char *newline = memchr(line, '\n', (size_t)(end - line));
    size_t n = newline ? (size_t)(newline - line) : (size_t)(end - line);
    if (scan_line(line, n, id, sizeof id, &method) && strcmp(id, "null") != 0) {
      if (outgoing && method) pending_add(id);
      else if (!outgoing && !method) pending_remove(id);
    }
    line += n + 1;
  }
}

// The daemon went away: every call it had not answered gets an error now.
static void fail_pending(void) {
  for (size_t i = 0; i < pending.len; i++) {
    buf_t b = {0};
    buf_str(&b, "{\"jsonrpc\":\"2.0\",\"id\":"); buf_str(&b, pending.ids[i]);
    buf_str(&b, ",\"error\":{\"code\":-32603,\"message\":\"The shared agent-chat daemon restarted before answering; retry the call.\"}}\n");
    out_write(b.data, b.len);
    free(b.data); free(pending.ids[i]);
  }
  pending.len = 0;
}

static char *last_newline(char *data, size_t len) {
  while (len) { if (data[--len] == '\n') return data + len; }
  return NULL;
}
// Turns a JSON string body (the text between the quotes) back into plain UTF-8, in place, so a
// refusal the daemon sent (a JSON.stringify'd {"error":"..."}) prints as a pasteable command.
static void json_unescape(char *s) {
  char *out = s;
  for (char *p = s; *p; p++) {
    if (*p != '\\' || !p[1]) { *out++ = *p; continue; }
    char c = *++p;
    if (c == 'n') *out++ = '\n';
    else if (c == 't') *out++ = '\t';
    else if (c == 'r') *out++ = '\r';
    else if (c == 'u' && p[1] && p[2] && p[3] && p[4]) {
      unsigned v = (unsigned)strtoul((char[]){p[1], p[2], p[3], p[4], 0}, NULL, 16);
      p += 4;
      if (v < 0x80) *out++ = (char)v;
      else if (v < 0x800) { *out++ = (char)(0xC0 | (v >> 6)); *out++ = (char)(0x80 | (v & 0x3F)); }
      else { *out++ = (char)(0xE0 | (v >> 12)); *out++ = (char)(0x80 | ((v >> 6) & 0x3F)); *out++ = (char)(0x80 | (v & 0x3F)); }
    } else *out++ = c;
  }
  *out = 0;
}

#endif
