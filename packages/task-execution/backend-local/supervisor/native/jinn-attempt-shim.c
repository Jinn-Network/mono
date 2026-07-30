// SPDX-License-Identifier: Apache-2.0
/* Linux attempt custodian.  This dependency-free helper owns waitpid rights. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_SPEC_BYTES (1024 * 1024)
#define MAX_SPEC_ITEMS 512

typedef struct {
  char *attempt, *nonce, *nonce_identity, *meta, *secrets, *cwd, *stdout_path, *stderr_path;
  char **argv, **env;
  size_t argc, envc;
  uint32_t heartbeat_ms;
} spawn_spec;

typedef struct { pid_t *items; size_t count, capacity; } pid_list;

static volatile sig_atomic_t cancellation_wakeup;
static void on_control_signal(int ignored) { (void)ignored; cancellation_wakeup = 1; }

static void fatal(const char *message) { dprintf(STDERR_FILENO, "jinn-attempt-shim: %s\n", message); _exit(78); }

static uint32_t read_u32(const unsigned char **cursor, const unsigned char *end) {
  if (*cursor + 4 > end) return UINT32_MAX;
  uint32_t value = (uint32_t)(*cursor)[0] | ((uint32_t)(*cursor)[1] << 8) |
    ((uint32_t)(*cursor)[2] << 16) | ((uint32_t)(*cursor)[3] << 24);
  *cursor += 4; return value;
}

static char *read_string(const unsigned char **cursor, const unsigned char *end) {
  uint32_t size = read_u32(cursor, end);
  if (size == UINT32_MAX || size > MAX_SPEC_BYTES || *cursor + size > end) return NULL;
  char *value = calloc((size_t)size + 1, 1);
  if (value == NULL) return NULL;
  memcpy(value, *cursor, size); *cursor += size; return value;
}

static int parse_spec(const char *path, spawn_spec *spec) {
  int fd = open(path, O_RDONLY); struct stat statbuf;
  if (fd < 0 || fstat(fd, &statbuf) != 0 || statbuf.st_size < 5 || statbuf.st_size > MAX_SPEC_BYTES) return -1;
  unsigned char *bytes = malloc((size_t)statbuf.st_size); if (bytes == NULL) { close(fd); return -1; }
  for (size_t offset = 0; offset < (size_t)statbuf.st_size;) { ssize_t read_count = read(fd, bytes + offset, (size_t)statbuf.st_size - offset); if (read_count <= 0) { free(bytes); close(fd); return -1; } offset += (size_t)read_count; }
  close(fd); const unsigned char *cursor = bytes, *end = bytes + statbuf.st_size;
  if (memcmp(cursor, "JNSP1", 5) != 0) { free(bytes); return -1; } cursor += 5;
  spec->attempt = read_string(&cursor, end); spec->nonce = read_string(&cursor, end); spec->nonce_identity = read_string(&cursor, end);
  spec->meta = read_string(&cursor, end); spec->secrets = read_string(&cursor, end);
  spec->cwd = read_string(&cursor, end); spec->stdout_path = read_string(&cursor, end); spec->stderr_path = read_string(&cursor, end);
  spec->heartbeat_ms = read_u32(&cursor, end); uint32_t argc = read_u32(&cursor, end);
  if (!spec->attempt || !spec->nonce || !spec->nonce_identity || !spec->meta || !spec->secrets || !spec->cwd || argc == 0 || argc > MAX_SPEC_ITEMS) { free(bytes); return -1; }
  spec->argv = calloc((size_t)argc + 1, sizeof(char *)); spec->argc = argc;
  for (uint32_t index = 0; index < argc; index++) if ((spec->argv[index] = read_string(&cursor, end)) == NULL) { free(bytes); return -1; }
  uint32_t envc = read_u32(&cursor, end); if (envc > MAX_SPEC_ITEMS) { free(bytes); return -1; }
  spec->env = calloc((size_t)envc + 4, sizeof(char *)); spec->envc = envc;
  for (uint32_t index = 0; index < envc; index++) if ((spec->env[index] = read_string(&cursor, end)) == NULL) { free(bytes); return -1; }
  int valid = cursor == end; free(bytes); return valid ? 0 : -1;
}

static void free_spec(spawn_spec *spec) {
  for (size_t i = 0; i < spec->argc; i++) free(spec->argv[i]);
  for (size_t i = 0; i < spec->envc; i++) free(spec->env[i]);
  free(spec->argv); free(spec->env); free(spec->attempt); free(spec->nonce); free(spec->nonce_identity); free(spec->meta); free(spec->secrets); free(spec->cwd); free(spec->stdout_path); free(spec->stderr_path);
}

/* A forward is an env reference to an owned file, never a request to copy secret bytes into env. */
static int portable_secret_target(const char *target) {
  if (*target == 0 || strcmp(target, ".") == 0 || strcmp(target, "..") == 0) return 0;
  for (const unsigned char *cursor = (const unsigned char *)target; *cursor; cursor++) {
    if (!( (*cursor >= 'a' && *cursor <= 'z') || (*cursor >= 'A' && *cursor <= 'Z') || (*cursor >= '0' && *cursor <= '9') || *cursor == '.' || *cursor == '_' || *cursor == '-')) return 0;
  }
  return 1;
}

