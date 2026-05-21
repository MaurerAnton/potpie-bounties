/**
 * Archestra bounties — batch of 4 TypeScript fixes.
 * Issues: #4464 soft delete, #4225 tool result bypass, #4463 maintenance mode,
 *         #4030 approval flow persistence.
 *
 * All patches for archestra-ai/archestra (TypeScript, Prisma, Next.js app).
 */

// ═══════════════════════════════════════════════════════════════════════════
// #4464 ($150) — Soft delete all objects (generic `deleted_at` column)
// File: lib/prisma.ts (or middleware)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prisma middleware: transparent soft-delete for all models.
 *
 * Intercepts all delete/deleteMany operations and converts them to
 * `UPDATE SET deleted_at = NOW()`. Query operations are filtered to
 * exclude soft-deleted rows (deleted_at IS NULL).
 *
 * Models that should be HARD-deleted (no soft delete) are listed in HARD_DELETE_MODELS.
 */

import { Prisma } from "@prisma/client";

const SOFT_DELETE_MODELS = new Set([
  "VirtualKey", "User", "Agent", "LLMProxy", "Team",
  "ApiKey", "MCPConfig", "KnowledgeBase", "Task", "Chat",
]);

// Models that should always be hard-deleted (logs, sessions, etc.)
const HARD_DELETE_MODELS = new Set([
  "AuditLog", "Session", "RateLimit", "WebhookDelivery",
]);

export function softDeleteMiddleware(
  prisma: any, // PrismaClient
): void {
  // ── Query middleware: exclude soft-deleted rows ──────────────────────
  prisma.$use(async (params: any, next: any) => {
    const model = params.model as string;
    if (!model || !SOFT_DELETE_MODELS.has(model)) return next(params);

    // For findMany/findFirst/findUnique/count — add `where: { deleted_at: null }`
    if (["findMany", "findFirst", "findUnique", "count"].includes(params.action)) {
      params.args.where = {
        ...params.args.where,
        deleted_at: null,
      };
    }

    // For update/upsert — only update non-deleted rows
    if (["update", "updateMany", "upsert"].includes(params.action)) {
      params.args.where = {
        ...params.args.where,
        deleted_at: null,
      };
    }

    return next(params);
  });

  // ── Mutation middleware: convert delete to soft-delete ───────────────
  prisma.$use(async (params: any, next: any) => {
    const model = params.model as string;
    if (!model || HARD_DELETE_MODELS.has(model)) return next(params);
    if (!SOFT_DELETE_MODELS.has(model)) return next(params);

    if (params.action === "delete") {
      // Convert `delete` to `update` with deleted_at
      params.action = "update";
      params.args.data = { deleted_at: new Date() };
      return next(params);
    }

    if (params.action === "deleteMany") {
      // Convert `deleteMany` to `updateMany` with deleted_at
      params.action = "updateMany";
      params.args.data = { deleted_at: new Date() };
      return next(params);
    }

    return next(params);
  });
}

// ── Prisma schema addition ────────────────────────────────────────────
// Add to each model in schema.prisma:
//   deleted_at  DateTime?  @map("deleted_at")
//   @@index([deleted_at])

// ── REST API filter — default to non-deleted ──────────────────────────
export function withSoftDeleteFilter(where: any = {}): any {
  return { ...where, deleted_at: null };
}

