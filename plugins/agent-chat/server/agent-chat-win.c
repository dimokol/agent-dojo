// agent-chat-win.exe: the native Windows half of agent-chat, one small program with four jobs.
//
//   agent-chat-win bridge <keyfile> <node> <daemon.mjs>
//       The per-tab bridge to the shared daemon (the Windows bridge.c). The daemon listens on a
//       named pipe and writes its name and a random key to <keyfile>, inside the private daemon
//       folder. The bridge reads both, checks that the pipe's server runs as this user, and sends
//       the key in its hello: reading the key takes the folder's ACL, as the Unix socket's 0600
//       does on macOS. Starts the daemon when nothing answers.
//   agent-chat-win wake
//       The asyncRewake waiter (the Windows wake.sh). Serves \\.\pipe\agent-chat-wake-<claude>-<me>
//       to this user only and blocks on it and on the Claude process together, so it exits as soon
//       as Claude does. A byte on the pipe means "look at the ring file now".
//   agent-chat-win ps <pid>... | ps --all
//       One JSON line per live PID: pid, ppid, start (FILETIME), mine (same user), image path.
//       Replaces /bin/ps and lsof.
//   agent-chat-win acl-check <dir> | acl-lock <dir>
//       Prints "private" when the folder's DACL lets in only this user, SYSTEM and Administrators,
//       otherwise "loose". acl-lock first replaces the DACL with exactly those three, inherited by
//       everything inside, then checks.
//
// Build (on the Mac, mingw-w64): see build-win.sh. Needs Windows 10 or newer (UCRT).
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "bridge-core.h"

// ---------------------------------------------------------------------------------------------
// Shared helpers

static HANDLE out_handle;
static int write_handle(HANDLE h, const char *data, size_t len) {
  while (len) {
    DWORD n = 0;
    if (!WriteFile(h, data, (DWORD)(len > 65536 ? 65536 : len), &n, NULL)) return -1;
    data += n; len -= n;
  }
  return 0;
}
static int out_write(const char *data, size_t len) { return write_handle(out_handle, data, len); }

static char *utf8(const wchar_t *w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
  char *s = malloc(n > 0 ? n : 1);
  if (!s) die("out of memory");
  if (n <= 0) { s[0] = 0; return s; }
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL);
  return s;
}
static wchar_t *wide(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  wchar_t *w = malloc((n > 0 ? n : 1) * sizeof *w);
  if (!w) die("out of memory");
  if (n <= 0) { w[0] = 0; return w; }
  MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
  return w;
}

// This process's user SID, read once.
static PSID my_sid(void) {
  static BYTE buf[256]; static int done;
  if (!done) {
    HANDLE token; DWORD got;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) die("cannot read this process's user");
    if (!GetTokenInformation(token, TokenUser, buf, sizeof buf, &got)) die("cannot read this process's user");
    CloseHandle(token); done = 1;
  }
  return ((TOKEN_USER *)buf)->User.Sid;
}
// 1 when the process runs as this user, 0 when not, -1 when Windows won't say.
static int same_user(HANDLE process) {
  HANDLE token; BYTE buf[256]; DWORD got;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return -1;
  BOOL ok = GetTokenInformation(token, TokenUser, buf, sizeof buf, &got);
  CloseHandle(token);
  if (!ok) return -1;
  return EqualSid(((TOKEN_USER *)buf)->User.Sid, my_sid()) ? 1 : 0;
}

static PSID well_known(WELL_KNOWN_SID_TYPE type) {
  PSID sid = malloc(SECURITY_MAX_SID_SIZE); DWORD size = SECURITY_MAX_SID_SIZE;
  if (!sid || !CreateWellKnownSid(type, NULL, sid, &size)) die("cannot build a well-known SID");
  return sid;
}

// A DACL for this user, SYSTEM and Administrators only, inherited by files and folders inside.
static PACL private_dacl(DWORD inherit) {
  EXPLICIT_ACCESSW access[3];
  PSID sids[3] = {my_sid(), well_known(WinLocalSystemSid), well_known(WinBuiltinAdministratorsSid)};
  ZeroMemory(access, sizeof access);
  for (int i = 0; i < 3; i++) {
    access[i].grfAccessPermissions = GENERIC_ALL;
    access[i].grfAccessMode = SET_ACCESS;
    access[i].grfInheritance = inherit;
    access[i].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access[i].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    access[i].Trustee.ptstrName = (LPWSTR)sids[i];
  }
  PACL acl = NULL;
  if (SetEntriesInAclW(3, access, NULL, &acl) != ERROR_SUCCESS) die("cannot build a private ACL");
  return acl;
}

