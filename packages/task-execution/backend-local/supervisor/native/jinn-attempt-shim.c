// SPDX-License-Identifier: Apache-2.0
/* Linux attempt custodian.  This dependency-free helper owns waitpid rights. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
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
  char *attempt, *nonce, *meta, *secrets, *cwd, *stdout_path, *stderr_path;
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
  spec->attempt = read_string(&cursor, end); spec->nonce = read_string(&cursor, end);
  spec->meta = read_string(&cursor, end); spec->secrets = read_string(&cursor, end);
  spec->cwd = read_string(&cursor, end); spec->stdout_path = read_string(&cursor, end); spec->stderr_path = read_string(&cursor, end);
  spec->heartbeat_ms = read_u32(&cursor, end); uint32_t argc = read_u32(&cursor, end);
  if (!spec->attempt || !spec->nonce || !spec->meta || !spec->secrets || !spec->cwd || argc == 0 || argc > MAX_SPEC_ITEMS) { free(bytes); return -1; }
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
  free(spec->argv); free(spec->env); free(spec->attempt); free(spec->nonce); free(spec->meta); free(spec->secrets); free(spec->cwd); free(spec->stdout_path); free(spec->stderr_path);
}

static void atomic_write(const char *path, const char *text) {
  char temporary[4096], directory[4096]; snprintf(temporary, sizeof(temporary), "%s.tmp-%ld", path, (long)getpid());
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0600); if (fd < 0) fatal("cannot create durable temporary file");
  size_t length = strlen(text); if (write(fd, text, length) != (ssize_t)length || fsync(fd) != 0) { close(fd); unlink(temporary); fatal("cannot fsync durable file"); }
  close(fd); if (rename(temporary, path) != 0) fatal("cannot rename durable file");
  snprintf(directory, sizeof(directory), "%s", path); char *slash = strrchr(directory, '/'); if (slash == NULL) fatal("durable path has no directory"); *slash = 0;
  fd = open(directory, O_RDONLY | O_DIRECTORY); if (fd < 0 || fsync(fd) != 0) { if (fd >= 0) close(fd); fatal("cannot fsync durable directory"); } close(fd);
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

/* Exact `/proc` group scan. Excluding the leader is what makes zombie pinning observable. */
static int scan_group(pid_t pgid, int include_leader, pid_list *out) {
  pids_clear(out); DIR *directory = opendir("/proc"); if (directory == NULL) return -1; struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) { char *end = NULL; long numeric_pid = strtol(entry->d_name, &end, 10); if (end == NULL || *end != 0 || numeric_pid <= 0) continue;
    char path[64], stat_text[512], state = 0; long parent = 0, process_group = 0; snprintf(path, sizeof(path), "/proc/%ld/stat", numeric_pid);
    int fd = open(path, O_RDONLY); if (fd < 0) continue; ssize_t count = read(fd, stat_text, sizeof(stat_text) - 1); close(fd); if (count <= 0) continue;
    stat_text[count] = 0; char *after_name = strrchr(stat_text, ')'); if (after_name == NULL || sscanf(after_name + 2, "%c %ld %ld", &state, &parent, &process_group) != 3) continue;
    if (process_group == pgid && (include_leader || numeric_pid != pgid) && pids_add(out, (pid_t)numeric_pid) != 0) { closedir(directory); return -1; }
  }
  closedir(directory); qsort(out->items, out->count, sizeof(pid_t), compare_pid); return 0;
}

static int reap_exited_nonleaders(const pid_list *members) {
  int reaped = 0;
  for (size_t index = 0; index < members->count; index++) if (waitpid(members->items[index], NULL, WNOHANG) > 0) reaped++;
  return reaped;
}
static void signal_group(pid_t pgid, int signal_number) { if (kill(-pgid, signal_number) != 0 && errno != ESRCH) { } }
static void sleep_ms(uint32_t milliseconds) { struct timespec delay = { .tv_sec = milliseconds / 1000, .tv_nsec = (long)(milliseconds % 1000) * 1000000L }; nanosleep(&delay, NULL); }

