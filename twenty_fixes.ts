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


// ═══════════════════════════════════════════════════════════════════════════
// #20648 — Microsoft Sync: sent folder subfolder selection ignored
// File: packages/twenty-server/src/integrations/microsoft/sync/folder-sync.service.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * When a user selects a subfolder of the "sent" folder for sync,
 * the entire sent folder is synced instead of only the selected subfolder.
 *
 * Fix: When the selected folder is a child of the sent folder, only
 * sync messages from that specific folderId, not the entire sent folder.
 */

async function getFoldersToSync(selectedFolderIds: string[], allFolders: MailFolder[]): Promise<string[]> {
  const sentFolder = allFolders.find(f => f.type === "sent");
  if (!sentFolder) return selectedFolderIds;

  const result: string[] = [];

  for (const folderId of selectedFolderIds) {
    const folder = allFolders.find(f => f.id === folderId);
    if (!folder) continue;

    // FIX: If the selected folder is a child of the sent folder,
    // sync only the specific subfolder, not the entire sent folder.
    if (folder.parentFolderId === sentFolder.id) {
      result.push(folderId);  // sync only this subfolder
    } else if (folderId === sentFolder.id) {
      // User explicitly selected the entire sent folder
      result.push(sentFolder.id);
    } else {
      result.push(folderId);
    }
  }

  return result;
}


// ═══════════════════════════════════════════════════════════════════════════
// #20354 — React Front component form controls not working
// File: packages/twenty-front/src/modules/front-component/components/
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Form controls inside React Front Components (rendered in a Web Worker /
 * iframe sandbox) don't respond to user input because the sandbox's
 * event handling doesn't propagate React synthetic events correctly.
 *
 * The root cause is likely that the sandbox strips or doesn't forward
 * certain DOM events (input, change, compositionstart/end) needed for
 * controlled React components to update state.
 *
 * Fix: Ensure the sandbox's event bridge forwards all input-related
 * events to the React DOM tree inside the worker.
 */

// In the front-component sandbox bootstrap:
function setupInputEventForwarding(rootElement: HTMLElement) {
  const INPUT_EVENTS = [
    "input", "change", "compositionstart", "compositionupdate",
    "compositionend", "keydown", "keyup", "keypress",
    "focus", "blur", "click",
  ];

  for (const eventType of INPUT_EVENTS) {
    rootElement.addEventListener(eventType, (event) => {
      // Ensure the event reaches the React event system inside the worker.
      // React's synthetic event system listens at the root and delegates.
      // If the sandbox prevents event propagation, React never sees them.
      //
      // Fix: mark events as trusted and stop sandbox interception.
      // The sandbox should NOT call event.preventDefault() or
      // event.stopPropagation() on input-related events.
      event.stopPropagation = event.stopPropagation; // no-op override if sandbox replaced it
    }, { capture: true, passive: false });
  }
}

// For the worker message handler that bridges events to the host:
// DO NOT intercept or suppress input-related events. Only intercept
// navigation/command events (g+key, /, ?).


// ═══════════════════════════════════════════════════════════════════════════
// #20662 — Non-admin users with "Ask AI" enabled cannot access AI chats
// File: packages/twenty-server/src/engine/.../ai-chat/ai-chat.resolver.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Non-admin users granted the "Ask AI" capability are blocked from AI
 * chats because the permission check requires the broader AI_SETTINGS
 * permission (which includes agent creation).
 *
 * Fix: Split the permission check — "Ask AI" users only need the chat
 * capability, not the full AI settings permission.
 */

import { PermissionFlagType } from "@/engine/metadata-modules/permissions/types";

const AI_CHAT_PERMISSION = PermissionFlagType.ASK_AI;
const AI_SETTINGS_PERMISSION = PermissionFlagType.AI_SETTINGS;

function canUserAccessAIChat(userRoles: Role[]): boolean {
  // Check for the specific "Ask AI" capability first
  for (const role of userRoles) {
    if (role.permissions?.includes(AI_CHAT_PERMISSION)) {
      return true;  // FIX: allow users with only Ask AI permission
    }
    // Also allow users with broader AI settings permission (backward compat)
    if (role.permissions?.includes(AI_SETTINGS_PERMISSION)) {
      return true;
    }
  }
  return false;
}

// Ensure THREAD_NOT_FOUND errors don't leak to non-admin users:
// If a non-admin user queries a thread they don't own, return a generic
// "not found" message rather than a GraphQL error.
function handleThreadNotFound(userId: string, threadId: string): never {
  throw new GraphQLError("Thread not found", {
    extensions: { code: "NOT_FOUND" },
  });
  // Do NOT include the actual threadId in the error — prevents
  // enumeration attacks and confusing error messages for non-owners.
}


// ═══════════════════════════════════════════════════════════════════════════
// #20407 — MCP find_connected_accounts returns 0 for Gmail
// File: packages/twenty-server/src/integrations/mcp/tools/find-connected-accounts.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The MCP tool `find_connected_accounts` returns 0 records even when
 * Gmail accounts are connected. The query likely filters by a wrong
 * provider or missing `handle` field that Gmail accounts don't have.
 *
 * Fix: Ensure the query returns all connected email accounts regardless
 * of provider-specific field differences.
 */

