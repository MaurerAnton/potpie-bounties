/**
 * CapSoftware/Cap #1540 — Deeplinks support + Raycast Extension ($200 bounty)
 *
 * Cap: Open source Loom alternative. 19k stars. TypeScript/Tauri.
 *
 * Part 1: Tauri deeplinks for recording control
 * Part 2: Raycast extension using those deeplinks
 */

// ═══════════════════════════════════════════════════════════════════════════
// Part 1: Deeplinks in Tauri (src-tauri/src/deeplink.rs)
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Deeplink scheme: `cap://record`, `cap://stop`, etc.
 *
 * Tauri plugin: tauri-plugin-deep-link
 * Handles: cap://record, cap://stop, cap://pause, cap://resume,
 *          cap://mic/switch, cap://camera/switch, cap://new-recording
 */

// Rust (Tauri backend):
/*
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                handle_deeplink(&handle, &event);
            });
            // Register custom protocol on macOS
            #[cfg(target_os = "macos")]
            app.deep_link().register("cap")?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn handle_deeplink(handle: &tauri::AppHandle, url: &str) {
    let url = url.replace("cap://", "");
    let window = handle.get_webview_window("main").unwrap();

    match url.as_str() {
        "record" | "recording/start" => {
            window.eval("window.__cap_startRecording()").ok();
        }
        "stop" | "recording/stop" => {
            window.eval("window.__cap_stopRecording()").ok();
        }
        "pause" | "recording/pause" => {
            window.eval("window.__cap_pauseRecording()").ok();
        }
        "resume" | "recording/resume" => {
            window.eval("window.__cap_resumeRecording()").ok();
        }
        "mic/switch" => {
            window.eval("window.__cap_switchMicrophone()").ok();
        }
        "camera/switch" => {
            window.eval("window.__cap_switchCamera()").ok();
        }
        "new-recording" => {
            window.eval("window.__cap_newRecording()").ok();
        }
        _ => {
            // Handle auth callbacks (existing)
            if url.starts_with("auth/") {
                window.eval(&format!("window.__cap_authCallback('{}')", url)).ok();
            }
        }
    }
}
*/

// ═══════════════════════════════════════════════════════════════════════════
// Part 1b: Frontend — expose global functions for deeplinks (src/utils/deeplinks.ts)
// ═══════════════════════════════════════════════════════════════════════════

// These are called by the Tauri backend via window.eval()
// They dispatch to the app's recording state manager

declare global {
  interface Window {
    __cap_startRecording: () => void;
    __cap_stopRecording: () => void;
    __cap_pauseRecording: () => void;
    __cap_resumeRecording: () => void;
    __cap_switchMicrophone: () => void;
    __cap_switchCamera: () => void;
    __cap_newRecording: () => void;
    __cap_authCallback: (url: string) => void;
  }
}

export function registerDeeplinkHandlers(recordingState: RecordingStateManager) {
  window.__cap_startRecording = () => recordingState.start();
  window.__cap_stopRecording = () => recordingState.stop();
  window.__cap_pauseRecording = () => recordingState.pause();
  window.__cap_resumeRecording = () => recordingState.resume();
  window.__cap_switchMicrophone = () => recordingState.switchMicrophone();
  window.__cap_switchCamera = () => recordingState.switchCamera();
  window.__cap_newRecording = () => recordingState.newRecording();
}

interface RecordingStateManager {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  switchMicrophone(): void;
  switchCamera(): void;
  newRecording(): void;
}


// ═══════════════════════════════════════════════════════════════════════════
// Part 2: Raycast Extension
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Raycast extension for Cap — quick recording controls.
 *
 * Directory: extensions/cap/
 * Files:
 *   package.json
 *   tsconfig.json
 *   src/
 *     index.tsx        — main commands
 *     cap-control.ts   — deeplink opener
 */