static int resolve_secret_references(spawn_spec *spec) {
  char root[PATH_MAX];
  if (realpath(spec->secrets, root) == NULL) return -1;
  for (size_t index = 0; index < spec->envc; index++) {
    char *equals = strchr(spec->env[index], '=');
    if (equals == NULL) return -1;
    const char *value = equals + 1;
    if (strncmp(value, "secrets/", 8) != 0) continue;
    const char *target = value + 8;
    if (!portable_secret_target(target)) return -1;
    char candidate[PATH_MAX], verified[PATH_MAX]; struct stat entry;
    if (snprintf(candidate, sizeof(candidate), "%s/%s", root, target) >= (int)sizeof(candidate)
      || lstat(candidate, &entry) != 0 || !S_ISREG(entry.st_mode) || S_ISLNK(entry.st_mode)
      || realpath(candidate, verified) == NULL) return -1;
    size_t root_length = strlen(root);
    if (strncmp(verified, root, root_length) != 0 || verified[root_length] != '/') return -1;
    size_t key_length = (size_t)(equals - spec->env[index]);
    char *replacement = malloc(key_length + 1 + strlen(verified) + 1);
    if (replacement == NULL) return -1;
    memcpy(replacement, spec->env[index], key_length); replacement[key_length] = '=';
    strcpy(replacement + key_length + 1, verified);
    free(spec->env[index]); spec->env[index] = replacement;
  }
  return 0;
}

static void atomic_write(const char *path, const char *text) {
  char temporary[4096], directory[4096]; snprintf(temporary, sizeof(temporary), "%s.tmp-%ld", path, (long)getpid());
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0600); if (fd < 0) fatal("cannot create durable temporary file");
  size_t length = strlen(text); if (write(fd, text, length) != (ssize_t)length || fsync(fd) != 0) { close(fd); unlink(temporary); fatal("cannot fsync durable file"); }
  close(fd); if (rename(temporary, path) != 0) fatal("cannot rename durable file");
  snprintf(directory, sizeof(directory), "%s", path); char *slash = strrchr(directory, '/'); if (slash == NULL) fatal("durable path has no directory"); *slash = 0;
  fd = open(directory, O_RDONLY | O_DIRECTORY); if (fd < 0 || fsync(fd) != 0) { if (fd >= 0) close(fd); fatal("cannot fsync durable directory"); } close(fd);
}

static char *json_quote(const char *value) {
  size_t length = strlen(value), capacity = length * 6 + 3, offset = 0; char *out = malloc(capacity);
  if (out == NULL) {
    return NULL;
  }
  out[offset++] = '"';
  for (size_t index = 0; index < length; index++) {
    unsigned char byte = (unsigned char)value[index];
    if (byte == '"' || byte == '\\') { out[offset++] = '\\'; out[offset++] = (char)byte; }
    else if (byte == '\b') { memcpy(out + offset, "\\b", 2); offset += 2; }
    else if (byte == '\f') { memcpy(out + offset, "\\f", 2); offset += 2; }
    else if (byte == '\n') { memcpy(out + offset, "\\n", 2); offset += 2; }
    else if (byte == '\r') { memcpy(out + offset, "\\r", 2); offset += 2; }
    else if (byte == '\t') { memcpy(out + offset, "\\t", 2); offset += 2; }
    else if (byte < 0x20) { snprintf(out + offset, 7, "\\u%04x", byte); offset += 6; }
    else out[offset++] = (char)byte;
  }
  out[offset++] = '"'; out[offset] = 0; return out;
}