// Security attributes for a named pipe only this user can open.
static SECURITY_ATTRIBUTES *private_pipe_sa(void) {
  static SECURITY_ATTRIBUTES sa; static SECURITY_DESCRIPTOR sd; static int done;
  if (!done) {
    InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
    EXPLICIT_ACCESSW access; ZeroMemory(&access, sizeof access);
    access.grfAccessPermissions = GENERIC_ALL; access.grfAccessMode = SET_ACCESS; access.grfInheritance = NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID; access.Trustee.TrusteeType = TRUSTEE_IS_USER; access.Trustee.ptstrName = (LPWSTR)my_sid();
    PACL acl = NULL;
    if (SetEntriesInAclW(1, &access, NULL, &acl) != ERROR_SUCCESS) die("cannot build the pipe ACL");
    SetSecurityDescriptorDacl(&sd, TRUE, acl, FALSE);
    sa.nLength = sizeof sa; sa.lpSecurityDescriptor = &sd; sa.bInheritHandle = FALSE; done = 1;
  }
  return &sa;
}

// ---------------------------------------------------------------------------------------------
// acl-check, acl-lock

static int sid_allowed(PSID sid) {
  static PSID system, admins;
  if (!system) { system = well_known(WinLocalSystemSid); admins = well_known(WinBuiltinAdministratorsSid); }
  return EqualSid(sid, my_sid()) || EqualSid(sid, system) || EqualSid(sid, admins);
}

static int acl_private(const wchar_t *dir) {
  PACL dacl = NULL; PSECURITY_DESCRIPTOR sd = NULL;
  if (GetNamedSecurityInfoW(dir, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &dacl, NULL, &sd) != ERROR_SUCCESS) return -1;
  int ok = dacl != NULL; // A null DACL lets everyone in.
  PSID creator_owner = well_known(WinCreatorOwnerSid);
  for (DWORD i = 0; ok && i < dacl->AceCount; i++) {
    ACE_HEADER *ace;
    if (!GetAce(dacl, i, (void **)&ace)) { ok = 0; break; }
    if (ace->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (ace->AceType != ACCESS_ALLOWED_ACE_TYPE) { ok = 0; break; } // Object or callback ACEs: not ours, so not private.
    PSID sid = (PSID)&((ACCESS_ALLOWED_ACE *)ace)->SidStart;
    // CREATOR OWNER on an inherit-only entry hands rights to whoever creates a child, which only
    // the allowed accounts can do here.
    if (EqualSid(sid, creator_owner) && (ace->AceFlags & INHERIT_ONLY_ACE)) continue;
    if (!sid_allowed(sid)) ok = 0;
  }
  LocalFree(sd);
  return ok;
}

static int acl_lock(const wchar_t *dir) {
  PACL acl = private_dacl(SUB_CONTAINERS_AND_OBJECTS_INHERIT);
  DWORD result = SetNamedSecurityInfoW((LPWSTR)dir, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
  LocalFree(acl);
  return result == ERROR_SUCCESS;
}

static int cmd_acl(int lock, const wchar_t *dir) {
  if (lock && !acl_lock(dir)) { printf("error %lu\n", GetLastError()); return 1; }
  int state = acl_private(dir);
  if (state < 0) { printf("error %lu\n", GetLastError()); return 1; }
  printf(state ? "private\n" : "loose\n");
  return 0;
}

// ---------------------------------------------------------------------------------------------
// ps

static void json_utf8(const wchar_t *w) {
  buf_t b = {0}; char *s = utf8(w);
  buf_json(&b, s); fwrite(b.data, 1, b.len, stdout);
  free(s); free(b.data);
}

static int cmd_ps(int argc, wchar_t **argv) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) { fprintf(stderr, "snapshot failed: %lu\n", GetLastError()); return 1; }
  PROCESSENTRY32W e; e.dwSize = sizeof e;
  for (BOOL ok = Process32FirstW(snap, &e); ok; ok = Process32NextW(snap, &e)) {
    int wanted = argc == 1 && wcscmp(argv[0], L"--all") == 0;
    for (int i = 0; i < argc && !wanted; i++) wanted = wcstoul(argv[i], NULL, 10) == e.th32ProcessID;
    if (!wanted) continue;
    printf("{\"pid\":%lu,\"ppid\":%lu", e.th32ProcessID, e.th32ParentProcessID);
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, e.th32ProcessID);
    if (h) {
      FILETIME created, exited, kernel, user;
      if (GetProcessTimes(h, &created, &exited, &kernel, &user))
        printf(",\"start\":\"%llu\"", ((unsigned long long)created.dwHighDateTime << 32) | created.dwLowDateTime);
      int mine = same_user(h);
      printf(",\"mine\":%s", mine == 1 ? "true" : mine == 0 ? "false" : "null");
      wchar_t image[32768]; DWORD size = 32768;
      if (QueryFullProcessImageNameW(h, 0, image, &size)) { printf(",\"image\":"); json_utf8(image); }
      CloseHandle(h);
    } else printf(",\"mine\":null");
    printf(",\"name\":"); json_utf8(e.szExeFile);
    printf("}\n");
  }
  CloseHandle(snap);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// bridge

