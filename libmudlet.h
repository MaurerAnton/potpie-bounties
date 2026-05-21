/*
 * libmudlet.h — Public C API for the Mudlet core library.
 * Part of Mudlet #9011: Split Mudlet into libmudlet + Qt frontend.
 *
 * This header defines the stable ABI for libmudlet. All frontend code
 * (Qt, mobile, headless) uses ONLY this API — no internal headers.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#ifndef LIBMUDLET_H
#define LIBMUDLET_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Opaque types ─────────────────────────────────────────────────────── */

typedef struct mudlet_host    mudlet_host;
typedef struct mudlet_buffer  mudlet_buffer;
typedef struct mudlet_profile mudlet_profile;

/* ── Version ───────────────────────────────────────────────────────────── */

#define LIBMUDLET_VERSION_MAJOR 1
#define LIBMUDLET_VERSION_MINOR 0
#define LIBMUDLET_VERSION_PATCH 0

void mudlet_version(int *major, int *minor, int *patch);

/* ── Initialization ────────────────────────────────────────────────────── */

/// Initialize the library (call once at startup).
/// @param data_dir  Path to Mudlet data directory (profiles, maps, logs).
/// @return 0 on success, -1 on error.
int mudlet_init(const char *data_dir);

/// Shutdown the library (call once at exit).
void mudlet_shutdown(void);

/// Get the last error message (thread-local).
const char *mudlet_last_error(void);

/* ── Host Management ───────────────────────────────────────────────────── */

/// Create a new host (one host = one MUD connection + profile).
/// @param profile_name  Unique name for this profile.
/// @return Host handle or NULL on error.
mudlet_host *mudlet_host_create(const char *profile_name);

/// Destroy a host and all associated resources.
void mudlet_host_destroy(mudlet_host *host);

/// Get the host's profile name.
const char *mudlet_host_get_name(mudlet_host *host);

/// Set a host option.
/// @param key    Option name (e.g., "encoding", "auto_reconnect").
/// @param value  Option value (string, parsed by host).
void mudlet_host_set_option(mudlet_host *host, const char *key, const char *value);

/// Get a host option.
/// @return Option value or NULL if not set. Caller must NOT free.
const char *mudlet_host_get_option(mudlet_host *host, const char *key);

/* ── Connection ────────────────────────────────────────────────────────── */

/// Connect to a MUD server.
/// @param host      Host handle.
/// @param url       Server hostname or IP.
/// @param port      Server port.
/// @param use_tls   1 = TLS/WSS, 0 = plain TCP.
/// @return 0 on connection initiated, -1 on error.
int mudlet_host_connect(mudlet_host *host, const char *url, int port, int use_tls);

/// Disconnect from server.
void mudlet_host_disconnect(mudlet_host *host);

/// Check if connected.
/// @return 1 if connected, 0 otherwise.
int mudlet_host_is_connected(mudlet_host *host);

/* ── Data I/O ──────────────────────────────────────────────────────────── */

/// Send text to the MUD server.
/// @param text  Null-terminated string to send.
void mudlet_host_send(mudlet_host *host, const char *text);

/// Send raw bytes to the MUD server (for binary protocols).
void mudlet_host_send_raw(mudlet_host *host, const uint8_t *data, size_t len);

/// Callback type for incoming server data.
/// Called whenever new text arrives from the server.
typedef void (*mudlet_data_fn)(mudlet_host *host, const char *text, size_t len, void *userdata);

/// Register a callback for incoming server data.
void mudlet_host_on_data(mudlet_host *host, mudlet_data_fn callback, void *userdata);

/* ── Text Buffer (content, NOT rendering) ──────────────────────────────── */

/// Get the host's main text buffer.
mudlet_buffer *mudlet_host_get_buffer(mudlet_host *host);

/// Get number of lines in the buffer.
int mudlet_buffer_line_count(mudlet_buffer *buf);

/// Get a specific line from the buffer.
/// @param index  0-based line number (0 = oldest in scrollback).
/// @return Null-terminated UTF-8 string or NULL if out of range.
///         Caller must NOT free.
const char *mudlet_buffer_get_line(mudlet_buffer *buf, int index);

/// Get a range of lines efficiently.
/// @param out     Pre-allocated array of const char* (size = to - from + 1).
/// @param from    Start index (inclusive).
/// @param to      End index (inclusive).
/// @return Number of lines actually copied.
int mudlet_buffer_get_lines(mudlet_buffer *buf, const char **out, int from, int to);

/// Get the visible line count (lines currently displayed).
int mudlet_buffer_visible_lines(mudlet_buffer *buf);

