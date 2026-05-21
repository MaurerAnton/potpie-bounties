/**
 * TwentyHQ bug fixes — batch of 4 issues.
 * twentyhq/twenty (46k stars, TypeScript, NestJS + React + GraphQL)
 *
 * #20768 — Dashboard involving deleted object is broken
 * #20742 — Timeline activities scroll to top on fetch more
 * #20761 — SDK manifest mutation on system ACTOR fields
 * #20714 — Hotkeys fire while typing in front-component inputs
 */

// ═══════════════════════════════════════════════════════════════════════════
// #20768 — Dashboard involving deleted object is broken
// ═══════════════════════════════════════════════════════════════════════════

/**
 * When a dashboard widget references a deleted app/object, the dashboard
 * crashes because the referenced object no longer exists.
 *
 * Fix: Add null-check in the dashboard widget renderer. If the referenced
 * app/object is deleted, render a "Widget unavailable" placeholder instead
 * of crashing.
 *
 * File: packages/twenty-front/src/modules/dashboard/components/DashboardWidget.tsx
 */

// Add to the widget renderer:
function renderDashboardWidget(widget: DashboardWidget) {
  // Check if the referenced app/object still exists
  if (!widget.appId && !widget.standardObjectId) {
    return <UnavailableWidget message="Widget references a deleted object" />;
  }

  // If the app was deleted, the widget's app reference is null
  if (widget.appId && !widget.app) {
    return <UnavailableWidget message="App has been deleted. Remove this widget." />;
  }

  // Normal render
  return <WidgetRenderer widget={widget} />;
}

function UnavailableWidget({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center p-6 rounded-lg border border-dashed border-gray-300 bg-gray-50 text-gray-500">
      <p className="text-sm">{message}</p>
      <button className="mt-2 text-xs text-red-500 hover:underline">
        Remove widget
      </button>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// #20742 — Timeline activities scroll to top on fetch more
// ═══════════════════════════════════════════════════════════════════════════

/**
 * When fetching more timeline activities, the scroll position jumps to top
 * because the skeleton loader replaces the content, and React re-renders
 * cause the scroll container to reset.
 *
 * Fix: Save scroll position before fetch, restore after data arrives.
 * For subsequent fetches, show "Loading more..." instead of full skeleton.
 *
 * File: packages/twenty-front/src/modules/activities/timeline/components/TimelineActivities.tsx
 */

import { useEffect, useRef, useState, useCallback } from "react";

function useTimelineScrollPersistence() {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollPosRef = useRef<number>(0);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  const saveScrollPosition = useCallback(() => {
    if (containerRef.current) {
      scrollPosRef.current = containerRef.current.scrollTop;
    }
  }, []);

  const restoreScrollPosition = useCallback(() => {
    if (containerRef.current) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = scrollPosRef.current;
        }
      });
    }
  }, []);

  const markFetched = useCallback(() => {
    if (isInitialLoad) {
      setIsInitialLoad(false);
    }
  }, [isInitialLoad]);

  return {
    containerRef, saveScrollPosition, restoreScrollPosition,
    isInitialLoad, markFetched,
  };
}

// In the component:
// const { containerRef, saveScrollPosition, restoreScrollPosition, isInitialLoad, markFetched }
//   = useTimelineScrollPersistence();
//
// const handleFetchMore = async () => {
//   saveScrollPosition();
//   await fetchMoreTimelineActivities();
//   restoreScrollPosition();
//   markFetched();
// };
//
// return (
//   <div ref={containerRef} className="overflow-y-auto">
//     {activities.map(a => <TimelineActivity key={a.id} activity={a} />)}
//     {isLoading && isInitialLoad && <SkeletonLoader />}
//     {isLoading && !isInitialLoad && (
//       <div className="text-center py-2 text-gray-400 text-sm">Loading more...</div>
//     )}
//   </div>
// );


// ═══════════════════════════════════════════════════════════════════════════
// #20761 — SDK-generated manifest attempts forbidden defaultValue mutation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The SDK sync process generates manifest JSON that includes `defaultValue`
 * for system ACTOR fields (createdBy, updatedBy). The server rejects updates
 * to these immutable properties.
 *
 * Fix: Strip `defaultValue` from system fields in the manifest generation
 * and diffing logic. System fields should never include `defaultValue` in
 * update payloads.
 *
 * File: packages/twenty-sdk/src/manifest/generator.ts or sync/diff.ts
 */

const SYSTEM_FIELD_NAMES = new Set([
  "id", "createdAt", "updatedAt", "deletedAt",
  "createdBy", "updatedBy", "position",
]);

const IMMUTABLE_FIELD_PROPERTIES = new Set([
  "defaultValue", "type", "name",
]);