static const char *DAEMON_ENV[] = {"PATH", "PATHEXT", "SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "HOME",
  "AGENT_CHAT_ROOT", "AGENT_CHAT_STATE_ROOT", "AGENT_CHAT_DAEMON_IDLE_MS", NULL};
#define HELLO_REPLY_MS 20000

static wchar_t *key_path, *node_path, *daemon_path;
static char pipe_name[512], pipe_key[128];
static char *hello; static size_t hello_len;
static HANDLE sock = INVALID_HANDLE_VALUE;
static CRITICAL_SECTION lock;
static volatile LONG stdin_done;
static int last_out_newline = 1;

// The key file is one JSON line the daemon writes: {"pipe":"\\\\.\\pipe\\...","key":"<hex>"}.
static int json_field(const char *json, const char *name, char *out, size_t cap) {
  char pattern[64]; snprintf(pattern, sizeof pattern, "\"%s\":\"", name);
  const char *at = strstr(json, pattern);
  if (!at) return 0;
  at += strlen(pattern);
  size_t n = 0;
  for (; *at && *at != '"'; at++) {
    char c = *at;
    if (c == '\\') { at++; if (!*at) return 0; c = *at; }
    if (n + 1 >= cap) return 0;
    out[n++] = c;
  }
  out[n] = 0;
  return *at == '"';
}
static int read_key_file(void) {
  HANDLE f = CreateFileW(key_path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (f == INVALID_HANDLE_VALUE) return 0;
  char text[1024]; DWORD got = 0;
  BOOL ok = ReadFile(f, text, sizeof text - 1, &got, NULL);
  CloseHandle(f);
  if (!ok) return 0;
  text[got] = 0;
  return json_field(text, "pipe", pipe_name, sizeof pipe_name) && json_field(text, "key", pipe_key, sizeof pipe_key) &&
    strncmp(pipe_name, "\\\\.\\pipe\\", 9) == 0;
}

static void build_hello(void) {
  wchar_t cwd[32768];
  if (!GetCurrentDirectoryW(32768, cwd)) die("cannot read the current folder");
  char *cwd8 = utf8(cwd), number[32];
  buf_t b = {0};
  buf_str(&b, "{\"v\":1,\"pid\":"); snprintf(number, sizeof number, "%lu", GetCurrentProcessId()); buf_str(&b, number);
  // The parent PID: Toolhelp is the documented way to read it.
  DWORD ppid = 0;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W e; e.dwSize = sizeof e;
    for (BOOL ok = Process32FirstW(snap, &e); ok; ok = Process32NextW(snap, &e)) if (e.th32ProcessID == GetCurrentProcessId()) { ppid = e.th32ParentProcessID; break; }
    CloseHandle(snap);
  }
  if (!ppid) die("cannot read the parent process");
  buf_str(&b, ",\"ppid\":"); snprintf(number, sizeof number, "%lu", ppid); buf_str(&b, number);
  buf_str(&b, ",\"cwd\":"); buf_json(&b, cwd8);
  buf_str(&b, ",\"key\":\"@KEY@\",\"env\":{");
  int first = 1;
  for (const char **key = HELLO_ENV; *key; key++) {
    wchar_t *name = wide(*key), value[32768];
    DWORD n = GetEnvironmentVariableW(name, value, 32768);
    free(name);
    if (!n || n >= 32768) continue;
    char *value8 = utf8(value);
    if (!first) buf_str(&b, ",");
    first = 0;
    buf_json(&b, *key); buf_str(&b, ":"); buf_json(&b, value8);
    free(value8);
  }
  buf_str(&b, "}}\n");
  free(cwd8);
  hello = b.data; hello_len = b.len;
}