static long process_start_time(pid_t pid) {
  char path[64], stat_text[4096]; snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  int fd = open(path, O_RDONLY); if (fd < 0) return -1; ssize_t count = read(fd, stat_text, sizeof(stat_text) - 1); close(fd); if (count <= 0) return -1;
  stat_text[count] = 0; char *cursor = strrchr(stat_text, ')'); if (cursor == NULL) return -1; cursor += 2;
  for (int field = 3; field < 22; field++) { cursor = strchr(cursor, ' '); if (cursor == NULL) return -1; cursor++; }
  return strtol(cursor, NULL, 10);
}

static void pids_clear(pid_list *list) { free(list->items); list->items = NULL; list->count = list->capacity = 0; }
static int pids_add(pid_list *list, pid_t pid) { if (list->count == list->capacity) { size_t capacity = list->capacity == 0 ? 8 : list->capacity * 2; pid_t *grown = realloc(list->items, capacity * sizeof(pid_t)); if (grown == NULL) return -1; list->items = grown; list->capacity = capacity; } list->items[list->count++] = pid; return 0; }
static int compare_pid(const void *left, const void *right) { pid_t a = *(const pid_t *)left, b = *(const pid_t *)right; return (a > b) - (a < b); }

static pid_t process_parent(pid_t pid) {
  char path[64], stat_text[512], state = 0; long parent = 0, group = 0;
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid); int fd = open(path, O_RDONLY);
  if (fd < 0) {
    return -1;
  }
  ssize_t count = read(fd, stat_text, sizeof(stat_text) - 1);
  close(fd);
  if (count <= 0) {
    return -1;
  }
  stat_text[count] = 0;
  char *after_name = strrchr(stat_text, ')');
  if (after_name == NULL || sscanf(after_name + 2, "%c %ld %ld", &state, &parent, &group) != 3) return -1;
  return (pid_t)parent;
}

/* Subreaper adoption means every escaped-session descendant is eventually below this shim. */
static int scan_custody(pid_t leader, pid_t shim, int include_leader, pid_list *out) {
  pids_clear(out); DIR *directory = opendir("/proc"); if (directory == NULL) return -1; struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    char *end = NULL; long numeric_pid = strtol(entry->d_name, &end, 10);
    if (end == NULL || *end != 0 || numeric_pid <= 0 || numeric_pid == shim) continue;
    pid_t cursor = (pid_t)numeric_pid; int owned = 0;
    for (int depth = 0; depth < 256; depth++) {
      if (cursor == leader || cursor == shim) { owned = 1; break; }
      pid_t parent = process_parent(cursor); if (parent <= 1 || parent == cursor) break; cursor = parent;
    }
    if (owned && (include_leader || numeric_pid != leader) && pids_add(out, (pid_t)numeric_pid) != 0) { closedir(directory); return -1; }
  }
  closedir(directory); qsort(out->items, out->count, sizeof(pid_t), compare_pid); return 0;
}

static int reap_exited_nonleaders(const pid_list *members) {
  int reaped = 0;
  for (size_t index = 0; index < members->count; index++) if (waitpid(members->items[index], NULL, WNOHANG) > 0) reaped++;
  return reaped;
}
static void signal_group(pid_t pgid, int signal_number) { if (kill(-pgid, signal_number) != 0 && errno != ESRCH) { } }
static void signal_members(const pid_list *members, int signal_number) { for (size_t index = 0; index < members->count; index++) if (kill(members->items[index], signal_number) != 0 && errno != ESRCH) { } }
static void sleep_ms(uint32_t milliseconds) { struct timespec delay = { .tv_sec = milliseconds / 1000, .tv_nsec = (long)(milliseconds % 1000) * 1000000L }; nanosleep(&delay, NULL); }
static uint64_t monotonic_ms(void) { struct timespec value; clock_gettime(CLOCK_MONOTONIC, &value); return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000; }

/* The residual vector is compiled only into the test helper, never the shipped custodian. */
#ifdef JINN_NATIVE_CUSTODY_TESTING
static int skip_kill_for_test(void) { return getenv("JINN_NATIVE_CUSTODY_TEST_SKIP_KILL") != NULL; }
#else
static int skip_kill_for_test(void) { return 0; }
#endif

