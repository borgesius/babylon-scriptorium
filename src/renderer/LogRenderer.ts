import { formatCost } from "../core/Pricing.js"
import type { EventBus } from "../events/EventBus.js"
import type { TaskBotEvent } from "../events/types.js"
import type { TokenUsage } from "../types.js"
import { getRoleLabel } from "./roleLabels.js"
import type { Renderer } from "./types.js"

export class LogRenderer implements Renderer {
    private bus: EventBus | null = null
    private handler: ((event: TaskBotEvent) => void) | null = null
    private startedAt = 0

    public attach(bus: EventBus): void {
        this.bus = bus
        this.handler = (event: TaskBotEvent): void => this.handleEvent(event)
        this.bus.on(this.handler)
    }

    public detach(): void {
        if (this.bus && this.handler) {
            this.bus.off(this.handler)
        }
        this.bus = null
        this.handler = null
    }

    private handleEvent(event: TaskBotEvent): void {
        const line = this.formatEvent(event)
        if (line) {
            const elapsed = this.formatElapsed()
            process.stdout.write(`[${elapsed}] ${line}\n`)
        }
    }

    private formatElapsed(): string {
        if (!this.startedAt) this.startedAt = Date.now()
        const seconds = (Date.now() - this.startedAt) / 1000
        const minutes = Math.floor(seconds / 60)
        const secs = (seconds % 60).toFixed(1)
        return `${String(minutes).padStart(2, "0")}:${secs.padStart(4, "0")}`
    }

    private formatEvent(event: TaskBotEvent): string | null {
        switch (event.type) {
            case "workflow:start":
                return `workflow:start  ${event.workflowName}  ${event.taskId}  "${truncate(event.taskDescription, 60)}"`
            case "workflow:complete":
                return `workflow:done   ${event.status}  ${formatDuration(event.duration)}`
            case "step:start":
                return `step:start      ${pad(event.stepId)}  ${getRoleLabel(event.role)}`
            case "step:complete":
                return `step:complete   ${pad(event.stepId)}  ${event.status}  ${formatDuration(event.duration * 1000)}  ${formatTokens(event.tokenUsage)} tok`
            case "step:retry":
                return `step:retry      ${pad(event.stepId)}  attempt ${event.attempt}/${event.maxRetries}  "${event.reason}"`
            case "agent:spawn":
                return `agent:spawn     ${getRoleLabel(event.role).padEnd(16)}  ${event.agentId.slice(0, 8)}`
            case "agent:tool_call": {
                const argsStr =
                    event.toolArgs != null
                        ? "  " + JSON.stringify(event.toolArgs).slice(0, 60)
                        : ""
                return `agent:tool      ${event.agentId.slice(0, 8).padEnd(16)}  ${event.toolName}${argsStr}`
            }
            case "agent:content":
                return `agent:content   ${event.agentId.slice(0, 8).padEnd(16)}  ${truncate(event.content, 80)}`
            case "agent:tool_result":
                return `agent:tool_res  ${event.agentId.slice(0, 8).padEnd(16)}  ${event.toolName}  ${event.isError ? "ERROR" : "ok"}  ${event.duration.toFixed(0)}ms`
            case "agent:complete":
                return `agent:done      ${event.agentId.slice(0, 8).padEnd(16)}  ${event.status}`
            case "task:status_change":
                return `task:status     ${event.taskId.slice(0, 8).padEnd(16)}  ${event.from} → ${event.to}`
            case "task:subtask_created":
                return `task:subtask    ${event.parentId.slice(0, 8)} → ${event.childId.slice(0, 8)}  "${truncate(event.description, 40)}"`
            case "subtask:start":
                return `subtask:start   ${event.subtaskId.slice(0, 8)}  ${event.index + 1}/${event.total}  "${truncate(event.description, 40)}"`
            case "subtask:complete":
                return `subtask:done    ${event.subtaskId.slice(0, 8)}  ${event.status}`
            case "composite_cycle:start":
                return `composite_cycle ${event.cycle}/${event.maxCycles}  Steward deciding`
            case "oracle:invoked":
                return `oracle:invoked  ${truncate(event.snapshotSummary, 60)}`
            case "oracle:decision":
                return `oracle:decision  ${event.action}`
            case "oversight:check_in":
                return `oversight:check_in  depth=${event.depth}  subtaskIndex=${event.subtaskIndex ?? "—"}  hasNudge=${event.hasNudge}`
            case "agent:turn":
                return null
            case "token:update":
                return null
            case "cost:update":
                return `cost:update     total ${formatCost(event.totalCost.totalCost)}`
            default:
                return null
        }
    }
}

function pad(str: string): string {
    return str.padEnd(16)
}

function truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 1) + "…"
}

function formatDuration(ms: number): string {
    const seconds = ms / 1000
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.round(seconds % 60)
    return `${minutes}m${String(remainingSeconds).padStart(2, "0")}s`
}

function formatTokens(usage: TokenUsage): string {
    const total = usage.totalTokens
    if (total < 1000) return String(total)
    return `${(total / 1000).toFixed(1)}k`
}