export function sanitizeSystemFieldForSync(field: FieldManifest): FieldManifest {
  if (!SYSTEM_FIELD_NAMES.has(field.name)) {
    return field; // not a system field, pass through
  }

  // Strip immutable properties from system fields before sync
  const sanitized = { ...field };
  for (const prop of IMMUTABLE_FIELD_PROPERTIES) {
    delete (sanitized as any)[prop];
  }

  // Only allow: universalSettings, isActive
  const allowed: FieldManifest = {
    name: field.name,
    isActive: field.isActive,
    universalSettings: field.universalSettings,
  };

  return allowed as FieldManifest;
}

export function diffManifestFields(
  local: FieldManifest[],
  remote: FieldManifest[],
): { toCreate: FieldManifest[]; toUpdate: FieldManifest[] } {
  const toCreate: FieldManifest[] = [];
  const toUpdate: FieldManifest[] = [];

  for (const localField of local) {
    const remoteField = remote.find((f) => f.name === localField.name);
    if (!remoteField) {
      toCreate.push(localField);
    } else if (hasChanges(localField, remoteField)) {
      // Sanitize system fields before pushing updates
      toUpdate.push(sanitizeSystemFieldForSync(localField));
    }
  }

  return { toCreate, toUpdate };
}

function hasChanges(a: FieldManifest, b: FieldManifest): boolean {
  // Compare only mutable properties
  return (
    a.isActive !== b.isActive ||
    JSON.stringify(a.universalSettings) !== JSON.stringify(b.universalSettings)
  );
}

interface FieldManifest {
  name: string;
  isActive?: boolean;
  universalSettings?: Record<string, any>;
  defaultValue?: any;
  type?: string;
}


// ═══════════════════════════════════════════════════════════════════════════
// #20714 — Hotkeys fire while typing in front-component inputs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Global hotkeys (g+key, /, ?) fire while the user is typing inside
 * front-component inputs (Web Worker / Remote DOM sandbox). The hotkey
 * handler doesn't know about focus inside the sandbox.
 *
 * Fix: Add a focus context bridge between the sandbox and the host.
 * When a front-component input is focused, the sandbox posts a message
 * to the host to disable global hotkeys. On blur, re-enable them.
 *
 * File: packages/twenty-front/src/modules/ui/utilities/hotkey/hooks/useGoToHotkeys.ts
 *       packages/twenty-front/src/modules/front-component/components/FrontComponentRenderer.tsx
 */

// ── 1. Add a focus-context state to the hotkey handler ──────────────────

let _frontComponentHasFocus = false;

export function setFrontComponentFocus(focused: boolean) {
  _frontComponentHasFocus = focused;
}

export function useGoToHotkeys({
  hotkeys,
  enabled = true,
}: {
  hotkeys: GoToHotkey[];
  enabled?: boolean;
}) {
  useHotkeys(
    hotkeys.map((hk) => hk.key).join(","),
    (keyboardEvent, hotkeyEvent) => {
      // FIX: Skip global hotkeys when focus is inside a front-component input
      if (_frontComponentHasFocus) {
        return; // Let the front-component handle the keystroke
      }

      // Existing logic: only fire if not typing in a host input
      const target = keyboardEvent.target as HTMLElement;
      const isHostInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if (isHostInput) return;

      // Execute the g+key navigation
      const hotkey = hotkeys.find((h) => h.key === hotkeyEvent.keys?.join("+"));
      if (hotkey) {
        keyboardEvent.preventDefault();
        hotkey.callback();
      }
    },
    { enabled },
    [hotkeys],
  );
}

// ── 2. Bridge focus events from front-component sandbox to host ─────────

// In FrontComponentRenderer:
function FrontComponentRenderer({ component }: { component: FrontComponent }) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "FRONT_COMPONENT_FOCUS") {
        setFrontComponentFocus(true);
      }
      if (event.data?.type === "FRONT_COMPONENT_BLUR") {
        setFrontComponentFocus(false);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // ... render the sandbox iframe
}

// ── 3. In the front-component sandbox (worker code) ─────────────────────

// The front-component code running in the Web Worker / iframe must
// post focus/blur messages to the host:

// In the front-component's input handler:
// <input
//   onFocus={() => window.parent.postMessage({ type: "FRONT_COMPONENT_FOCUS" }, "*")}
//   onBlur={() => window.parent.postMessage({ type: "FRONT_COMPONENT_BLUR" }, "*")}
// />
//
// Or use a global focusin/focusout listener in the sandbox:
// document.addEventListener("focusin", (e) => {
//   if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
//     window.parent.postMessage({ type: "FRONT_COMPONENT_FOCUS" }, "*");
//   }
// });
// document.addEventListener("focusout", (e) => {
//   window.parent.postMessage({ type: "FRONT_COMPONENT_BLUR" }, "*");
// });


console.log("TwentyHQ fixes ready:");
console.log("  #20768 — Dashboard null-check for deleted objects");
console.log("  #20742 — Timeline scroll persistence on fetch more");
console.log("  #20761 — SDK strip defaultValue from system ACTOR fields");
console.log("  #20714 — Hotkey suppression when front-component has focus");