static void format_rfc3339(char output[32]) { time_t now = time(NULL); struct tm utc; gmtime_r(&now, &utc); strftime(output, 32, "%Y-%m-%dT%H:%M:%SZ", &utc); }
static const char *signal_name(int value) { switch (value) { case SIGTERM: return "SIGTERM"; case SIGKILL: return "SIGKILL"; case SIGINT: return "SIGINT"; case SIGHUP: return "SIGHUP"; default: return strsignal(value); } }

/* Bounded JSON admission: no substring matching, no duplicate/unknown root members, and
 * nonce bytes stay length-delimited so embedded U+0000 cannot truncate identity checks. */
typedef struct { unsigned char *bytes; size_t length; } json_bytes;
typedef struct { const unsigned char *cursor, *end; } json_reader;
static int hex_value(unsigned char value) { if (value >= '0' && value <= '9') return value - '0'; if (value >= 'a' && value <= 'f') return value - 'a' + 10; if (value >= 'A' && value <= 'F') return value - 'A' + 10; return -1; }
static void json_bytes_clear(json_bytes *value) { free(value->bytes); value->bytes = NULL; value->length = 0; }
static int json_bytes_push(json_bytes *value, size_t *capacity, unsigned char byte) { if (value->length == *capacity) { size_t next = *capacity == 0 ? 32 : *capacity * 2; if (next > MAX_SPEC_BYTES) return -1; unsigned char *grown = realloc(value->bytes, next); if (grown == NULL) return -1; value->bytes = grown; *capacity = next; } value->bytes[value->length++] = byte; return 0; }
static int json_append_codepoint(json_bytes *value, size_t *capacity, uint32_t cp) { if (cp <= 0x7f) return json_bytes_push(value, capacity, (unsigned char)cp); if (cp <= 0x7ff) return json_bytes_push(value, capacity, (unsigned char)(0xc0 | (cp >> 6))) || json_bytes_push(value, capacity, (unsigned char)(0x80 | (cp & 0x3f))); if (cp <= 0xffff) return json_bytes_push(value, capacity, (unsigned char)(0xe0 | (cp >> 12))) || json_bytes_push(value, capacity, (unsigned char)(0x80 | ((cp >> 6) & 0x3f))) || json_bytes_push(value, capacity, (unsigned char)(0x80 | (cp & 0x3f))); return json_bytes_push(value, capacity, (unsigned char)(0xf0 | (cp >> 18))) || json_bytes_push(value, capacity, (unsigned char)(0x80 | ((cp >> 12) & 0x3f))) || json_bytes_push(value, capacity, (unsigned char)(0x80 | ((cp >> 6) & 0x3f))) || json_bytes_push(value, capacity, (unsigned char)(0x80 | (cp & 0x3f))); }
static int json_skip_ws(json_reader *reader) { while (reader->cursor < reader->end && (*reader->cursor == ' ' || *reader->cursor == '\n' || *reader->cursor == '\r' || *reader->cursor == '\t')) reader->cursor++; return reader->cursor < reader->end; }
static int json_read_u16(json_reader *reader, uint32_t *out) { if (reader->end - reader->cursor < 4) return -1; int a = hex_value(reader->cursor[0]), b = hex_value(reader->cursor[1]), c = hex_value(reader->cursor[2]), d = hex_value(reader->cursor[3]); if (a < 0 || b < 0 || c < 0 || d < 0) return -1; reader->cursor += 4; *out = (uint32_t)((a << 12) | (b << 8) | (c << 4) | d); return 0; }
static int json_read_utf8(json_reader *reader, json_bytes *out, size_t *capacity) { unsigned char lead = *reader->cursor++; uint32_t cp; int extra; if (lead < 0x80) return json_bytes_push(out, capacity, lead); if (lead >= 0xc2 && lead <= 0xdf) { cp = lead & 0x1f; extra = 1; } else if (lead >= 0xe0 && lead <= 0xef) { cp = lead & 0x0f; extra = 2; } else if (lead >= 0xf0 && lead <= 0xf4) { cp = lead & 0x07; extra = 3; } else return -1; if (reader->end - reader->cursor < extra) return -1; for (int index = 0; index < extra; index++) { unsigned char tail = *reader->cursor++; if ((tail & 0xc0) != 0x80) return -1; cp = (cp << 6) | (tail & 0x3f); } if ((extra == 1 && cp < 0x80) || (extra == 2 && cp < 0x800) || (extra == 3 && cp < 0x10000) || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return -1; return json_append_codepoint(out, capacity, cp); }
static int json_read_string(json_reader *reader, json_bytes *out) { size_t capacity = 0; if (reader->cursor >= reader->end || *reader->cursor++ != '"') return -1; while (reader->cursor < reader->end) { unsigned char byte = *reader->cursor; if (byte == '"') { reader->cursor++; return 0; } if (byte < 0x20) return -1; if (byte != '\\') { if (json_read_utf8(reader, out, &capacity) != 0) return -1; continue; } reader->cursor++; if (reader->cursor >= reader->end) return -1; byte = *reader->cursor++; if (byte == '"' || byte == '\\' || byte == '/') { if (json_bytes_push(out, &capacity, byte) != 0) return -1; } else if (byte == 'b') { if (json_bytes_push(out, &capacity, '\b') != 0) return -1; } else if (byte == 'f') { if (json_bytes_push(out, &capacity, '\f') != 0) return -1; } else if (byte == 'n') { if (json_bytes_push(out, &capacity, '\n') != 0) return -1; } else if (byte == 'r') { if (json_bytes_push(out, &capacity, '\r') != 0) return -1; } else if (byte == 't') { if (json_bytes_push(out, &capacity, '\t') != 0) return -1; } else if (byte == 'u') { uint32_t cp, low; if (json_read_u16(reader, &cp) != 0) return -1; if (cp >= 0xd800 && cp <= 0xdbff) { if (reader->end - reader->cursor < 6 || reader->cursor[0] != '\\' || reader->cursor[1] != 'u') return -1; reader->cursor += 2; if (json_read_u16(reader, &low) != 0 || low < 0xdc00 || low > 0xdfff) return -1; cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00); } else if (cp >= 0xdc00 && cp <= 0xdfff) return -1; if (json_append_codepoint(out, &capacity, cp) != 0) return -1; } else return -1; } return -1; }
static int json_read_nonnegative_integer(json_reader *reader, uint32_t *out) { uint64_t value = 0; if (reader->cursor >= reader->end || *reader->cursor < '0' || *reader->cursor > '9') return -1; if (*reader->cursor == '0') { reader->cursor++; if (reader->cursor < reader->end && *reader->cursor >= '0' && *reader->cursor <= '9') return -1; *out = 0; return 0; } while (reader->cursor < reader->end && *reader->cursor >= '0' && *reader->cursor <= '9') { value = value * 10 + (uint64_t)(*reader->cursor++ - '0'); if (value > INT32_MAX) return -1; } *out = (uint32_t)value; return 0; }
static int json_key_equals(const json_bytes *key, const char *literal) { size_t length = strlen(literal); return key->length == length && memcmp(key->bytes, literal, length) == 0; }
static int parse_cancellation_command(const unsigned char *json, size_t length, json_bytes *nonce, uint32_t *grace, uint32_t *ceiling) { json_reader reader = { .cursor = json, .end = json + length }; int got_nonce = 0, got_grace = 0, got_ceiling = 0; if (!json_skip_ws(&reader) || *reader.cursor++ != '{') return -1; if (!json_skip_ws(&reader)) return -1; while (reader.cursor < reader.end && *reader.cursor != '}') { json_bytes key = {0}; if (json_read_string(&reader, &key) != 0 || !json_skip_ws(&reader) || reader.cursor >= reader.end || *reader.cursor++ != ':' || !json_skip_ws(&reader)) { json_bytes_clear(&key); return -1; } int result = 0; if (json_key_equals(&key, "nonce")) { if (got_nonce || json_read_string(&reader, nonce) != 0) result = -1; else got_nonce = 1; } else if (json_key_equals(&key, "graceMs")) { if (got_grace || json_read_nonnegative_integer(&reader, grace) != 0) result = -1; else got_grace = 1; } else if (json_key_equals(&key, "killPollCeilingMs")) { if (got_ceiling || json_read_nonnegative_integer(&reader, ceiling) != 0) result = -1; else got_ceiling = 1; } else result = -1; json_bytes_clear(&key); if (result != 0 || !json_skip_ws(&reader)) return -1; if (*reader.cursor == ',') { reader.cursor++; if (!json_skip_ws(&reader) || *reader.cursor == '}') return -1; continue; } if (*reader.cursor != '}') return -1; } if (reader.cursor >= reader.end || *reader.cursor++ != '}') return -1; while (reader.cursor < reader.end && (*reader.cursor == ' ' || *reader.cursor == '\n' || *reader.cursor == '\r' || *reader.cursor == '\t')) reader.cursor++; if (reader.cursor != reader.end) return -1; return got_nonce && got_grace && got_ceiling ? 0 : -1; }