// The hello with this daemon's key in place of @KEY@ (the key is hex, so it needs no quoting).
static buf_t keyed_hello(void) {
  buf_t b = {0};
  const char *at = strstr(hello, "@KEY@");
  buf_add(&b, hello, (size_t)(at - hello)); buf_str(&b, pipe_key); buf_str(&b, at + 5);
  return b;
}

// Overlapped I/O on the pipe: one read from the main thread and one write from the stdin thread
// can be in flight on the same handle.
static int pipe_write(HANDLE h, const char *data, size_t len) {
  OVERLAPPED o; ZeroMemory(&o, sizeof o);
  o.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  int result = 0;
  while (len && !result) {
    DWORD n = 0;
    ResetEvent(o.hEvent);
    if (!WriteFile(h, data, (DWORD)(len > 65536 ? 65536 : len), NULL, &o) && GetLastError() != ERROR_IO_PENDING) result = -1;
    else if (!GetOverlappedResult(h, &o, &n, TRUE)) result = -1;
    else { data += n; len -= n; }
  }
  CloseHandle(o.hEvent);
  return result;
}
// Reads up to cap bytes, waiting at most wait_ms (INFINITE for no limit). Returns bytes read,
// 0 on timeout, -1 when the pipe is closed or broken.
static int pipe_read(HANDLE h, char *buf, DWORD cap, DWORD wait_ms, HANDLE event) {
  OVERLAPPED o; ZeroMemory(&o, sizeof o); o.hEvent = event; ResetEvent(event);
  DWORD n = 0;
  if (!ReadFile(h, buf, cap, NULL, &o)) {
    DWORD error = GetLastError();
    if (error == ERROR_MORE_DATA) { GetOverlappedResult(h, &o, &n, TRUE); return (int)n; }
    if (error != ERROR_IO_PENDING) return -1;
    if (WaitForSingleObject(event, wait_ms) == WAIT_TIMEOUT) {
      CancelIoEx(h, &o);
      if (!GetOverlappedResult(h, &o, &n, TRUE)) return GetLastError() == ERROR_OPERATION_ABORTED ? 0 : -1;
      return (int)n;
    }
  }
  if (!GetOverlappedResult(h, &o, &n, TRUE)) return GetLastError() == ERROR_MORE_DATA ? (int)n : -1;
  return n ? (int)n : -1;
}

static HANDLE try_connect(void) {
  if (!read_key_file()) return INVALID_HANDLE_VALUE;
  wchar_t *name = wide(pipe_name);
  HANDLE h = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
  if (h == INVALID_HANDLE_VALUE && GetLastError() == ERROR_PIPE_BUSY && WaitNamedPipeW(name, 2000))
    h = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
  free(name);
  if (h == INVALID_HANDLE_VALUE) return h;
  // Another user could have taken the name first; only a daemon running as this user is trusted.
  ULONG server = 0; int mine = 0;
  if (GetNamedPipeServerProcessId(h, &server)) {
    HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, server);
    if (p) { mine = same_user(p) == 1; CloseHandle(p); }
  }
  if (!mine) { CloseHandle(h); die("the agent-chat pipe belongs to another user"); }
  return h;
}

static void quote_arg(buf_t *b, const char *arg) {
  // CommandLineToArgvW rules: backslashes double only before a quote.
  buf_add(b, "\"", 1);
  for (const char *p = arg; ; p++) {
    size_t slashes = 0;
    while (*p == '\\') { slashes++; p++; }
    if (!*p) { for (size_t i = 0; i < slashes * 2; i++) buf_add(b, "\\", 1); break; }
    if (*p == '"') { for (size_t i = 0; i < slashes * 2 + 1; i++) buf_add(b, "\\", 1); buf_add(b, "\"", 1); }
    else { for (size_t i = 0; i < slashes; i++) buf_add(b, "\\", 1); buf_add(b, p, 1); }
  }
  buf_add(b, "\"", 1);
}

