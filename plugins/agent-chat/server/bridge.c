// agent-chat-bridge: the per-tab stdio side of the shared agent-chat daemon (daemon.mjs).
//
//   agent-chat-bridge <socket> <node> <daemon.mjs>
//
// Claude or Codex starts this in place of server.mjs. It connects to <socket>, starting
// `<node> <daemon.mjs> <socket>` detached when nothing answers, sends one hello line (its PID, its
// parent's PID, its folder and the HELLO_ENV keys), waits for {"ok":true}, then copies MCP lines
// between stdio and the socket. If the daemon goes away it reconnects, starting a new one, and
// answers each call that was in flight with an error, so a crash fails those calls instead of
// leaving them waiting, and the tab keeps its agent-chat. Its parent stays the tab, which is how
// the daemon recognises the session, exactly as a server.mjs started by the tab would.
//
// Build: cc -O2 -o agent-chat-bridge bridge.c
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <limits.h>

static const char *HELLO_ENV[] = {"CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "AGENT_CHAT_CODEX_HOME", "AGENT_CHAT_VERIFY_CHILD", "AGENT_CHAT_ROOT", "AGENT_CHAT_STATE_ROOT", "AGENT_CHAT_VERSION_CHECK",
  "AGENT_CHAT_DIR", "AGENT_CHAT_PROJECT", "AGENT_CHAT_WAKE", "AGENT_CHAT_WAKE_DIR", NULL};
// The daemon starts with only these: the tab's own session keys never reach it, and neither does
// AGENT_CHAT_VERSION_CHECK, which each tab's hello carries for itself.
static const char *DAEMON_ENV[] = {"PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "SHELL",
  "AGENT_CHAT_ROOT", "AGENT_CHAT_STATE_ROOT", "AGENT_CHAT_DAEMON_IDLE_MS", NULL};

#define HELLO_REPLY_S 20

static const char *socket_path, *node_path, *daemon_path;
static char *hello;
static size_t hello_len;
static int last_out_newline = 1;

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

static void build_hello(void) {
  char cwd[PATH_MAX], number[32];
  if (!getcwd(cwd, sizeof cwd)) die("cannot read the current folder");
  buf_t b = {0};
  buf_str(&b, "{\"v\":1,\"pid\":"); snprintf(number, sizeof number, "%d", (int)getpid()); buf_str(&b, number);
  buf_str(&b, ",\"ppid\":"); snprintf(number, sizeof number, "%d", (int)getppid()); buf_str(&b, number);
  buf_str(&b, ",\"cwd\":"); buf_json(&b, cwd);
  buf_str(&b, ",\"env\":{");
  int first = 1;
  for (const char **key = HELLO_ENV; *key; key++) {
    const char *value = getenv(*key);
    if (!value) continue;
    if (!first) buf_str(&b, ",");
    first = 0;
    buf_json(&b, *key); buf_str(&b, ":"); buf_json(&b, value);
  }
  buf_str(&b, "}}\n");
  hello = b.data; hello_len = b.len;
}

static int write_all(int fd, const char *data, size_t len) {
  while (len) {
    ssize_t n = write(fd, data, len);
    if (n < 0) { if (errno == EINTR) continue; return -1; }
    data += n; len -= (size_t)n;
  }
  return 0;
}

static int try_connect(void) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  strncpy(address.sun_path, socket_path, sizeof address.sun_path - 1);
  if (connect(fd, (struct sockaddr *)&address, sizeof address) == 0) return fd;
  int saved = errno; close(fd); errno = saved;
  return -1;
}

static void spawn_daemon(void) {
  pid_t child = fork();
  if (child < 0) return;
  if (child > 0) { int status; waitpid(child, &status, 0); return; }
  // First child: a new session, then a grandchild the tab never waits on.
  setsid();
  if (fork() != 0) _exit(0);
  int null = open("/dev/null", O_RDWR);
  if (null >= 0) { dup2(null, 0); dup2(null, 1); dup2(null, 2); }
  for (int fd = 3; fd < 1024; fd++) close(fd);
  if (chdir("/") != 0) _exit(1);
  char *envp[32]; int count = 0;
  for (const char **key = DAEMON_ENV; *key && count < 31; key++) {
    const char *value = getenv(*key);
    if (!value) continue;
    size_t size = strlen(*key) + strlen(value) + 2;
    char *entry = malloc(size);
    if (!entry) _exit(1);
    snprintf(entry, size, "%s=%s", *key, value);
    envp[count++] = entry;
  }
  envp[count] = NULL;
  char *argv[] = {(char *)node_path, (char *)daemon_path, (char *)socket_path, NULL};
  execve(node_path, argv, envp);
  _exit(127);
}

// Calls sent to the daemon and not answered yet, by the raw JSON text of their id.
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
    write_all(1, b.data, b.len);
    free(b.data); free(pending.ids[i]);
  }
  pending.len = 0;
}

static char *last_newline(char *data, size_t len) {
  while (len) { if (data[--len] == '\n') return data + len; }
  return NULL;
}