static int read_cancellation(const spawn_spec *spec, uint32_t *grace, uint32_t *ceiling) {
  char path[4096]; snprintf(path, sizeof(path), "%s/cancellation-command.json", spec->meta); int fd = open(path, O_RDONLY); struct stat statbuf; if (fd < 0 || fstat(fd, &statbuf) != 0 || statbuf.st_size <= 0 || statbuf.st_size > MAX_SPEC_BYTES) { if (fd >= 0) close(fd); return 0; }
  char *json = calloc((size_t)statbuf.st_size + 1, 1); if (json == NULL) { close(fd); return 0; } size_t offset = 0; while (offset < (size_t)statbuf.st_size) { ssize_t count = read(fd, json + offset, (size_t)statbuf.st_size - offset); if (count <= 0) { free(json); close(fd); return 0; } offset += (size_t)count; } close(fd);
  json_bytes requested_nonce = {0}, expected_nonce = {0}; uint32_t parsed_grace = 0, parsed_ceiling = 0;
  int valid = parse_cancellation_command((const unsigned char *)json, (size_t)statbuf.st_size, &requested_nonce, &parsed_grace, &parsed_ceiling) == 0;
  json_reader expected_reader = { .cursor = (const unsigned char *)spec->nonce, .end = (const unsigned char *)spec->nonce + strlen(spec->nonce) };
  if (valid && (json_read_string(&expected_reader, &expected_nonce) != 0 || expected_reader.cursor != expected_reader.end || requested_nonce.length != expected_nonce.length || memcmp(requested_nonce.bytes, expected_nonce.bytes, requested_nonce.length) != 0)) valid = 0;
  json_bytes_clear(&requested_nonce); json_bytes_clear(&expected_nonce); free(json);
  if (!valid) {
    return 0;
  }
  *grace = parsed_grace;
  *ceiling = parsed_ceiling;
  return 1;
}

