import { isThreadSpawnRequest } from "./effort-policy";
import type { RequestLogContext } from "./request-log";

export type AgentThreadStatus = "active" | "completed" | "error";
export type AgentNodeStatus = "running" | "idle" | "completed" | "error";

export interface AgentNode {
  id: string;
  parentId: string | null;
  name: string;
  role: string;
  model: string;
  status: AgentNodeStatus;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  lastActiveAt: string;
  errorReason?: string;
  // Hierarchical view support for GUI / API clients
  children?: AgentNode[];
}

export interface AgentThread {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  status: AgentThreadStatus;
  agents: Record<string, AgentNode>;
}

export interface AgentGraphResponse {
  threads: Array<{
    id: string;
    title: string;
    name?: string;
    startedAt: string;
    updatedAt: string;
    status: AgentThreadStatus;
    root: AgentNode;
    agents: AgentNode[];
  }>;
  updatedAt: string;
}

const MAX_TRACKED_THREADS = 100;

export class AgentGraphTracker {
  private static instance: AgentGraphTracker | null = null;
  private threads = new Map<string, AgentThread>();

  public static getInstance(): AgentGraphTracker {
    if (!AgentGraphTracker.instance) {
      AgentGraphTracker.instance = new AgentGraphTracker();
    }
    return AgentGraphTracker.instance;
  }

  public static resetForTests(): void {
    AgentGraphTracker.instance = new AgentGraphTracker();
  }

  /**
   * Extracts thread and agent identity from incoming request headers and context.
   */
  public resolveContext(headers: Headers, reqBody?: unknown): {
    threadId: string;
    agentId: string;
    parentId: string | null;
    isSubagent: boolean;
    role: string;
    name: string;
  } {
    const isSubagent = isThreadSpawnRequest(headers);
    const parentThreadHeader = headers.get("x-codex-parent-thread-id")?.trim();
    const threadIdHeader = headers.get("thread-id")?.trim();
    const sessionIdHeader = headers.get("session_id")?.trim() || headers.get("session-id")?.trim();

    let metaSubagentKind: string | undefined;
    let metaThreadId: string | undefined;
    const turnMetaRaw = headers.get("x-codex-turn-metadata");
    if (turnMetaRaw) {
      try {
        const parsed = JSON.parse(turnMetaRaw) as { subagent_kind?: string; thread_id?: string };
        metaSubagentKind = typeof parsed.subagent_kind === "string" ? parsed.subagent_kind : undefined;
        metaThreadId = typeof parsed.thread_id === "string" ? parsed.thread_id : undefined;
      } catch {
        // ignore malformed JSON
      }
    }

    // Thread ID resolution
    const threadId = parentThreadHeader || threadIdHeader || sessionIdHeader || metaThreadId || "default-session";

    // Agent ID and hierarchy resolution
    let agentId = "main-agent";
    let parentId: string | null = null;
    let role = "Coordinator";
    let name = "Main Agent";

    if (isSubagent || metaSubagentKind === "thread_spawn") {
      const specificId = threadIdHeader && threadIdHeader !== parentThreadHeader ? threadIdHeader : sessionIdHeader;
      agentId = specificId ? `subagent-${specificId}` : `subagent-${Date.now()}`;
      parentId = "main-agent";
      role = "Worker";
      name = "Sub-agent";
    }

    return {
      threadId,
      agentId,
      parentId,
      isSubagent,
      role,
      name,
    };
  }