static void spawn_daemon(void) {
  // The environment block: only DAEMON_ENV, sorted as Windows expects (they are written in order
  // of the list, and CreateProcess accepts an unsorted block; Node reads it either way).
  wchar_t block[32768]; size_t used = 0;
  for (const char **key = DAEMON_ENV; *key; key++) {
    wchar_t *name = wide(*key), value[8192];
    DWORD n = GetEnvironmentVariableW(name, value, 8192);
    if (n && n < 8192) {
      size_t need = wcslen(name) + 1 + n + 1;
      if (used + need + 1 < 32768) { used += swprintf(block + used, 32768 - used, L"%ls=%ls", name, value) + 1; }
    }
    free(name);
  }
  block[used] = 0;
  char *node8 = utf8(node_path), *daemon8 = utf8(daemon_path), *key8 = utf8(key_path);
  buf_t line = {0};
  quote_arg(&line, node8); buf_add(&line, " ", 1); quote_arg(&line, daemon8); buf_add(&line, " ", 1); quote_arg(&line, key8);
  wchar_t *command = wide(line.data);
  wchar_t system_dir[MAX_PATH]; GetSystemDirectoryW(system_dir, MAX_PATH);
  STARTUPINFOW si; ZeroMemory(&si, sizeof si); si.cb = sizeof si;
  PROCESS_INFORMATION pi;
  DWORD flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
  // Out of the tab's job if Windows allows it, so closing this tab doesn't end every tab's daemon.
  BOOL ok = CreateProcessW(node_path, command, NULL, NULL, FALSE, flags | CREATE_BREAKAWAY_FROM_JOB, block, system_dir, &si, &pi);
  if (!ok && GetLastError() == ERROR_ACCESS_DENIED) ok = CreateProcessW(node_path, command, NULL, NULL, FALSE, flags, block, system_dir, &si, &pi);
  if (ok) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
  free(node8); free(daemon8); free(key8); free(line.data); free(command);
}

// Connects, starting the daemon when nothing answers, and completes the hello. A refusal from the
// daemon is final: its text goes to stderr.
static HANDLE open_daemon(int wait_ms) {
  int spawned = 0;
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
  for (int waited = 0; ; waited += 50) {
    HANDLE h = try_connect();
    if (h != INVALID_HANDLE_VALUE) {
      buf_t message = keyed_hello();
      int sent = pipe_write(h, message.data, message.len) == 0;
      free(message.data);
      if (sent) {
        char reply[8192]; size_t got = 0;
        ULONGLONG deadline = GetTickCount64() + HELLO_REPLY_MS;
        while (got < sizeof reply - 1) {
          ULONGLONG now = GetTickCount64();
          if (now >= deadline) { CloseHandle(h); CloseHandle(event); return INVALID_HANDLE_VALUE; }
          int n = pipe_read(h, reply + got, 1, (DWORD)(deadline - now), event);
          if (n == 0) continue;
          if (n < 0) break;
          got++;
          if (reply[got - 1] == '\n') break;
        }
        reply[got] = 0;
        if (got && strncmp(reply, "{\"ok\":true}", 11) == 0) { CloseHandle(event); return h; }
        if (strncmp(reply, "{\"error\":", 9) == 0) {
          char *text = reply + 10, *end = strrchr(text, '"');
          if (end) *end = 0;
          json_unescape(text);
          fprintf(stderr, "%s\n", text);
          exit(1);
        }
      }
      CloseHandle(h); // A daemon that closed mid-hello (stopping): try again.
    }
    if (!spawned) { spawn_daemon(); spawned = 1; }
    if (waited >= wait_ms) { CloseHandle(event); return INVALID_HANDLE_VALUE; }
    Sleep(50);
  }
}

// Tab -> daemon. Only whole lines go to the daemon, so a reconnect never splits a request.
static DWORD WINAPI stdin_thread(LPVOID unused) {
  (void)unused;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  buf_t pending_in = {0};
  static char chunk[65536]; // Static: this thread's stack is small, and only it uses the buffer.
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(in, chunk, sizeof chunk, &n, NULL) || n == 0) break;
    buf_add(&pending_in, chunk, n);
    char *newline = last_newline(pending_in.data, pending_in.len);
    if (!newline) continue;
    size_t whole = (size_t)(newline - pending_in.data) + 1;
    EnterCriticalSection(&lock);
    // Tracked before the write: a call that never reaches the daemon fails at the reconnect too.
    track(pending_in.data, whole, 1);
    pipe_write(sock, pending_in.data, whole); // A failed write: the reader notices and reconnects.
    LeaveCriticalSection(&lock);
    memmove(pending_in.data, pending_in.data + whole, pending_in.len - whole); pending_in.len -= whole;
  }
  // The tab closed its side. Pass on a last partial line; the main thread finishes once the
  // daemon has answered what is in flight.
  EnterCriticalSection(&lock);
  if (pending_in.len) { buf_add(&pending_in, "\n", 1); track(pending_in.data, pending_in.len, 1); pipe_write(sock, pending_in.data, pending_in.len); }
  LeaveCriticalSection(&lock);
  InterlockedExchange(&stdin_done, 1);
  return 0;
}