/// Callback when buffer needs more content (e.g., user scrolled up).
typedef void (*mudlet_buffer_request_fn)(mudlet_buffer *buf, int from, int to, void *userdata);

/// Register a callback for buffer content requests.
void mudlet_buffer_on_request(mudlet_buffer *buf, mudlet_buffer_request_fn cb, void *userdata);

/* ── Lua Scripting ─────────────────────────────────────────────────────── */

/// Execute a Lua script in the host's sandbox.
/// @return 0 on success, -1 on error (check mudlet_last_error()).
int mudlet_lua_execute(mudlet_host *host, const char *script);

/// Evaluate a Lua expression and get the result as a string.
/// @return Result string or NULL. Caller must mudlet_free_string().
char *mudlet_lua_evaluate(mudlet_host *host, const char *expression);

/// Callback for Lua script results (async execution).
typedef void (*mudlet_lua_result_fn)(const char *result, void *userdata);

/// Execute Lua asynchronously.
void mudlet_lua_execute_async(mudlet_host *host, const char *script,
                               mudlet_lua_result_fn callback, void *userdata);

/* ── Triggers ──────────────────────────────────────────────────────────── */

/// Add a trigger (pattern → Lua script).
/// @param pattern   Lua pattern or regex.
/// @param script    Lua script to execute on match.
/// @param type      0=substring, 1=regex, 2=exact, 3=begin, 4=lua_function.
/// @return Trigger ID or -1 on error.
int mudlet_trigger_add(mudlet_host *host, const char *pattern, const char *script, int type);

/// Remove a trigger by ID.
void mudlet_trigger_remove(mudlet_host *host, int id);

/// Get trigger count.
int mudlet_trigger_count(mudlet_host *host);

/// Enable/disable a trigger.
void mudlet_trigger_set_enabled(mudlet_host *host, int id, int enabled);

/* ── Aliases ───────────────────────────────────────────────────────────── */

int  mudlet_alias_add(mudlet_host *host, const char *pattern, const char *script, int type);
void mudlet_alias_remove(mudlet_host *host, int id);
int  mudlet_alias_count(mudlet_host *host);

/* ── Timers ─────────────────────────────────────────────────────────────── */

int  mudlet_timer_add(mudlet_host *host, const char *script, double interval_seconds);
void mudlet_timer_remove(mudlet_host *host, int id);
int  mudlet_timer_count(mudlet_host *host);

/* ── Keys ───────────────────────────────────────────────────────────────── */

int  mudlet_key_add(mudlet_host *host, int key_code, int modifiers, const char *script);
void mudlet_key_remove(mudlet_host *host, int id);

/* ── Events ─────────────────────────────────────────────────────────────── */

/// Raise a named event (triggers event handlers in Lua).
void mudlet_event_raise(mudlet_host *host, const char *event_name, const char *json_args);

/// Callback for system events pushed from library to frontend.
typedef void (*mudlet_event_fn)(int event_type, const char *json_payload, void *userdata);

/// Register an event callback.
void mudlet_host_on_event(mudlet_host *host, mudlet_event_fn callback, void *userdata);

#define MUDLET_EVENT_CONNECTED        1
#define MUDLET_EVENT_DISCONNECTED     2
#define MUDLET_EVENT_DATA_ARRIVED     3
#define MUDLET_EVENT_TRIGGER_FIRED    4
#define MUDLET_EVENT_LUA_ERROR        5
#define MUDLET_EVENT_PROFILE_LOADED   6
#define MUDLET_EVENT_PROFILE_SAVED    7

/* ── Profile Persistence ───────────────────────────────────────────────── */

/// Save host profile to disk.
int mudlet_profile_save(mudlet_host *host);

/// Load host profile from disk.
int mudlet_profile_load(mudlet_host *host);

/// Save to specific path.
int mudlet_profile_save_as(mudlet_host *host, const char *path);

/* ── Sub-protocols ─────────────────────────────────────────────────────── */

/// Check if a sub-protocol is enabled for this host.
int mudlet_host_protocol_enabled(mudlet_host *host, const char *protocol_name);

// protocol_name values: "gmcp", "msp", "mxp", "mccp", "msdp", "telnet_charset"

/* ── Memory Management ─────────────────────────────────────────────────── */

/// Free a string returned by the library.
void mudlet_free_string(char *str);

/// Free a buffer returned by the library.
void mudlet_free_buffer(void *ptr);

#ifdef __cplusplus
}
#endif

#endif /* LIBMUDLET_H */