  public recordRequestStart(params: {
    threadId: string;
    agentId: string;
    parentId?: string | null;
    name?: string;
    role?: string;
    model: string;
  }): void {
    const now = new Date().toISOString();
    let thread = this.threads.get(params.threadId);

    if (!thread) {
      // LRU eviction if capacity exceeded
      if (this.threads.size >= MAX_TRACKED_THREADS) {
        const oldestKey = this.threads.keys().next().value;
        if (oldestKey !== undefined) this.threads.delete(oldestKey);
      }
      thread = {
        id: params.threadId,
        title: `Thread ${params.threadId.slice(0, 8)}`,
        startedAt: now,
        updatedAt: now,
        status: "active",
        agents: {},
      };
      this.threads.set(params.threadId, thread);
    } else {
      thread.updatedAt = now;
      if (thread.status === "completed") {
        thread.status = "active";
      }
    }

    let agent = thread.agents[params.agentId];
    if (!agent) {
      agent = {
        id: params.agentId,
        parentId: params.parentId ?? null,
        name: params.name || (params.parentId ? "Sub-agent" : "Main Agent"),
        role: params.role || (params.parentId ? "Worker" : "Coordinator"),
        model: params.model,
        status: "running",
        turnCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        lastActiveAt: now,
      };
      thread.agents[params.agentId] = agent;
    } else {
      agent.status = "running";
      agent.turnCount += 1;
      agent.lastActiveAt = now;
      if (params.model && params.model !== "unknown") {
        agent.model = params.model;
      }
    }
  }

  public recordRequestEnd(params: {
    threadId: string;
    agentId: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    status: number;
    errorReason?: string;
  }): void {
    const thread = this.threads.get(params.threadId);
    if (!thread) return;

    const now = new Date().toISOString();
    thread.updatedAt = now;

    const agent = thread.agents[params.agentId];
    if (agent) {
      agent.lastActiveAt = now;
      if (params.model && params.model !== "unknown") {
        agent.model = params.model;
      }
      if (params.inputTokens && params.inputTokens > 0) {
        agent.inputTokens += params.inputTokens;
      }
      if (params.outputTokens && params.outputTokens > 0) {
        agent.outputTokens += params.outputTokens;
      }

      if (params.status >= 400 && params.status !== 499) {
        agent.status = "error";
        agent.errorReason = params.errorReason || `HTTP ${params.status}`;
        thread.status = "error";
      } else {
        agent.status = "idle";
      }
    }

    // Check if all agents are idle
    const allIdle = Object.values(thread.agents).every(a => a.status === "idle" || a.status === "completed");
    if (allIdle && thread.status === "active") {
      thread.status = "active"; // Keep active for interaction until explicitly completed or inactive
    }
  }

  public markThreadCompleted(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.status = "completed";
    thread.updatedAt = new Date().toISOString();
    for (const agent of Object.values(thread.agents)) {
      if (agent.status === "running" || agent.status === "idle") {
        agent.status = "completed";
      }
    }
  }

  public getSnapshot(): AgentGraphResponse {
    const now = new Date().toISOString();
    const resultThreads: AgentGraphResponse["threads"] = [];

    for (const thread of this.threads.values()) {
      const agentList = Object.values(thread.agents);
      if (agentList.length === 0) continue;

      // Find root (parentId === null) or create a synthetic root
      let rootAgent = agentList.find(a => a.parentId === null);
      if (!rootAgent) {
        rootAgent = agentList[0]!;
      }

      // Build hierarchical tree
      const agentMap = new Map<string, AgentNode>();
      for (const a of agentList) {
        agentMap.set(a.id, { ...a, children: [] });
      }

      const rootNode = agentMap.get(rootAgent.id)!;
      for (const a of agentMap.values()) {
        if (a.id !== rootNode.id && a.parentId && agentMap.has(a.parentId)) {
          agentMap.get(a.parentId)!.children!.push(a);
        } else if (a.id !== rootNode.id && a.parentId === null) {
          // If multiple roots, attach as child of main root
          rootNode.children!.push(a);
        }
      }

      resultThreads.push({
        id: thread.id,
        title: thread.title,
        name: thread.title,
        startedAt: thread.startedAt,
        updatedAt: thread.updatedAt,
        status: thread.status,
        root: rootNode,
        agents: Array.from(agentMap.values()),
      });
    }

    // Sort by most recently updated
    resultThreads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return {
      threads: resultThreads,
      updatedAt: now,
    };
  }
}

export const agentGraphTracker = AgentGraphTracker.getInstance();