static int cmd_bridge(wchar_t *key, wchar_t *node, wchar_t *daemon) {
  key_path = key; node_path = node; daemon_path = daemon;
  build_hello();
  InitializeCriticalSection(&lock);
  sock = open_daemon(15000);
  if (sock == INVALID_HANDLE_VALUE) die("the shared daemon did not start");
  HANDLE reader = CreateThread(NULL, 64 * 1024, stdin_thread, NULL, STACK_SIZE_PARAM_IS_A_RESERVATION, NULL);
  if (!reader) die("cannot start the input thread");
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
  buf_t out = {0};
  char chunk[65536];
  ULONGLONG window = GetTickCount64(); int reconnects = 0;
  ULONGLONG drain_deadline = 0;
  for (;;) {
    if (stdin_done) {
      EnterCriticalSection(&lock); size_t open_calls = pending.len; LeaveCriticalSection(&lock);
      if (!drain_deadline) drain_deadline = GetTickCount64() + 30000;
      if (!open_calls || GetTickCount64() > drain_deadline) return 0;
    }
    int n = pipe_read(sock, chunk, sizeof chunk, 200, event);
    if (n == 0) continue;
    if (n > 0) {
      if (out_write(chunk, (size_t)n) != 0) return 0;
      last_out_newline = chunk[n - 1] == '\n';
      buf_add(&out, chunk, (size_t)n);
      char *newline = last_newline(out.data, out.len);
      if (newline) {
        size_t whole = (size_t)(newline - out.data) + 1;
        EnterCriticalSection(&lock); track(out.data, whole, 0); LeaveCriticalSection(&lock);
        memmove(out.data, out.data + whole, out.len - whole); out.len -= whole;
      }
      continue;
    }
    // The daemon went away. At most five reconnects a minute: a daemon that keeps failing ends here.
    EnterCriticalSection(&lock);
    CloseHandle(sock); sock = INVALID_HANDLE_VALUE;
    if (GetTickCount64() - window > 60000) { window = GetTickCount64(); reconnects = 0; }
    if (!last_out_newline) { out_write("\n", 1); last_out_newline = 1; }
    out.len = 0;
    fail_pending();
    if (stdin_done) { LeaveCriticalSection(&lock); return 0; }
    if (++reconnects > 5) die("the shared daemon keeps failing");
    sock = open_daemon(15000);
    LeaveCriticalSection(&lock);
    if (sock == INVALID_HANDLE_VALUE) die("the shared daemon did not restart");
  }
}

// ---------------------------------------------------------------------------------------------
// wake

static wchar_t wake_dir[32768], mark_path[32800], ring_path[32800];
static DWORD claude_pid, me;

static int env_is(const wchar_t *name, const wchar_t *value) {
  wchar_t got[256]; DWORD n = GetEnvironmentVariableW(name, got, 256);
  return n && n < 256 && wcscmp(got, value) == 0;
}
static int env_starts(const wchar_t *name, const wchar_t *prefix) {
  wchar_t got[256]; DWORD n = GetEnvironmentVariableW(name, got, 256);
  return n && n < 256 && wcsncmp(got, prefix, wcslen(prefix)) == 0;
}

// Reads a whole small file as UTF-8 text, or NULL.
static char *read_small(const wchar_t *file) {
  HANDLE f = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (f == INVALID_HANDLE_VALUE) return NULL;
  char *text = malloc(65537); DWORD got = 0;
  if (!text || !ReadFile(f, text, 65536, &got, NULL)) { CloseHandle(f); free(text); return NULL; }
  CloseHandle(f); text[got] = 0;
  return text;
}
static DWORD mark_waiter(void) {
  char *text = read_small(mark_path);
  if (!text) return 0;
  char *at = strstr(text, "\"waiter\":");
  DWORD waiter = at ? strtoul(at + 9, NULL, 10) : 0;
  free(text);
  return waiter;
}
static void release_mark(void) { if (mark_waiter() == me) DeleteFileW(mark_path); }