static void write_pid_result(const spawn_spec *spec, const char *name, const pid_list *pids) {
  char path[4096]; size_t capacity = strlen(spec->nonce) + pids->count * 32 + 40, offset = 0; char *json = malloc(capacity); if (json == NULL) fatal("cannot encode cancellation result");
  offset = (size_t)snprintf(json, capacity, "{\"nonce\":%s,\"residualPids\":[", spec->nonce);
  for (size_t index = 0; index < pids->count; index++) offset += (size_t)snprintf(json + offset, capacity - offset, "%s%ld", index == 0 ? "" : ",", (long)pids->items[index]);
  snprintf(json + offset, capacity - offset, "]}"); snprintf(path, sizeof(path), "%s/%s", spec->meta, name); atomic_write(path, json); free(json);
}

static void write_heartbeat(const spawn_spec *spec) { char path[4096], json[256]; struct timespec mono; clock_gettime(CLOCK_MONOTONIC, &mono); snprintf(path, sizeof(path), "%s/heartbeat", spec->meta); snprintf(json, sizeof(json), "{\"monotonicMs\":\"%lld\",\"wallClock\":\"%lld\"}", (long long)mono.tv_sec * 1000 + mono.tv_nsec / 1000000, (long long)time(NULL)); atomic_write(path, json); }

