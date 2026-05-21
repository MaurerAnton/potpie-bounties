# Mudlet #9011 — Split into libmudlet + Qt Frontend (Architecture Plan)

## 1. Current Architecture

Mudlet is a monolithic C++/Qt application (~428 source files in `src/`).
Everything is tightly coupled:
- Network I/O (telnet, GMCP, MSP) is mixed with UI rendering
- Lua scripting engine calls back into Qt widgets directly
- Profile/connection management is entangled with MainWindow state
- No clear API boundary between core logic and presentation

```
Current monolith:
┌─────────────────────────────────────────┐
│  src/*.cpp  (428 files, flat structure) │
│                                         │
│  TConsole  ←→  Host  ←→  TLuaInterpreter│
│     ↕              ↕                     │
│  dlgProfilePrefs  TBuffer               │
│     ↕              ↕                     │
│  mudlet.cpp (main window, menus, tabs)  │
└─────────────────────────────────────────┘
```

## 2. Proposed Architecture

```
┌──────────────────────────────────────────────┐
│              Qt Frontend (mudlet-qt)          │
│                                              │
│  MainWindow    ProfileManager    Preferences  │
│  TConsole      TCommandLine      dlg* dialogs│
│  Menu system   Toolbar           StatusBar   │
│  Display rendering, font mgmt, themes        │
└──────────────────┬───────────────────────────┘
                   │  libmudlet C API
┌──────────────────┴───────────────────────────┐
│           Core Library (libmudlet)            │
│                                              │
│  Host (connection lifecycle)                  │
│  Network I/O: Telnet, GMCP, MSP, MXP         │
│  Lua scripting engine + trigger/alias/key/timer│
│  Text buffer (TBuffer — content, no rendering) │
│  Profile storage (XML, JSON)                  │
│  Logging, session recording                   │
│  Map/room navigation (non-visual)             │
│  Variable/timer/event subsystems              │
└──────────────────────────────────────────────┘
```

## 3. libmudlet Public API

The library exposes a C-style API (wrapped in C++ `extern "C"` for ABI stability):

```c
// ── Connection Management ──────────────────────────────────────────
typedef struct mudlet_host mudlet_host;
mudlet_host* mudlet_host_create(const char* profile_name);
void         mudlet_host_destroy(mudlet_host* host);
int          mudlet_host_connect(mudlet_host* host, const char* url, int port, int tls);
void         mudlet_host_disconnect(mudlet_host* host);
int          mudlet_host_is_connected(mudlet_host* host);

// ── Data Flow ──────────────────────────────────────────────────────
// Callbacks registered by the frontend for incoming data
typedef void (*mudlet_data_callback)(mudlet_host*, const char* text, int len, void* userdata);
void mudlet_host_on_data(mudlet_host* host, mudlet_data_callback cb, void* userdata);
void mudlet_host_send(mudlet_host* host, const char* text, int len);  // send to server
void mudlet_host_send_raw(mudlet_host* host, const uint8_t* data, int len);

// ── Text Buffer (content, not rendering) ───────────────────────────
typedef struct mudlet_buffer mudlet_buffer;
mudlet_buffer* mudlet_host_get_buffer(mudlet_host* host);
int            mudlet_buffer_line_count(mudlet_buffer* buf);
const char*    mudlet_buffer_get_line(mudlet_buffer* buf, int index);
// Frontend calls this when user scrolls — triggers line request from history
void mudlet_buffer_request_lines(mudlet_buffer* buf, int from, int to);

// ── Lua Scripting ──────────────────────────────────────────────────
int  mudlet_lua_execute(mudlet_host* host, const char* script);
void mudlet_lua_register_callback(mudlet_host* host, const char* name,
                                   void (*fn)(const char* result, void* userdata),
                                   void* userdata);

// ── Triggers / Aliases / Keys / Timers ─────────────────────────────
int  mudlet_host_trigger_count(mudlet_host* host);
void mudlet_host_enable_trigger(mudlet_host* host, int id, int enable);
// ... similar for aliases, keys, timers, events

// ── Profile Persistence ────────────────────────────────────────────
int  mudlet_profile_save(mudlet_host* host, const char* path);
int  mudlet_profile_load(mudlet_host* host, const char* path);

// ── Event Notifications (pushed from library to frontend) ──────────
typedef void (*mudlet_event_callback)(int event_type, const char* json_payload, void* userdata);
void mudlet_host_on_event(mudlet_host* host, mudlet_event_callback cb, void* userdata);

// Event types:
#define MUDLET_EVENT_CONNECTED      1
#define MUDLET_EVENT_DISCONNECTED   2
#define MUDLET_EVENT_DATA_ARRIVED   3
#define MUDLET_EVENT_TRIGGER_FIRED  4
#define MUDLET_EVENT_LUA_ERROR      5
#define MUDLET_EVENT_PROFILE_LOADED 6
```