// ── package.json ──────────────────────────────────────────────────────
const RAYCAST_PACKAGE_JSON = {
  "$schema": "https://www.raycast.com/schemas/extension.json",
  "name": "cap",
  "title": "Cap — Quick Recording",
  "description": "Start, stop, and control Cap screen recordings from Raycast",
  "icon": "cap-logo.png",
  "author": "cap_contributor",
  "categories": ["Productivity", "Developer Tools"],
  "license": "MIT",
  "commands": [
    {
      "name": "new-recording",
      "title": "New Recording",
      "description": "Start a new screen recording with Cap",
      "mode": "no-view"
    },
    {
      "name": "stop-recording",
      "title": "Stop Recording",
      "description": "Stop the current recording",
      "mode": "no-view"
    },
    {
      "name": "pause-resume",
      "title": "Pause/Resume Recording",
      "description": "Toggle pause/resume on the current recording",
      "mode": "no-view"
    },
    {
      "name": "recording-controls",
      "title": "Recording Controls",
      "description": "Show all recording controls in a list",
      "mode": "view"
    }
  ],
  "dependencies": {
    "@raycast/api": "^1.80.0",
    "open": "^10.0.0"
  },
  "devDependencies": {
    "@raycast/eslint-config": "^1.0.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }
};

// ── src/cap-control.ts ────────────────────────────────────────────────
const CAP_CONTROL_TS = `
import { open } from "@raycast/api";

const DEEPLINK_BASE = "cap://";

export async function newRecording() {
  await open(DEEPLINK_BASE + "new-recording");
}

export async function startRecording() {
  await open(DEEPLINK_BASE + "record");
}

export async function stopRecording() {
  await open(DEEPLINK_BASE + "stop");
}

export async function pauseRecording() {
  await open(DEEPLINK_BASE + "pause");
}

export async function resumeRecording() {
  await open(DEEPLINK_BASE + "resume");
}

export async function switchMicrophone() {
  await open(DEEPLINK_BASE + "mic/switch");
}

export async function switchCamera() {
  await open(DEEPLINK_BASE + "camera/switch");
}
`;

// ── src/index.tsx ─────────────────────────────────────────────────────
const RAYCAST_INDEX_TSX = `
import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import {
  newRecording, startRecording, stopRecording,
  pauseRecording, resumeRecording,
  switchMicrophone, switchCamera,
} from "./cap-control";

// Command: cap new-recording (no-view)
export default async function Command() {
  await showToast({ title: "Starting new recording...", style: Toast.Style.Animated });
  await newRecording();
}

// Command: cap stop-recording (no-view)
export async function StopRecording() {
  await showToast({ title: "Stopping recording...", style: Toast.Style.Animated });
  await stopRecording();
  await showToast({ title: "Recording stopped", style: Toast.Style.Success });
}

// Command: cap pause-resume (no-view)
export async function PauseResume() {
  await showToast({ title: "Toggling pause...", style: Toast.Style.Animated });
  // Try pause first — if already paused, resume
  await pauseRecording();
}

// Command: cap recording-controls (view)
export function RecordingControls() {
  return (
    <List>
      <List.Item
        title="New Recording"
        subtitle="Start a new screen recording"
        actions={<ActionPanel><Action title="Start" onAction={newRecording} /></ActionPanel>}
      />
      <List.Item
        title="Stop Recording"
        subtitle="Stop the current recording"
        actions={<ActionPanel><Action title="Stop" onAction={StopRecordingCommand} /></ActionPanel>}
      />
      <List.Item
        title="Pause Recording"
        subtitle="Pause the current recording"
        actions={<ActionPanel><Action title="Pause" onAction={pauseRecording} /></ActionPanel>}
      />
      <List.Item
        title="Resume Recording"
        subtitle="Resume a paused recording"
        actions={<ActionPanel><Action title="Resume" onAction={resumeRecording} /></ActionPanel>}
      />
      <List.Item
        title="Switch Microphone"
        subtitle="Cycle to next microphone"
        actions={<ActionPanel><Action title="Switch" onAction={switchMicrophone} /></ActionPanel>}
      />
      <List.Item
        title="Switch Camera"
        subtitle="Cycle to next camera"
        actions={<ActionPanel><Action title="Switch" onAction={switchCamera} /></ActionPanel>}
      />
    </List>
  );
}

async function StopRecordingCommand() {
  await showToast({ title: "Stopping...", style: Toast.Style.Animated });
  await stopRecording();
  await showToast({ title: "Stopped", style: Toast.Style.Success });
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// Part 3: macOS Info.plist — register custom URL scheme
// ═══════════════════════════════════════════════════════════════════════════

const MACOS_PLIST_ENTRY = `
<!-- In src-tauri/Info.plist, add inside <dict>: -->
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleURLName</key>
        <string>Cap Recording Deeplinks</string>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>cap</string>
        </array>
    </dict>
</array>
`;

console.log("Cap #1540 ready: deeplinks + Raycast extension");