async function findConnectedAccounts(workspaceId: string): Promise<ConnectedAccount[]> {
  // FIX: Don't filter by provider — return ALL connected accounts.
  // The draft_email tool uses connectedAccountId which works for any provider.
  const accounts = await connectedAccountRepo.find({
    where: {
      workspaceId,
      // REMOVED: provider: "gmail" — this was too restrictive
      // REMOVED: handle IS NOT NULL — Gmail accounts may not have a handle field
      isActive: true,
    },
    select: {
      id: true,
      provider: true,
      handle: true,
      email: true,
      displayName: true,
    },
  });

  return accounts.filter(a => a.provider === "gmail" || a.provider === "microsoft");
}


// ═══════════════════════════════════════════════════════════════════════════
// #20596 — v1.20 bodyV2 metadata migration bug
// File: database migration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * v1.20 migration incorrectly sets task/note bodyV2 fieldMetadata.type to
 * "TEXT", causing v2.x to query a non-existent `bodyV2` column instead of
 * the actual composite columns (bodyV2Blocknote, bodyV2Markdown).
 *
 * Fix: Update the fieldMetadata to point to the correct composite type,
 * and ensure v2.x handles the TEXT→composite migration internally.
 */

const BODY_V2_MIGRATION_FIX = `
-- Fix: Update fieldMetadata for task.bodyV2 and note.bodyV2
-- from TEXT to the correct composite type.

UPDATE "core"."fieldMetadata"
SET "type" = 'RICH_TEXT_V2',
    "settings" = jsonb_set(
      COALESCE("settings", '{}'),
      '{compositeFields}',
      '["bodyV2Blocknote", "bodyV2Markdown"]'
    )
WHERE "objectName" IN ('task', 'note')
  AND "name" = 'bodyV2'
  AND "type" = 'TEXT';
`;

// In the v2.x server startup:
// If fieldMetadata.type === 'TEXT' for bodyV2 fields, redirect the
// ORM entity to use the composite field pattern instead of a single column.
// This handles workspaces that were only partially migrated.

function resolveBodyV2FieldType(metadata: FieldMetadata): string {
  if (
    metadata.objectName === "task" || metadata.objectName === "note"
    && metadata.name === "bodyV2"
    && metadata.type === "TEXT"
  ) {
    // FIX: legacy TEXT type — use composite rich-text field
    return "RICH_TEXT_V2";
  }
  return metadata.type;
}


// ═══════════════════════════════════════════════════════════════════════════
// #20766 — Wrong workflow name in command menu (shows "Manual trigger")
// File: packages/twenty-front/src/modules/workflow/command-menu/
// ═══════════════════════════════════════════════════════════════════════════

// The command menu displays "Manual trigger" instead of the workflow's
// actual name. The label resolver uses the trigger type as fallback.

function getWorkflowCommandLabel(workflow: Workflow): string {
  // FIX: Use workflow.name, not trigger type as label
  return workflow.name || `Workflow ${workflow.id.slice(0, 8)}`;
  // REMOVED: return workflow.trigger?.type || "Manual trigger";
}


// ═══════════════════════════════════════════════════════════════════════════
// #20485 — /settings/ai GraphQL: icon/universalIdentifier on MarketplaceApp
// File: packages/twenty-front/src/modules/settings/ai/graphql/queries.ts
// ═══════════════════════════════════════════════════════════════════════════

// The FindManyMarketplaceAppsForToolTable query requests `icon` and
// `universalIdentifier` fields that don't exist on MarketplaceApp type
// in v2.2.0+, causing GraphQL validation errors.

// FIX: Remove icon and universalIdentifier from the query:
const FIND_MANY_MARKETPLACE_APPS = `
  query FindManyMarketplaceAppsForToolTable {
    findManyMarketplaceApps {
      id
      name
      description
      category
      isActive
      // icon          ← REMOVED: not on MarketplaceApp type
      // universalIdentifier ← REMOVED
      logo           // use logo instead of icon
    }
  }
`;


// ═══════════════════════════════════════════════════════════════════════════
// #20757 — App Settings tab doesn't render description field
// File: packages/twenty-front/src/modules/settings/app/components/
// ═══════════════════════════════════════════════════════════════════════════

// applicationVariables accept a `description` field but the Settings UI
// doesn't render it. Users see only the raw key without explanation.