static void wake_pipe_name(wchar_t *out, size_t cap, DWORD pid, DWORD waiter) {
  swprintf(out, cap, L"\\\\.\\pipe\\agent-chat-wake-%lu-%lu", pid, waiter);
}

// Writes the mark atomically: {"waiter":me,"event":null,"at":<ms>,"pipe":"<name>"}.
static int write_mark(const wchar_t *pipe) {
  wchar_t temp[32900]; swprintf(temp, 32900, L"%ls.%lu.tmp", mark_path, me);
  HANDLE f = CreateFileW(temp, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (f == INVALID_HANDLE_VALUE) return 0;
  FILETIME now; GetSystemTimeAsFileTime(&now);
  unsigned long long ms = ((((unsigned long long)now.dwHighDateTime << 32) | now.dwLowDateTime) - 116444736000000000ULL) / 10000ULL;
  char *pipe8 = utf8(pipe); buf_t b = {0}; char head[128];
  snprintf(head, sizeof head, "{\"waiter\":%lu,\"event\":null,\"at\":%llu,\"pipe\":", me, ms);
  buf_str(&b, head); buf_json(&b, pipe8); buf_str(&b, "}\n");
  int ok = write_handle(f, b.data, b.len) == 0;
  CloseHandle(f); free(pipe8); free(b.data);
  if (ok) ok = MoveFileExW(temp, mark_path, MOVEFILE_REPLACE_EXISTING);
  if (!ok) DeleteFileW(temp);
  return ok;
}

// Claims the ring by renaming it and returns its first line (the wake text), or NULL.
static char *take_ring(void) {
  wchar_t taken[32900]; swprintf(taken, 32900, L"%ls\\taken-%lu-%lu", wake_dir, claude_pid, me);
  if (!MoveFileExW(ring_path, taken, MOVEFILE_REPLACE_EXISTING)) return NULL;
  char *text = read_small(taken);
  DeleteFileW(taken);
  if (!text) return NULL;
  char *newline = strchr(text, '\n');
  if (newline) *newline = 0;
  if (!*text) { free(text); return NULL; }
  return text;
}

static int make_dirs(wchar_t *path) {
  // Creates every missing folder on the way; returns 1 when the last one was created here.
  DWORD attributes = GetFileAttributesW(path);
  if (attributes != INVALID_FILE_ATTRIBUTES) return 0;
  wchar_t *slash = wcsrchr(path, L'\\');
  if (slash && slash > path + 2) { *slash = 0; make_dirs(path); *slash = L'\\'; }
  return CreateDirectoryW(path, NULL) ? 1 : 0;
}

static int cmd_wake(void) {
  // Windows always wakes through this hook (wake-ring.mjs wakeMode), so AGENT_CHAT_WAKE is not checked.
  wchar_t number[32]; DWORD n = GetEnvironmentVariableW(L"CLAUDE_PID", number, 32);
  if (!n || n >= 32) return 0;
  for (wchar_t *p = number; *p; p++) if (*p < L'0' || *p > L'9') return 0;
  claude_pid = wcstoul(number, NULL, 10);
  // Only an interactive session can be woken; `claude -p` waits for its hooks before it exits.
  if (env_starts(L"CLAUDE_CODE_ENTRYPOINT", L"sdk") || env_is(L"CLAUDE_CODE_SESSION_ATTENDED", L"0")) return 0;
  HANDLE claude = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, claude_pid);
  if (!claude || WaitForSingleObject(claude, 0) != WAIT_TIMEOUT || same_user(claude) != 1) return 0;
  me = GetCurrentProcessId();

  n = GetEnvironmentVariableW(L"AGENT_CHAT_WAKE_DIR", wake_dir, 32768);
  if (!n || n >= 32768) {
    wchar_t state[32768]; n = GetEnvironmentVariableW(L"AGENT_CHAT_STATE_ROOT", state, 32768);
    if (n && n < 32768) swprintf(wake_dir, 32768, L"%ls\\wake", state);
    else {
      n = GetEnvironmentVariableW(L"USERPROFILE", state, 32768);
      if (!n || n >= 32768) return 0;
      swprintf(wake_dir, 32768, L"%ls\\.local\\state\\agent-chat\\wake", state);
    }
  }
  for (wchar_t *p = wake_dir; *p; p++) if (*p == L'/') *p = L'\\';
  if (make_dirs(wake_dir)) acl_lock(wake_dir);
  if (acl_private(wake_dir) != 1) return 0;
  swprintf(mark_path, 32800, L"%ls\\armed-%lu.json", wake_dir, claude_pid);
  swprintf(ring_path, 32800, L"%ls\\ring-%lu", wake_dir, claude_pid);

  wchar_t pipe[128]; wake_pipe_name(pipe, 128, claude_pid, me);
  HANDLE server = CreateNamedPipeW(pipe, PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 0, 512, 0, private_pipe_sa());
  if (server == INVALID_HANDLE_VALUE) return 0;

  // Newest waiter wins: take over the mark, then tell the previous waiter to look (it sees the
  // mark isn't its own and leaves).
  DWORD old = mark_waiter();
  if (!write_mark(pipe)) return 0;
  if (old && old != me) {
    wchar_t old_pipe[128]; wake_pipe_name(old_pipe, 128, claude_pid, old);
    HANDLE poke = CreateFileW(old_pipe, GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (poke != INVALID_HANDLE_VALUE) { DWORD w; WriteFile(poke, "\n", 1, &w, NULL); CloseHandle(poke); }
  }

  HANDLE connected = CreateEventW(NULL, TRUE, FALSE, NULL);
  for (;;) {
    if (mark_waiter() != me) return 0;
    char *text = take_ring();
    if (text) {
      release_mark();
      fprintf(stderr, "%s\n", text); fflush(stderr);
      return 2;
    }
    // Blocks with no CPU until a ring arrives or Claude exits.
    OVERLAPPED o; ZeroMemory(&o, sizeof o); o.hEvent = connected; ResetEvent(connected);
    BOOL now = ConnectNamedPipe(server, &o);
    DWORD error = now ? ERROR_PIPE_CONNECTED : GetLastError();
    if (error == ERROR_IO_PENDING) {
      // A ring written after the check above found the pipe not yet listening; look once more.
      text = take_ring();
      if (text) {
        CancelIoEx(server, &o); DWORD unused; GetOverlappedResult(server, &o, &unused, TRUE);
        release_mark();
        fprintf(stderr, "%s\n", text); fflush(stderr);
        return 2;
      }
      HANDLE waits[2] = {connected, claude};
      DWORD which = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
      if (which != WAIT_OBJECT_0) { CancelIoEx(server, &o); release_mark(); return 0; }
      DWORD unused; if (!GetOverlappedResult(server, &o, &unused, FALSE)) { DisconnectNamedPipe(server); continue; }
    } else if (error != ERROR_PIPE_CONNECTED) { release_mark(); return 0; }
    char drain[512]; DWORD got;
    OVERLAPPED r; ZeroMemory(&r, sizeof r); r.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (ReadFile(server, drain, sizeof drain, NULL, &r) || GetLastError() == ERROR_IO_PENDING) {
      if (WaitForSingleObject(r.hEvent, 1000) == WAIT_TIMEOUT) CancelIoEx(server, &r);
      GetOverlappedResult(server, &r, &got, TRUE);
    }
    CloseHandle(r.hEvent);
    DisconnectNamedPipe(server);
    if (WaitForSingleObject(claude, 0) != WAIT_TIMEOUT) { release_mark(); return 0; }
  }
}

// ---------------------------------------------------------------------------------------------

int wmain(int argc, wchar_t **argv) {
  out_handle = GetStdHandle(STD_OUTPUT_HANDLE);
  if (argc >= 2 && wcscmp(argv[1], L"wake") == 0) return cmd_wake();
  if (argc == 5 && wcscmp(argv[1], L"bridge") == 0) return cmd_bridge(argv[2], argv[3], argv[4]);
  if (argc >= 3 && wcscmp(argv[1], L"ps") == 0) return cmd_ps(argc - 2, argv + 2);
  if (argc == 3 && wcscmp(argv[1], L"acl-check") == 0) return cmd_acl(0, argv[2]);
  if (argc == 3 && wcscmp(argv[1], L"acl-lock") == 0) return cmd_acl(1, argv[2]);
  fprintf(stderr, "usage: agent-chat-win bridge <keyfile> <node> <daemon.mjs> | wake | ps <pid>... | ps --all | acl-check <dir> | acl-lock <dir>\n");
  return 64;
}