static void pause_ms(int ms) { struct timespec t = {ms / 1000, (long)(ms % 1000) * 1000000L}; nanosleep(&t, NULL); }

// Connects, starting the daemon when nothing listens, and completes the hello. Returns the socket,
// or -1 after the deadline. A refusal from the daemon is final: its text goes to stderr.
static int open_daemon(int wait_ms) {
  int spawned = 0;
  for (int waited = 0; ; waited += 50) {
    int fd = try_connect();
    if (fd >= 0) {
      if (write_all(fd, hello, hello_len) != 0) { close(fd); fd = -1; }
      else {
        char reply[8192]; size_t got = 0;
        // The daemon answers once it has opened this tab's project; one that never does is stuck.
        time_t deadline = time(NULL) + HELLO_REPLY_S;
        while (got < sizeof reply - 1) {
          struct pollfd ready = {fd, POLLIN, 0};
          int left = (int)(deadline - time(NULL));
          if (left <= 0 || poll(&ready, 1, left * 1000) == 0) { close(fd); return -1; }
          ssize_t n = read(fd, reply + got, 1);
          if (n < 0 && errno == EINTR) continue;
          if (n <= 0) break;
          got++;
          if (reply[got - 1] == '\n') break;
        }
        reply[got] = 0;
        if (got && strncmp(reply, "{\"ok\":true}", 11) == 0) return fd;
        close(fd);
        if (strncmp(reply, "{\"error\":", 9) == 0) {
          // The daemon's text is plain JSON from JSON.stringify; print it unescaped enough to read.
          char *text = reply + 10, *end = strrchr(text, '"');
          if (end) *end = 0;
          fprintf(stderr, "%s\n", text);
          exit(1);
        }
        fd = -1; // A daemon that closed mid-hello (stopping): try again.
      }
    }
    if (!spawned && (errno == ENOENT || errno == ECONNREFUSED || fd < 0)) { spawn_daemon(); spawned = 1; }
    if (waited >= wait_ms) return -1;
    pause_ms(50);
  }
}

int main(int argc, char **argv) {
  if (argc != 4) die("usage: agent-chat-bridge <socket> <node> <daemon.mjs>");
  socket_path = argv[1]; node_path = argv[2]; daemon_path = argv[3];
  if (socket_path[0] != '/' || strlen(socket_path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) die("socket path must be absolute and short");
  signal(SIGPIPE, SIG_IGN);
  build_hello();
  int sock = open_daemon(15000);
  if (sock < 0) die("the shared daemon did not start");

  buf_t in = {0}, out = {0};
  char chunk[65536];
  time_t window = time(NULL); int reconnects = 0;
  for (;;) {
    struct pollfd fds[2] = {{0, POLLIN, 0}, {sock, POLLIN, 0}};
    if (poll(fds, 2, -1) < 0) { if (errno == EINTR) continue; die("poll failed"); }
    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(0, chunk, sizeof chunk);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) {
        // The tab closed its side. Pass on a last partial line, then let the daemon finish.
        if (in.len) { buf_add(&in, "\n", 1); write_all(sock, in.data, in.len); }
        shutdown(sock, SHUT_WR);
        for (;;) {
          ssize_t m = read(sock, chunk, sizeof chunk);
          if (m < 0 && errno == EINTR) continue;
          if (m <= 0 || write_all(1, chunk, (size_t)m) != 0) break;
        }
        return 0;
      }
      buf_add(&in, chunk, (size_t)n);
      // Only whole lines go to the daemon, so a reconnect never splits a request.
      char *newline = last_newline(in.data, in.len);
      if (newline) {
        size_t whole = (size_t)(newline - in.data) + 1;
        // Tracked before the write: a call that never reaches the daemon fails at the reconnect too.
        track(in.data, whole, 1);
        if (write_all(sock, in.data, whole) != 0) { /* the read side notices and reconnects */ }
        memmove(in.data, in.data + whole, in.len - whole); in.len -= whole;
      }
    }
    if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(sock, chunk, sizeof chunk);
      if (n < 0 && errno == EINTR) continue;
      if (n > 0) {
        if (write_all(1, chunk, (size_t)n) != 0) return 0;
        last_out_newline = chunk[n - 1] == '\n';
        buf_add(&out, chunk, (size_t)n);
        char *newline = last_newline(out.data, out.len);
        if (newline) {
          size_t whole = (size_t)(newline - out.data) + 1;
          track(out.data, whole, 0);
          memmove(out.data, out.data + whole, out.len - whole); out.len -= whole;
        }
        continue;
      }
      // The daemon went away. At most five reconnects a minute: a daemon that keeps failing ends here.
      close(sock);
      if (time(NULL) - window > 60) { window = time(NULL); reconnects = 0; }
      // A reply cut off mid-line would glue onto the next one; end it, then fail the unanswered calls.
      if (!last_out_newline) { write_all(1, "\n", 1); last_out_newline = 1; }
      out.len = 0;
      fail_pending();
      if (++reconnects > 5) die("the shared daemon keeps failing");
      sock = open_daemon(15000);
      if (sock < 0) die("the shared daemon did not restart");
    }
  }
}