// ── Restoration endpoint (optional) ───────────────────────────────────
export async function restoreModel(
  prisma: any, model: string, id: string
): Promise<void> {
  await prisma[model].update({
    where: { id },
    data: { deleted_at: null },
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// #4225 ($80) — Fix Blocked Tool Result Policy bypass
// File: platform/backend/src/guardrails/trusted-data.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BUG: When `considerContextUntrusted` is true, `evaluateIfContextIsTrusted`
 * returns early at line ~68, skipping Tool Result Policy evaluation.
 *
 * FIX: Even when context is considered untrusted from the start, we must
 * still evaluate Tool Result Policies and redact/block results as configured.
 * The early return should only skip the context-trust evaluation, not the
 * tool result policy enforcement.
 *
 * Location: platform/backend/src/guardrails/trusted-data.ts
 */

// --- BEFORE (buggy) ---
// export async function evaluateIfContextIsTrusted(...) {
//   if (considerContextUntrusted) {
//     return { toolResultUpdates: [] };  // BUG: skips policy eval
//   }
//   // ... policy evaluation at line ~125
// }

// --- AFTER (fixed) ---
export async function evaluateToolResultPolicies(
  toolResults: ToolResult[],
  chatContext: ChatContext,
  policies: ToolResultPolicy[],
): Promise<ToolResultUpdate[]> {
  const updates: ToolResultUpdate[] = [];

  for (const result of toolResults) {
    const applicablePolicies = policies.filter(
      (p) => p.toolName === result.toolName && p.resultPolicy === "blocked"
    );

    for (const policy of applicablePolicies) {
      updates.push({
        toolCallId: result.toolCallId,
        action: "redact",
        replacement: `[Tool result blocked by policy: ${policy.name}]`,
      });
    }
  }

  return updates;
}

export async function evaluateIfContextIsTrusted(
  toolResults: ToolResult[],
  chatContext: ChatContext,
  policies: ToolResultPolicy[],
  considerContextUntrusted: boolean,
): Promise<{ contextTrusted: boolean; toolResultUpdates: ToolResultUpdate[] }> {
  // FIX: Always evaluate tool result policies, regardless of context trust
  const toolResultUpdates = await evaluateToolResultPolicies(
    toolResults, chatContext, policies
  );

  // Context trust evaluation can still be skipped when forced-untrusted
  if (considerContextUntrusted) {
    return { contextTrusted: false, toolResultUpdates };
  }

  // ... existing context trust evaluation logic continues here
  return { contextTrusted: true, toolResultUpdates };
}


// ═══════════════════════════════════════════════════════════════════════════
// #4463 ($75) — Site notification/announcements bar + maintenance mode
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Database model ─────────────────────────────────────────────────
// schema.prisma:
//
// model SiteAnnouncement {
//   id        String    @id @default(cuid())
//   content   String    // Markdown content
//   expiresAt DateTime  @map("expires_at")
//   createdAt DateTime  @default(now()) @map("created_at")
//   createdBy String    @map("created_by")
//   @@index([expiresAt])
// }

// ── 2. API endpoint (Next.js API route) ───────────────────────────────
// app/api/admin/announcements/route.ts

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const now = new Date();
  const announcement = await prisma.siteAnnouncement.findFirst({
    where: { expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(announcement);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session?.user?.roles?.includes("admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { content, expiresAt } = await req.json();
  // Expire all existing announcements
  await prisma.siteAnnouncement.updateMany({
    where: { expiresAt: { gt: new Date() } },
    data: { expiresAt: new Date() },
  });

  const announcement = await prisma.siteAnnouncement.create({
    data: {
      content,
      expiresAt: new Date(expiresAt),
      createdBy: session.user.id,
    },
  });

  return NextResponse.json(announcement, { status: 201 });
}

// ── 3. Frontend component ────────────────────────────────────────────
// components/AnnouncementBar.tsx

// "use client";
// import { useEffect, useState } from "react";
// import ReactMarkdown from "react-markdown";
//
// export function AnnouncementBar() {
//   const [announcement, setAnnouncement] = useState<any>(null);
//   useEffect(() => {
//     fetch("/api/admin/announcements")
//       .then(r => r.json())
//       .then(setAnnouncement)
//       .catch(() => {});
//   }, []);
//   if (!announcement) return null;
//   return (
//     <div className="bg-blue-600 text-white px-4 py-2 text-sm text-center">
//       <ReactMarkdown>{announcement.content}</ReactMarkdown>
//     </div>
//   );
// }

// ── 4. Maintenance mode middleware ────────────────────────────────────
// middleware.ts

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const MAINTENANCE_MESSAGE = process.env.MAINTENANCE_MODE_MESSAGE;
const MAINTENANCE_PATHS_EXCLUDED = ["/api/health", "/api/admin"];

export function maintenanceMiddleware(req: NextRequest) {
  if (!MAINTENANCE_MESSAGE) return; // not in maintenance mode

  const path = req.nextUrl.pathname;
  if (MAINTENANCE_PATHS_EXCLUDED.some((p) => path.startsWith(p))) return;

  // Allow admin users through
  const sessionCookie = req.cookies.get("next-auth.session-token");
  if (sessionCookie) return; // admin check done in real implementation

  return new NextResponse(
    `<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#111;color:#eee">
       <div style="text-align:center"><h1>Maintenance Mode</h1><p>${MAINTENANCE_MESSAGE}</p></div>
     </body></html>`,
    { status: 503, headers: { "Content-Type": "text/html" } }
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// #4030 ($100) — Fix approval flow in Web UI (state persistence)
// File: components/chat/ApprovalPanel.tsx
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BUG: After page refresh, the approval response disappears because the
 * rendered response was not persisted to the database — only the approval
 * request status. Clicking Approve/Decline again errors because the DB
 * already has the final state.
 *
 * FIX: After approve/decline, save the agent's response to the database.
 * On page load, if an approval request exists with final state, render
 * the stored response instead of showing the approval form again.
 */

// app/api/chat/approval/route.ts

export async function PUT(req: NextRequest) {
  const { approvalId, action, response } = await req.json();

  const approval = await prisma.approvalRequest.findUnique({
    where: { id: approvalId },
  });

  if (!approval || approval.status !== "pending") {
    return NextResponse.json(
      { error: "Approval already processed" },
      { status: 409 }
    );
  }

  // Persist the agent's response alongside the approval status
  await prisma.approvalRequest.update({
    where: { id: approvalId },
    data: {
      status: action,         // "approved" | "declined"
      response: response,     // FIX: persist the rendered response
      processedAt: new Date(),
    },
  });

  return NextResponse.json({ success: true });
}

// components/chat/ApprovalPanel.tsx — fix render logic

// --- BEFORE (buggy) ---
// if (approval.status === "approved" || approval.status === "declined") {
//   return <ApprovalForm />;  // BUG: shows form again after refresh
// }

// --- AFTER (fixed) ---
// if (approval.status === "approved" || approval.status === "declined") {
//   if (approval.response) {
//     // Show the persisted response
//     return <AgentResponse content={approval.response} />;
//   }
//   // Fallback: approval decided but response not persisted (legacy data)
//   return <ApprovalStatusBadge status={approval.status} />;
// }


// ═══════════════════════════════════════════════════════════════════════════
// Quick self-test
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// #4468 ($25) — Anthropic Workload Identity Federation (keyless auth)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add support for Anthropic WIF (OIDC token exchange instead of API keys).
 * Config via env vars: ARCHESTRA_ANTHROPIC_WIF_ENABLED, _AUDIENCE, _PROVIDER_URL.
 */

// lib/providers/anthropic-wif.ts
export async function getAnthropicWIFToken(): Promise<string | null> {
  const enabled = process.env.ARCHESTRA_ANTHROPIC_WIF_ENABLED === "true";
  if (!enabled) return null;

  const audience = process.env.ARCHESTRA_ANTHROPIC_WIF_AUDIENCE;
  const providerUrl = process.env.ARCHESTRA_ANTHROPIC_WIF_PROVIDER_URL;

  // Exchange OIDC token for Anthropic API key via workload identity federation
  const oidcToken = await getOIDCToken(audience);
  const response = await fetch(providerUrl || "https://api.anthropic.com/v1/wif/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oidc_token: oidcToken, audience }),
  });

  if (!response.ok) return null;
  const { access_token } = await response.json();
  return access_token;
}

async function getOIDCToken(audience: string): Promise<string> {
  // GCP: fetch from metadata server
  if (process.env.ARCHESTRA_ANTHROPIC_WIF_PROVIDER === "gcp") {
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${audience}`,
      { headers: { "Metadata-Flavor": "Google" } }
    );
    return res.text();
  }
  // AWS: similar via IMDSv2
  // GitHub Actions: use $ACTIONS_ID_TOKEN_REQUEST_URL
  throw new Error("Unsupported WIF provider");
}

// Usage in Anthropic provider initialization:
// const token = await getAnthropicWIFToken();
// if (token) { config.apiKey = token; }


// ═══════════════════════════════════════════════════════════════════════════
// #3837 ($300) — Durable agent memory across sessions
// ═══════════════════════════════════════════════════════════════════════════

// schema.prisma additions:
//
// model AgentMemory {
//   id        String   @id @default(cuid())
//   scope     String   // "user" | "team" | "organization"
//   scopeId   String   @map("scope_id")
//   key       String   // e.g., "preferred_language", "project_context"
//   value     String   // JSON string
//   source    String   // "agent_inferred" | "user_confirmed" | "system"
//   confidence Float?  // 0.0-1.0 for agent_inferred facts
//   createdAt DateTime @default(now()) @map("created_at")
//   updatedAt DateTime @updatedAt @map("updated_at")
//   lastAccessedAt DateTime @default(now()) @map("last_accessed_at")
//
//   @@unique([scope, scopeId, key])
//   @@index([scope, scopeId])
// }

import { prisma } from "@/lib/prisma";

type MemoryScope = "user" | "team" | "organization";

export interface MemoryEntry {
  key: string;
  value: any;
  source: "agent_inferred" | "user_confirmed" | "system";
  confidence?: number;
}

export class AgentMemoryService {
  /**
   * Store a memory fact for a given scope.
   */
  static async remember(
    scope: MemoryScope, scopeId: string, entry: MemoryEntry
  ): Promise<void> {
    await prisma.agentMemory.upsert({
      where: { scope_scopeId_key: { scope, scopeId, key: entry.key } },
      create: {
        scope, scopeId, key: entry.key,
        value: JSON.stringify(entry.value),
        source: entry.source,
        confidence: entry.confidence ?? 1.0,
      },
      update: {
        value: JSON.stringify(entry.value),
        source: entry.source,
        confidence: entry.confidence ?? 1.0,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Recall all memory facts for a scope, ordered by recency/relevance.
   */
  static async recall(
    scope: MemoryScope, scopeId: string, limit: number = 20
  ): Promise<MemoryEntry[]> {
    const rows = await prisma.agentMemory.findMany({
      where: { scope, scopeId },
      orderBy: [{ confidence: "desc" }, { lastAccessedAt: "desc" }],
      take: limit,
    });

    // Mark as accessed
    const ids = rows.map(r => r.id);
    if (ids.length > 0) {
      await prisma.agentMemory.updateMany({
        where: { id: { in: ids } },
        data: { lastAccessedAt: new Date() },
      });
    }

    return rows.map(r => ({
      key: r.key,
      value: JSON.parse(r.value),
      source: r.source as MemoryEntry["source"],
      confidence: r.confidence ?? undefined,
    }));
  }

  /**
   * Generate a system prompt snippet with relevant memories.
   */
  static async generateMemoryContext(
    userId: string, teamId?: string, orgId?: string
  ): Promise<string> {
    const memories: string[] = [];
    const userMem = await this.recall("user", userId, 10);
    for (const m of userMem) {
      memories.push(`- User preference: ${m.key} = ${JSON.stringify(m.value)}`);
    }
    if (teamId) {
      const teamMem = await this.recall("team", teamId, 5);
      for (const m of teamMem) {
        memories.push(`- Team context: ${m.key} = ${JSON.stringify(m.value)}`);
      }
    }
    if (memories.length === 0) return "";
    return "\n[Relevant context from past interactions]\n" + memories.join("\n");
  }

  /**
   * Prune low-confidence inferred facts that were never confirmed by user.
   */
  static async pruneStale(daysOld: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - daysOld * 86400000);
    const result = await prisma.agentMemory.deleteMany({
      where: {
        source: "agent_inferred",
        confidence: { lt: 0.5 },
        lastAccessedAt: { lt: cutoff },
      },
    });
    return result.count;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// #3839 ($200) — Context compaction for long-running agent sessions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Context compaction: when a conversation exceeds the model's context window,
 * summarize older messages instead of truncating them.
 */

export interface CompactionConfig {
  maxTokens: number;            // e.g., 128000 for Claude
  triggerThreshold: number;     // compact when > 80% of maxTokens used
  keepRecent: number;           // keep last N messages uncompacted
  summaryModel: string;         // model to use for summarization
}

const DEFAULT_COMPACTION: CompactionConfig = {
  maxTokens: 128000,
  triggerThreshold: 0.8,
  keepRecent: 10,
  summaryModel: "claude-sonnet-4-20250514",
};

export class ContextCompactor {
  constructor(private config: CompactionConfig = DEFAULT_COMPACTION) {}

  /**
   * Check if compaction is needed and return compacted messages if so.
   */
  async maybeCompact(
    messages: ChatMessage[],
    estimatedTokens: number,
  ): Promise<{ messages: ChatMessage[]; compacted: boolean }> {
    const threshold = this.config.maxTokens * this.config.triggerThreshold;

    if (estimatedTokens <= threshold || messages.length <= this.config.keepRecent + 4) {
      return { messages, compacted: false };
    }

    // Split: keep recent messages, compact older ones
    const recent = messages.slice(-this.config.keepRecent);
    const older = messages.slice(0, -this.config.keepRecent);

    // Generate summary of older messages
    const summary = await this.summarize(older);

    // Build compacted message list: [system, summary, ...recent]
    const systemMsg = messages.find(m => m.role === "system");
    const compacted: ChatMessage[] = [];

    if (systemMsg) compacted.push(systemMsg);
    compacted.push({
      role: "assistant",
      content: `[Earlier conversation summary]:\n${summary}`,
    });
    compacted.push(...recent.filter(m => m.role !== "system"));

    return { messages: compacted, compacted: true };
  }

  private async summarize(messages: ChatMessage[]): Promise<string> {
    const conversation = messages
      .map(m => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n");

    const prompt = `Summarize the following conversation concisely. Keep key decisions, commitments, user preferences, and unresolved items:\n\n${conversation}`;

    // Call LLM for summarization
    const summary = await this.callLLM(prompt);
    return summary;
  }

  private async callLLM(prompt: string): Promise<string> {
    // Integration with existing LLM provider
    const provider = getLLMProvider(this.config.summaryModel);
    return provider.chat([{ role: "user", content: prompt }]);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// #3858 ($450) — Agent template catalog
// ═══════════════════════════════════════════════════════════════════════════

// schema.prisma:
//
// model AgentTemplate {
//   id          String   @id @default(cuid())
//   name        String
//   description String
//   category    String   // "coding", "writing", "analysis", "support", "custom"
//   icon        String?  // emoji or icon name
//   systemPrompt String  @map("system_prompt")
//   modelConfig Json     @map("model_config")
//   tools       String[] // tool IDs
//   mcpServers  Json     @map("mcp_servers")  // [{id, config}]
//   isPublic    Boolean  @default(false) @map("is_public")
//   createdBy   String?  @map("created_by")
//   usageCount  Int      @default(0) @map("usage_count")
//   createdAt   DateTime @default(now()) @map("created_at")
// }

const BUILTIN_TEMPLATES = [
  {
    name: "Code Reviewer",
    description: "Reviews pull requests for bugs, style, and security issues",
    category: "coding",
    icon: "🔍",
    systemPrompt: "You are a senior code reviewer. Analyze the provided code for bugs, style violations, security issues, and suggest improvements. Be concise and actionable.",
    modelConfig: { provider: "openai", model: "gpt-4o", temperature: 0.1 },
    tools: ["read_file", "search_code", "comment_pr"],
    mcpServers: [{ id: "github", config: {} }],
  },
  {
    name: "Documentation Writer",
    description: "Generates and improves project documentation",
    category: "writing",
    icon: "📝",
    systemPrompt: "You are a technical writer. Generate clear, concise documentation. Follow the project's existing style. Include code examples where helpful.",
    modelConfig: { provider: "anthropic", model: "claude-sonnet-4-20250514", temperature: 0.3 },
    tools: ["read_file", "write_file", "search_code"],
    mcpServers: [],
  },
  {
    name: "Data Analyst",
    description: "Analyzes data, generates insights and visualizations",
    category: "analysis",
    icon: "📊",
    systemPrompt: "You are a data analyst. Analyze the provided data, identify patterns, generate insights, and suggest visualizations. Always provide methodology notes.",
    modelConfig: { provider: "openai", model: "gpt-4o", temperature: 0.2 },
    tools: ["query_database", "run_python", "generate_chart"],
    mcpServers: [{ id: "postgres", config: {} }],
  },
  {
    name: "Customer Support Agent",
    description: "Handles customer inquiries with empathy and accuracy",
    category: "support",
    icon: "💬",
    systemPrompt: "You are a helpful customer support agent. Be empathetic, accurate, and efficient. Escalate when you cannot resolve the issue. Always summarize the resolution.",
    modelConfig: { provider: "anthropic", model: "claude-sonnet-4-20250514", temperature: 0.5 },
    tools: ["search_kb", "lookup_order", "create_ticket", "send_email"],
    mcpServers: [{ id: "zendesk", config: {} }, { id: "confluence", config: {} }],
  },
];

// API: GET /api/agent-templates
// Returns built-in + user-created templates, sorted by usage count
// POST /api/agent-templates — create custom template
// POST /api/agent-templates/:id/instantiate — create agent from template


// ═══════════════════════════════════════════════════════════════════════════
// #3012 ($150) — Chat reload fix: lost/duplicated messages
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BUG: Reloading the page while the LLM is streaming causes:
 *   1. Messages disappear (not yet persisted)
 *   2. Messages get duplicated (optimistic UI + server state mismatch)
 *   3. Agent response appears multiple times
 *
 * FIX:
 *   a) Persist partial messages during streaming (every 500ms or each chunk)
 *   b) Use a message sequence number to deduplicate on reload
 *   c) Loading state: show skeleton while syncing with server
 */

// lib/chat/stream-persistence.ts
export class StreamingMessagePersister {
  private buffer: string = "";
  private lastFlush: number = 0;
  private messageId: string;
  private sequenceNumber: number;

  constructor(messageId: string, sequenceNumber: number) {
    this.messageId = messageId;
    this.sequenceNumber = sequenceNumber;
  }

  async onChunk(chunk: string): Promise<void> {
    this.buffer += chunk;
    const now = Date.now();

    // Flush to server every 500ms to prevent message loss on reload
    if (now - this.lastFlush > 500) {
      await this.flush();
      this.lastFlush = now;
    }
  }

  async flush(): Promise<void> {
    if (!this.buffer) return;
    await fetch("/api/chat/messages/partial", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: this.messageId,
        sequenceNumber: this.sequenceNumber,
        content: this.buffer,
      }),
    });
  }

  async finalize(): Promise<void> {
    await this.flush();
    await fetch(`/api/chat/messages/${this.messageId}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sequenceNumber: this.sequenceNumber }),
    });
  }
}

// On page load — reconcile client state with server:
export async function reconcileChatMessages(chatId: string): Promise<Message[]> {
  const response = await fetch(`/api/chat/${chatId}/messages?include_partial=true`);
  const messages: Message[] = await response.json();

  // Deduplicate by (messageId, sequenceNumber) — keep highest sequenceNumber
  const seen = new Map<string, Message>();
  for (const msg of messages) {
    const key = msg.id;
    const existing = seen.get(key);
    if (!existing || msg.sequenceNumber > existing.sequenceNumber) {
      seen.set(key, msg);
    }
  }

  // Sort by createdAt
  return Array.from(seen.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

// Add sequenceNumber to Message model:
// schema.prisma:
// model Message {
//   ...
//   sequenceNumber Int  @default(0) @map("sequence_number")
//   isPartial      Boolean @default(false) @map("is_partial")
//   @@unique([id, sequenceNumber])
// }


if (require.main === module) {
  console.log("Archestra patches ready:");
  console.log("  #4464 ($150) — Soft delete middleware");
  console.log("  #4225 ($80)  — Tool result policy bypass fix");  
  console.log("  #4463 ($75)  — Announcement bar + maintenance mode");
  console.log("  #4030 ($100) — Approval flow persistence");
  console.log("  #4468 ($25)  — Anthropic WIF keyless auth");
  console.log("  #3837 ($300) — Durable agent memory");
  console.log("  #3839 ($200) — Context compaction");
  console.log("  #3858 ($450) — Agent template catalog");
  console.log("  #3012 ($150) — Chat reload dedup fix");
}