static void bind_cgroup(pid_t child, const spawn_spec *spec, char state[16], char path[4096]) {
  snprintf(state, 16, "residual"); path[0] = 0; if (access("/sys/fs/cgroup", W_OK) != 0) return;
  char name[256], procs[4096], pid_text[64]; snprintf(name, sizeof(name), "jinn-%ld-%s", (long)child, spec->nonce);
  for (char *cursor = name; *cursor; cursor++) if (!((*cursor >= 'a' && *cursor <= 'z') || (*cursor >= 'A' && *cursor <= 'Z') || (*cursor >= '0' && *cursor <= '9') || *cursor == '-' || *cursor == '_')) *cursor = '_';
  snprintf(path, 4096, "/sys/fs/cgroup/%s", name); if (mkdir(path, 0755) != 0) { path[0] = 0; return; }
  snprintf(procs, sizeof(procs), "%s/cgroup.procs", path); int fd = open(procs, O_WRONLY); if (fd < 0) { rmdir(path); path[0] = 0; return; }
  int length = snprintf(pid_text, sizeof(pid_text), "%ld", (long)child); if (write(fd, pid_text, (size_t)length) != length) { close(fd); rmdir(path); path[0] = 0; return; }
  close(fd); snprintf(state, 16, "delegated");
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) { int ready = prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0; printf("{\"ready\":%s,\"subreaper\":%s}\n", ready ? "true" : "false", ready ? "true" : "false"); return ready ? 0 : 1; }
  if (argc != 2) fatal("missing binary spawn specification");
  spawn_spec spec = {0};
  if (parse_spec(argv[1], &spec) != 0) fatal("invalid binary spawn specification");
  if (resolve_secret_references(&spec) != 0) fatal("invalid secret forward reference");
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) fatal("PR_SET_CHILD_SUBREAPER unavailable");
  struct sigaction action = {0}; action.sa_handler = on_control_signal; sigaction(SIGUSR1, &action, NULL); sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGHUP, &action, NULL);
  char started_at[32]; format_rfc3339(started_at); int release_pipe[2]; if (pipe(release_pipe) != 0) fatal("custody release pipe failed"); pid_t leader = fork(); if (leader < 0) fatal("fork failed");
  if (leader == 0) { close(release_pipe[1]); setpgid(0, 0); char release; if (read(release_pipe[0], &release, 1) != 1) _exit(127); close(release_pipe[0]); if (chdir(spec.cwd) != 0) _exit(127); int stdout_fd = spec.stdout_path[0] ? open(spec.stdout_path, O_WRONLY | O_CREAT | O_APPEND, 0600) : open("/dev/null", O_WRONLY); int stderr_fd = spec.stderr_path[0] ? open(spec.stderr_path, O_WRONLY | O_CREAT | O_APPEND, 0600) : open("/dev/null", O_WRONLY); dup2(stdout_fd, STDOUT_FILENO); dup2(stderr_fd, STDERR_FILENO); size_t attempt_len = strlen(spec.attempt), nonce_len = strlen(spec.nonce_identity); char *identity = malloc(17 + attempt_len), *nonce = malloc(20 + nonce_len); if (identity == NULL || nonce == NULL) _exit(127); snprintf(identity, 17 + attempt_len, "JINN_ATTEMPT_ID=%s", spec.attempt); snprintf(nonce, 20 + nonce_len, "JINN_ATTEMPT_NONCE=%s", spec.nonce_identity); spec.env[spec.envc++] = identity; spec.env[spec.envc++] = nonce; execve(spec.argv[0], spec.argv, spec.env); _exit(127); }
  close(release_pipe[0]); setpgid(leader, leader); char cgroup_state[16], cgroup_path[4096]; bind_cgroup(leader, &spec, cgroup_state, cgroup_path); if (write(release_pipe[1], "R", 1) != 1) fatal("custody release failed"); close(release_pipe[1]);
  char path[4096]; size_t fingerprint_size = strlen(spec.nonce) + 144; char *fingerprint = malloc(fingerprint_size); if (fingerprint == NULL) fatal("cannot encode fingerprint"); snprintf(fingerprint, fingerprint_size, "{\"pid\":%ld,\"startTime\":%ld,\"nonce\":%s,\"harnessPid\":%ld,\"ready\":true}", (long)getpid(), process_start_time(getpid()), spec.nonce, (long)leader); snprintf(path, sizeof(path), "%s/shim.json", spec.meta); atomic_write(path, fingerprint); free(fingerprint);
  int cancellation_requested = 0, deadline_expired = 0, status = 0, adopted_reaped = 0; uint64_t cancellation_deadline = 0; pid_list nonleaders = {0};
  for (;;) { siginfo_t info = {0}; if (waitid(P_PID, leader, &info, WEXITED | WNOWAIT | WNOHANG) == 0 && info.si_pid != 0) break;
    if (cancellation_wakeup) { cancellation_wakeup = 0; uint32_t grace, ceiling; if (!cancellation_requested && read_cancellation(&spec, &grace, &ceiling)) { cancellation_requested = 1; uint64_t now = monotonic_ms(); cancellation_deadline = now + ceiling; if (scan_custody(leader, getpid(), 1, &nonleaders) != 0) fatal("cannot scan custody domain"); signal_group(leader, SIGTERM); signal_members(&nonleaders, SIGTERM); uint64_t term_until = now + grace; while (monotonic_ms() < term_until && monotonic_ms() < cancellation_deadline) sleep_ms(1); if (!skip_kill_for_test()) { if (scan_custody(leader, getpid(), 1, &nonleaders) != 0) fatal("cannot scan custody domain"); signal_group(leader, SIGKILL); signal_members(&nonleaders, SIGKILL); } } }
    if (cancellation_requested && monotonic_ms() >= cancellation_deadline) { deadline_expired = 1; break; }
    write_heartbeat(&spec); sleep_ms(spec.heartbeat_ms > 0 && spec.heartbeat_ms < 50 ? spec.heartbeat_ms : 5);
  }
  if (!cancellation_requested || !skip_kill_for_test()) signal_group(leader, SIGKILL);
  uint32_t ceiling = 30000, requested_grace = 0; (void)read_cancellation(&spec, &requested_grace, &ceiling); uint64_t cleanup_deadline = cancellation_requested ? cancellation_deadline : monotonic_ms() + ceiling;
  while (!deadline_expired && scan_custody(leader, getpid(), 0, &nonleaders) == 0 && nonleaders.count > 0 && monotonic_ms() < cleanup_deadline) { adopted_reaped += reap_exited_nonleaders(&nonleaders); if (!skip_kill_for_test()) { signal_group(leader, SIGKILL); signal_members(&nonleaders, SIGKILL); } sleep_ms(10); }
  if (scan_custody(leader, getpid(), deadline_expired, &nonleaders) != 0) fatal("cannot scan custody domain");
  int empty_before_leader_reap = nonleaders.count == 0;
  if (cancellation_requested) write_pid_result(&spec, "cancellation-result.json", &nonleaders);
  if (empty_before_leader_reap) { if (waitpid(leader, &status, 0) < 0) fatal("cannot reap harness leader"); }
  char finished_at[32], exit_json[32], signal_json[128], custody[8192]; format_rfc3339(finished_at);
  if (empty_before_leader_reap && WIFEXITED(status)) snprintf(exit_json, sizeof(exit_json), "%d", WEXITSTATUS(status)); else snprintf(exit_json, sizeof(exit_json), "null");
  if (empty_before_leader_reap && WIFSIGNALED(status)) snprintf(signal_json, sizeof(signal_json), "\"%s\"", signal_name(WTERMSIG(status))); else snprintf(signal_json, sizeof(signal_json), "null");
  char *quoted_attempt = json_quote(spec.attempt); if (quoted_attempt == NULL) fatal("cannot encode outcome"); size_t outcome_size = strlen(quoted_attempt) + strlen(spec.nonce) + strlen(exit_json) + strlen(signal_json) + 160; char *outcome = malloc(outcome_size); if (outcome == NULL) fatal("cannot encode outcome"); snprintf(outcome, outcome_size, "{\"attemptId\":%s,\"nonce\":%s,\"exitCode\":%s,\"termSignal\":%s,\"startedAt\":\"%s\",\"finishedAt\":\"%s\"}", quoted_attempt, spec.nonce, exit_json, signal_json, started_at, finished_at); snprintf(path, sizeof(path), "%s/outcome.json", spec.meta); atomic_write(path, outcome); free(outcome); free(quoted_attempt);
  snprintf(custody, sizeof(custody), "{\"subreaper\":true,\"cgroup\":\"%s\",\"leaderReapedAfterGroupEmpty\":%s,\"adoptedChildrenReaped\":%d,\"groupEmpty\":%s}", cgroup_state, empty_before_leader_reap ? "true" : "false", adopted_reaped, empty_before_leader_reap ? "true" : "false"); snprintf(path, sizeof(path), "%s/custody.json", spec.meta); atomic_write(path, custody);
  if (empty_before_leader_reap && cgroup_path[0]) rmdir(cgroup_path);
  pids_clear(&nonleaders); free_spec(&spec); return empty_before_leader_reap ? 0 : 1;
}