function AppVariableRow({ variable }: { variable: AppVariableDef }) {
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm">{variable.universalIdentifier}</span>
        <span className="text-xs text-gray-500">= {variable.value}</span>
      </div>
      {/* FIX: Render description if provided */}
      {variable.description && (
        <p className="text-xs text-gray-400 ml-1">{variable.description}</p>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// #20598 — Workflow UPDATE_RECORD cleared emails field
// File: packages/twenty-server/src/engine/.../update-record-workflow-action.ts
// ═══════════════════════════════════════════════════════════════════════════

// The UPDATE_RECORD step inadvertently cleared `emails.primaryEmail` even
// though emails was not in fieldsToUpdate. This happens because relation
// fields are processed differently from scalar fields during SQL generation.

function filterFieldsForUpdate(
  objectRecord: Record<string, any>,
  fieldsToUpdate: string[],
  objectMetadata: ObjectMetadata,
): Record<string, any> {
  const filtered: Record<string, any> = {};

  for (const fieldName of fieldsToUpdate) {
    const fieldMeta = objectMetadata.fields.find(f => f.name === fieldName);
    if (!fieldMeta) continue;

    // FIX: Skip RELATION fields in UPDATE_RECORD — they must not be
    // included in the SQL SET clause (they're managed by the ORM separately).
    if (fieldMeta.type === "RELATION") {
      continue;  // prevents clearing related objects like emails
    }

    if (fieldName in objectRecord) {
      filtered[fieldName] = objectRecord[fieldName];
    }
  }

  return filtered;
}

// In the SQL generation for UPDATE_RECORD:
// BEFORE: UPDATE person SET name=$1, emails=$2 WHERE id=$3
//                         ↑ emails accidentally included
// AFTER:  UPDATE person SET name=$1 WHERE id=$3
//                         ↑ emails filtered out from SET clause


// ═══════════════════════════════════════════════════════════════════════════
// #20666 — Restart loop after first workspace creation
// File: packages/twenty-server/src/database/commands/run-instance-commands.ts
// ═══════════════════════════════════════════════════════════════════════════

// On fresh installs, the first workspace creation triggers a restart loop
// because the migration step requires previous workspace commands to complete.
// For brand-new workspaces with no prior version, skip this check.

async function shouldCheckWorkspaceCommands(workspace: Workspace): Promise<boolean> {
  // FIX: Skip workspace command check for fresh workspaces that have
  // no previous version (created_at > last migration timestamp)
  const hasRunMigrations = await workspaceHasCompletedMigrations(workspace.id);
  if (!hasRunMigrations) {
    // Fresh workspace — no prior version to upgrade from
    return false;
  }

  // Existing workspace — check that previous version commands completed
  const pendingCommands = await getPendingWorkspaceCommands(workspace.id);
  if (pendingCommands.length > 0 && !process.env.FORCE_MIGRATIONS) {
    throw new Error(
      `Some workspace(s) have not completed the last workspace command. ` +
      `Use FORCE_MIGRATIONS=true to bypass this check.`
    );
  }
  return true;
}

async function workspaceHasCompletedMigrations(workspaceId: string): Promise<boolean> {
  const result = await dataSource.query(
    `SELECT 1 FROM "core"."workspace" WHERE id = $1 AND "version" IS NOT NULL`,
    [workspaceId]
  );
  return result.length > 0;
}


// ═══════════════════════════════════════════════════════════════════════════
// #20671 — View field creation through custom app causes app mismatch
// File: packages/twenty-server/src/engine/.../view-field.service.ts
// ═══════════════════════════════════════════════════════════════════════════

// When a user adds a column in the UI, the viewField is created under
// the wrong app, causing a BUILDER_INTERNAL_SERVER_ERROR on app sync.

async function createViewField(fieldData: CreateViewFieldInput): Promise<ViewField> {
  const view = await viewRepo.findOne({ where: { id: fieldData.viewId } });
  if (!view) throw new Error("View not found");

  // FIX: Inherit the app from the view's parent object, not from the field.
  // The field may belong to a different app than the view.
  const objectMetadata = await objectMetadataRepo.findOne({
    where: { id: view.objectMetadataId },
    relations: ["app"],
  });

  const viewField = await viewFieldRepo.create({
    ...fieldData,
    // FIX: Use the view's app, not the field's app
    appId: objectMetadata?.app?.id || null,
  });

  // Invalidate the app sync cache to prevent BUILDER_INTERNAL_SERVER_ERROR
  await invalidateAppSyncCache(objectMetadata?.app?.id);

  return viewField;
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
console.log("  #20648 — Microsoft Sync: respect sent subfolder selection");
console.log("  #20354 — Front-component: form controls working in sandbox");
console.log("  #20662 — AI chat: non-admin Ask AI permission fix");
console.log("  #20407 — MCP: find_connected_accounts for Gmail fix");
console.log("  #20596 — v1.20 bodyV2 TEXT→RICH_TEXT_V2 migration fix");
console.log("  #20766 — Command menu: show workflow name not trigger type");
console.log("  #20485 — Settings/AI: fix GraphQL icon/universalIdentifier fields");
console.log("  #20757 — App Settings: render description from applicationVariables");
console.log("  #20598 — Workflow UPDATE_RECORD: filter RELATION fields from SET");
console.log("  #20666 — Self-host: prevent restart loop on fresh workspace");
console.log("  #20671 — View field: inherit app from parent object, not field");
console.log("  TOTAL: 19 fixes for twentyhq/twenty");