static void format_rfc3339(char output[32]) { time_t now = time(NULL); struct tm utc; gmtime_r(&now, &utc); strftime(output, 32, "%Y-%m-%dT%H:%M:%SZ", &utc); }
static const char *signal_name(int value) { switch (value) { case SIGTERM: return "SIGTERM"; case SIGKILL: return "SIGKILL"; case SIGINT: return "SIGINT"; case SIGHUP: return "SIGHUP"; default: return strsignal(value); } }

static int json_string(const char *json, const char *key, char *output, size_t capacity) { char needle[128]; snprintf(needle, sizeof(needle), "\"%s\":\"", key); const char *start = strstr(json, needle); if (start == NULL) return 0; start += strlen(needle); const char *end = strchr(start, '"'); if (end == NULL || (size_t)(end - start) >= capacity) return 0; memcpy(output, start, (size_t)(end - start)); output[end - start] = 0; return 1; }
static long json_number(const char *json, const char *key) { char needle[128]; snprintf(needle, sizeof(needle), "\"%s\":", key); const char *value = strstr(json, needle); return value == NULL ? -1 : strtol(value + strlen(needle), NULL, 10); }

static int read_cancellation(const spawn_spec *spec, uint32_t *grace, uint32_t *ceiling) {
  char path[4096], json[1024], nonce[512]; snprintf(path, sizeof(path), "%s/cancellation-command.json", spec->meta); int fd = open(path, O_RDONLY); if (fd < 0) return 0;
  ssize_t count = read(fd, json, sizeof(json) - 1); close(fd); if (count <= 0) return 0; json[count] = 0;
  long grace_value = json_number(json, "graceMs"), ceiling_value = json_number(json, "killPollCeilingMs");
  if (!json_string(json, "nonce", nonce, sizeof(nonce)) || strcmp(nonce, spec->nonce) != 0 || grace_value < 0 || ceiling_value < 0 || grace_value > INT32_MAX || ceiling_value > INT32_MAX) return 0;
  *grace = (uint32_t)grace_value; *ceiling = (uint32_t)ceiling_value; return 1;
}

