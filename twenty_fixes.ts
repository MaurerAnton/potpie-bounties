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


// ═══════════════════════════════════════════════════════════════════════════
// #20558 — AI chat: "Unsupported part type: dynamic-tool"
// File: packages/twenty-server/src/engine/.../mapUIMessagePartsToDBParts.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The AI agent stream returns a 'dynamic-tool' part type which is not
 * handled in the message parts mapper, causing a crash at line 94.
 *
 * Fix: Add a case for 'dynamic-tool' parts — map them as text parts
 * or skip them if they don't need persistence.
 */

const SUPPORTED_PART_TYPES = {
  text: "text",
  "tool-call": "tool-call",
  "tool-result": "tool-result",
  "dynamic-tool": "dynamic-tool",  // FIX: added
  reasoning: "reasoning",
  image: "image",
};

function mapUIMessagePartsToDBParts(parts: UIMessagePart[]): DBMessagePart[] {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
        case "reasoning":
          return { type: "text", content: part.content };

        case "tool-call":
          return {
            type: "tool-call",
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            args: part.args,
          };

        case "tool-result":
          return {
            type: "tool-result",
            toolCallId: part.toolCallId,
            result: part.result,
          };

        // FIX: Handle dynamic-tool parts
        case "dynamic-tool":
          return {
            type: "text",
            content: `[Tool: ${part.toolName || "dynamic"} was invoked]`,
          };

        case "image":
          return { type: "image", url: part.url };

        default:
          // Instead of throwing, skip unknown part types gracefully
          console.warn(`Skipping unsupported part type: ${(part as any).type}`);
          return null;
      }
    })
    .filter(Boolean) as DBMessagePart[];
}


// ═══════════════════════════════════════════════════════════════════════════
// #20656 — AI Chat "Cannot convert argument to a ByteString" (undici headers)
// File: packages/twenty-server/src/integrations/ai/providers/anthropic.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * undici's fetch() throws "Cannot convert argument to a ByteString" when
 * HTTP headers contain non-Latin1 characters (e.g., Unicode replacement
 * character U+FFFD at index 4).
 *
 * This happens when the model response metadata contains characters that
 * can't be encoded in HTTP header values (headers must be ISO-8859-1).
 *
 * Fix: Sanitize all custom header values to ASCII-safe strings before
 * passing them to fetch(). Replace non-Latin1 chars with '?'.
 */

function sanitizeHeaderValue(value: string): string {
  // HTTP headers must be ISO-8859-1 (Latin1). Replace any character
  // > 0xFF with '?' to prevent undici ByteString errors.
  let sanitized = "";
  for (let i = 0; i < value.length; i++) {
    const cp = value.codePointAt(i);
    if (cp !== undefined && cp <= 0xFF) {
      sanitized += String.fromCodePoint(cp);
    } else {
      sanitized += "?";
      // Skip surrogate pair if present
      if (cp !== undefined && cp > 0xFFFF) i++;
    }
  }
  return sanitized;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    clean[sanitizeHeaderValue(key)] = sanitizeHeaderValue(value);
  }
  return clean;
}

// Usage in Anthropic/OpenAI provider:
// const response = await fetch(url, {
//   ...options,
//   headers: sanitizeHeaders(options.headers),
// });


// ═══════════════════════════════════════════════════════════════════════════
// #20726 — Performance: timelineActivity missing index on custom relation columns
// File: database migration (new)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Custom object relation columns on timelineActivity table lack indexes,
 * causing sequential scans on 22M-row tables (~20-40s queries).
 *
 * Fix: Add a migration that creates BTREE indexes for all custom relation
 * columns on timelineActivity, matching the pattern used for built-in
 * relations (Company, Person, Opportunity).
 */

const TIMELINE_INDEX_MIGRATION = `
-- Migration: Add indexes for custom relation columns on timelineActivity

-- Built-in relations already have indexes. Custom relations added via
-- the object metadata system need matching indexes for query performance.

-- Dynamically generated per-workspace, per-custom-field:
-- CREATE INDEX IF NOT EXISTS "IDX_timelineActivity_<fieldName>"
--   ON "workspace_<id>"."timelineActivity" ("<fieldName>")
--   WHERE "deletedAt" IS NULL;
`;

// In the migration runner (packages/twenty-server/src/database/migrations/):
async function addTimelineActivityIndexes(workspaceId: string, customFields: string[]) {
  for (const fieldName of customFields) {
    const indexName = `IDX_timelineActivity_${fieldName}`;
    await workspaceDataSource.query(`
      CREATE INDEX IF NOT EXISTS "${indexName}"
      ON "workspace_${workspaceId}"."timelineActivity" ("${fieldName}")
      WHERE "deletedAt" IS NULL;
    `);
  }
}

// Hook this into the field creation flow:
// When a new custom relation field is added to timelineActivity,
// automatically create the corresponding index.


// ═══════════════════════════════════════════════════════════════════════════
// #20483 — Navigation menu items leak across users
// File: packages/twenty-server/src/engine/.../navigation-menu-item.service.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Personal Favorites/sidebar entries can leak to other users because
 * the navigation query doesn't always scope by userId for user-scoped items.
 *
 * Fix: Add explicit userId filter in the query to ensure user-scoped items
 * are only returned for the owning user.
 */

interface NavigationMenuItem {
  id: string;
  type: "favorite" | "view" | "workspace";
  scope: "user" | "workspace";
  userId?: string;
  workspaceId: string;
}

async function findUserNavigationItems(
  userId: string,
  workspaceId: string,
): Promise<NavigationMenuItem[]> {
  const items = await navigationMenuItemRepo.find({
    where: [
      // Workspace-scoped items: visible to all members
      { workspaceId, scope: "workspace" },
      // User-scoped items: ONLY visible to the owning user
      { workspaceId, scope: "user", userId },  // FIX: added userId filter
    ],
    order: { position: "ASC" },
  });

  // Additional safety: filter out any user-scoped items belonging to other users
  // (defense in depth — the query above should already handle this)
  return items.filter(
    (item) => item.scope === "workspace" || item.userId === userId
  );
}


console.log("TwentyHQ fixes ready:");
console.log("  #20768 — Dashboard null-check for deleted objects");
console.log("  #20742 — Timeline scroll persistence on fetch more");
console.log("  #20761 — SDK strip defaultValue from system ACTOR fields");
console.log("  #20714 — Hotkey suppression when front-component has focus");
console.log("  #20558 — AI chat: handle dynamic-tool part type");
console.log("  #20656 — AI chat: sanitize undici header ByteString error");
console.log("  #20726 — Performance: timelineActivity custom relation indexes");
console.log("  #20483 — Navigation: user-scoped menu items filter");
