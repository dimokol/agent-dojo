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
// Build: cc -O2 -o agent-chat-bridge bridge.c (bridge-core.h next to it)
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
#include "bridge-core.h"

// The daemon starts with only these: the tab's own session keys never reach it, and neither does
// AGENT_CHAT_VERSION_CHECK, which each tab's hello carries for itself.
static const char *DAEMON_ENV[] = {"PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "SHELL",
  "AGENT_CHAT_ROOT", "AGENT_CHAT_STATE_ROOT", "AGENT_CHAT_DAEMON_IDLE_MS", NULL};

#define HELLO_REPLY_S 20

static const char *socket_path, *node_path, *daemon_path;
static char *hello;
static size_t hello_len;
static int last_out_newline = 1;


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

static int out_write(const char *data, size_t len) { return write_all(1, data, len); }

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
