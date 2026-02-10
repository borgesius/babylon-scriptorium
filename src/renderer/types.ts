import type { EventBus } from "../events/EventBus.js"
import type { AgentRole, CostBreakdown, TokenUsage } from "../types.js"

export type RenderNodeStatus =
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "retrying"

export interface RenderNode {
    id: string
    label: string
    status: RenderNodeStatus
    role?: AgentRole
    startedAt?: number
    completedAt?: number
    tokenUsage?: TokenUsage
    cost?: CostBreakdown
    model?: string
    currentTool?: string
    currentTurn?: { current: number; max: number }
    retryInfo?: { attempt: number; max: number }
    summary?: string
    toolCallHistory?: string[]
    processSteps?: string[]
    contentSnippets?: string[]
    toolCallDetails?: { toolName: string; args: Record<string, unknown> }[]
    children: RenderNode[]
}

export interface CreateRendererOptions {
    verbose?: boolean
    runLogPath?: string
}

export interface Renderer {
    attach(bus: EventBus): void
    detach(): void
}