## 4. File Migration Plan

### Phase 1: Move to libmudlet/ (pure core, no Qt dependencies)

Files that DON'T use Qt:
```
libmudlet/
├── core/
│   ├── Host.cpp/h           # connection lifecycle
│   ├── TBuffer.cpp/h        # text content buffer
│   ├── TBufferHandler.cpp/h # buffer operations (cut, copy, search)
│   └── SessionRecording.cpp/h
├── network/
│   ├── Telnet.cpp/h         # RFC 854
│   ├── GMCP.cpp/h           # Generic Mud Communication Protocol
│   ├── MSP.cpp/h            # Mud Sound Protocol
│   ├── MXP.cpp/h            # Mud eXtension Protocol
│   ├── Compression.cpp/h    # MCCP (Mud Client Compression Protocol)
│   └── Proxy.cpp/h
├── scripting/
│   ├── LuaInterface.cpp/h   # Lua state, sandboxing
│   ├── TriggerEngine.cpp/h  # pattern matching + firing
│   ├── AliasEngine.cpp/h
│   ├── KeyEngine.cpp/h
│   ├── TimerEngine.cpp/h
│   ├── EventEngine.cpp/h
│   └── VariableStore.cpp/h
├── data/
│   ├── Profile.cpp/h        # XML/JSON serialization
│   ├── RoomDB.cpp/h         # map/room data (non-visual)
│   └── ModuleSync.cpp/h
├── utils/
│   ├── Logger.cpp/h
│   ├── Encryption.cpp/h     # TLS helpers
│   └── Platform.h            # OS detection
└── include/
    └── libmudlet.h           # Public C API header
```

### Phase 2: Keep in mudlet-qt/ (Qt-dependent files)

```cpp
mudlet-qt/
├── mudlet.cpp/h             # MainWindow, menu, toolbar, tab management
├── TConsole.cpp/h           # Console rendering (uses libmudlet's TBuffer for data)
├── TCommandLine.cpp/h       # Command input widget
├── dlg*.cpp/h               # All dialog/window classes
├── ui/*.ui                  # Qt Designer UI files
├── rendering/
│   ├── DisplayRenderer.cpp/h# ANSI/HTML rendering
│   ├── FontManager.cpp/h
│   ├── DarkTheme.cpp/h
│   └── GifTracker.cpp/h
└── settings/
    ├── dlgProfilePreferences.cpp/h
    └── dlgConnectionPreferences.cpp/h
```

### Phase 3: Shared interfaces (thin Qt-free headers in libmudlet, Qt impl in frontend)

```
include/mudlet/
├── interfaces/
│   ├── IDisplay.h           # Abstract display interface
│   ├── INotification.h      # Abstract notification/toast interface
│   └── IAudio.h             # Abstract audio output interface
```

## 5. Migration Strategy

### Step 1: Extract libmudlet as a static library (Week 1-2)

1. Create `libmudlet/` directory with its own `CMakeLists.txt`
2. Move Phase 1 files into `libmudlet/`
3. Build `libmudlet.a` static library
4. Update `src/CMakeLists.txt` to link against `libmudlet`
5. Ensure all tests pass — no behavioral changes

### Step 2: Add C API boundary (Week 3)

1. Implement `libmudlet.h` public header
2. Add `extern "C"` wrapper functions for each API entry point
3. Frontend code uses only the C API (not internal libmudlet headers)
4. Verify binary compatibility with ABI tests

### Step 3: Extract Qt frontend (Week 4)

1. Create `mudlet-qt/` directory
2. Move Phase 2 files
3. Replace direct Host/TBuffer access with libmudlet C API calls
4. Build `mudlet-qt` as separate executable

### Step 4: Validate + polish (Week 5)

1. Run full test suite on both components
2. Verify all Lua scripts work through the API boundary
3. Benchmark: measure latency overhead of the API boundary
4. Update documentation, packaging scripts

## 6. Risk Mitigation

| Risk | Mitigation |
|---|---|
| Lua scripts access Qt widgets directly | Deprecation period: wrap in compatibility shim, log warnings |
| Performance regression from API boundary | Zero-copy buffer sharing; benchmark before/after |
| Plugin ecosystem breaks | Maintain old header compatibility for 2 releases |
| Build system complexity | Single top-level CMakeLists.txt with subdirectories; both targets built together |

## 7. Success Criteria

- [ ] libmudlet shared/static library builds without Qt
- [ ] `mudlet-qt` frontend links against libmudlet
- [ ] All existing Lua scripts, triggers, aliases work unchanged
- [ ] Mudlet runs as before with no user-visible changes
- [ ] libmudlet can be linked into a mobile/headless application
- [ ] CI builds both targets on Linux, macOS, Windows