static void write_pid_result(const spawn_spec *spec, const char *name, const pid_list *pids) {
  char path[4096], json[8192]; size_t offset = (size_t)snprintf(json, sizeof(json), "{\"nonce\":\"%s\",\"residualPids\":[", spec->nonce);
  for (size_t index = 0; index < pids->count && offset + 32 < sizeof(json); index++) offset += (size_t)snprintf(json + offset, sizeof(json) - offset, "%s%ld", index == 0 ? "" : ",", (long)pids->items[index]);
  snprintf(json + offset, sizeof(json) - offset, "]}"); snprintf(path, sizeof(path), "%s/%s", spec->meta, name); atomic_write(path, json);
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
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) fatal("PR_SET_CHILD_SUBREAPER unavailable");
  struct sigaction action = {0}; action.sa_handler = on_control_signal; sigaction(SIGUSR1, &action, NULL); sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGHUP, &action, NULL);
  char started_at[32]; format_rfc3339(started_at); pid_t leader = fork(); if (leader < 0) fatal("fork failed");
  if (leader == 0) { setpgid(0, 0); if (chdir(spec.cwd) != 0) _exit(127); int stdout_fd = spec.stdout_path[0] ? open(spec.stdout_path, O_WRONLY | O_CREAT | O_APPEND, 0600) : open("/dev/null", O_WRONLY); int stderr_fd = spec.stderr_path[0] ? open(spec.stderr_path, O_WRONLY | O_CREAT | O_APPEND, 0600) : open("/dev/null", O_WRONLY); dup2(stdout_fd, STDOUT_FILENO); dup2(stderr_fd, STDERR_FILENO); char identity[1024], nonce[1024]; snprintf(identity, sizeof(identity), "JINN_ATTEMPT_ID=%s", spec.attempt); snprintf(nonce, sizeof(nonce), "JINN_ATTEMPT_NONCE=%s", spec.nonce); spec.env[spec.envc++] = strdup(identity); spec.env[spec.envc++] = strdup(nonce); execve(spec.argv[0], spec.argv, spec.env); _exit(127); }
  setpgid(leader, leader); char cgroup_state[16], cgroup_path[4096]; bind_cgroup(leader, &spec, cgroup_state, cgroup_path);
  char fingerprint[4096], path[4096]; snprintf(fingerprint, sizeof(fingerprint), "{\"pid\":%ld,\"startTime\":%ld,\"nonce\":\"%s\",\"harnessPid\":%ld}", (long)getpid(), process_start_time(getpid()), spec.nonce, (long)leader); snprintf(path, sizeof(path), "%s/shim.json", spec.meta); atomic_write(path, fingerprint);
  int cancellation_requested = 0, status = 0, adopted_reaped = 0; pid_list nonleaders = {0};
  for (;;) { siginfo_t info = {0}; if (waitid(P_PID, leader, &info, WEXITED | WNOWAIT | WNOHANG) == 0 && info.si_pid != 0) break;
    if (cancellation_wakeup) { cancellation_wakeup = 0; uint32_t grace, ceiling; if (!cancellation_requested && read_cancellation(&spec, &grace, &ceiling)) { cancellation_requested = 1; signal_group(leader, SIGTERM); sleep_ms(grace); if (getenv("JINN_NATIVE_CUSTODY_TEST_SKIP_KILL") == NULL) signal_group(leader, SIGKILL); (void)ceiling; } }
    write_heartbeat(&spec); sleep_ms(spec.heartbeat_ms > 0 && spec.heartbeat_ms < 50 ? spec.heartbeat_ms : 5);
  }
  if (!cancellation_requested || getenv("JINN_NATIVE_CUSTODY_TEST_SKIP_KILL") == NULL) signal_group(leader, SIGKILL);
  uint32_t ceiling = 30000, requested_grace = 0; (void)read_cancellation(&spec, &requested_grace, &ceiling); uint32_t elapsed = 0;
  while (scan_group(leader, 0, &nonleaders) == 0 && nonleaders.count > 0 && elapsed < ceiling) { adopted_reaped += reap_exited_nonleaders(&nonleaders); if (getenv("JINN_NATIVE_CUSTODY_TEST_SKIP_KILL") == NULL) signal_group(leader, SIGKILL); sleep_ms(10); elapsed += 10; }
  if (scan_group(leader, 0, &nonleaders) != 0) fatal("cannot scan harness process group");
  int empty_before_leader_reap = nonleaders.count == 0;
  if (cancellation_requested) write_pid_result(&spec, "cancellation-result.json", &nonleaders);
  if (empty_before_leader_reap) { if (waitpid(leader, &status, 0) < 0) fatal("cannot reap harness leader"); }
  char finished_at[32], exit_json[32], signal_json[128], outcome[8192], custody[8192]; format_rfc3339(finished_at);
  if (empty_before_leader_reap && WIFEXITED(status)) snprintf(exit_json, sizeof(exit_json), "%d", WEXITSTATUS(status)); else snprintf(exit_json, sizeof(exit_json), "null");
  if (empty_before_leader_reap && WIFSIGNALED(status)) snprintf(signal_json, sizeof(signal_json), "\"%s\"", signal_name(WTERMSIG(status))); else snprintf(signal_json, sizeof(signal_json), "null");
  snprintf(outcome, sizeof(outcome), "{\"attemptId\":\"%s\",\"nonce\":\"%s\",\"exitCode\":%s,\"termSignal\":%s,\"startedAt\":\"%s\",\"finishedAt\":\"%s\"}", spec.attempt, spec.nonce, exit_json, signal_json, started_at, finished_at); snprintf(path, sizeof(path), "%s/outcome.json", spec.meta); atomic_write(path, outcome);
  snprintf(custody, sizeof(custody), "{\"subreaper\":true,\"cgroup\":\"%s\",\"leaderReapedAfterGroupEmpty\":%s,\"adoptedChildrenReaped\":%d,\"groupEmpty\":%s}", cgroup_state, empty_before_leader_reap ? "true" : "false", adopted_reaped, empty_before_leader_reap ? "true" : "false"); snprintf(path, sizeof(path), "%s/custody.json", spec.meta); atomic_write(path, custody);
  if (empty_before_leader_reap && cgroup_path[0]) rmdir(cgroup_path);
  pids_clear(&nonleaders); free_spec(&spec); return empty_before_leader_reap ? 0 : 1;
}
