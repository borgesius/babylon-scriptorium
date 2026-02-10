import { writeFileSync } from "node:fs"

import chalk from "chalk"
import logUpdate from "log-update"

import { calculateCost, formatCost } from "../core/Pricing.js"
import type { EventBus } from "../events/EventBus.js"
import type { TaskBotEvent } from "../events/types.js"
import type { AgentRole, CostBreakdown, TokenUsage } from "../types.js"
import { ROLE_LABELS } from "./roleLabels.js"
import type { Renderer, RenderNode, RenderNodeStatus } from "./types.js"

const STATUS_GLYPHS: Record<RenderNodeStatus, string> = {
    pending: chalk.dim("·"),
    running: chalk.blue("⟳"),
    completed: chalk.green("✓"),
    failed: chalk.red("✗"),
    retrying: chalk.yellow("↻"),
}

const MAX_PROCESS_STEPS = 24

export class TerminalRenderer implements Renderer {
    private readonly verbose: boolean
    private readonly runLogPath: string | undefined
    private bus: EventBus | null = null
    private handler: ((event: TaskBotEvent) => void) | null = null
    private nodes: RenderNode[] = []
    private agentToNode: Map<string, RenderNode> = new Map()
    private stepToNode: Map<string, RenderNode> = new Map()
    private taskDescription = ""
    private workflowStartedAt = 0
    private tickInterval: ReturnType<typeof setInterval> | null = null

    constructor(options?: { verbose?: boolean; runLogPath?: string }) {
        this.verbose = options?.verbose ?? false
        this.runLogPath = options?.runLogPath
    }
    private cumulativeTokens: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
    }
    private totalCost: CostBreakdown = {
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
    }
    private costByRole: Record<
        string,
        { cost: CostBreakdown; tokenUsage: TokenUsage; agentCount: number }
    > = {}
    private costByModel: Record<
        string,
        { cost: CostBreakdown; tokenUsage: TokenUsage }
    > = {}
    private workflowComplete = false
    private workflowFailed = false
    private stepModels: Map<string, string> = new Map()
    private lastRenderedOutput = ""
    private subtaskStack: string[] = []
    private subtaskIdToNode: Map<string, RenderNode> = new Map()

    public attach(bus: EventBus): void {
        this.bus = bus
        this.handler = (event: TaskBotEvent): void => this.handleEvent(event)
        this.bus.on(this.handler)
    }

    public detach(): void {
        if (this.bus && this.handler) {
            this.bus.off(this.handler)
        }
        this.stopTick()
        this.bus = null
        this.handler = null
    }

    private startTick(): void {
        if (this.tickInterval) return
        this.tickInterval = setInterval(() => this.render(), 1000)
    }

    private stopTick(): void {
        if (this.tickInterval) {
            clearInterval(this.tickInterval)
            this.tickInterval = null
        }
    }

    private handleEvent(event: TaskBotEvent): void {
        switch (event.type) {
            case "workflow:start":
                this.taskDescription = event.taskDescription
                this.workflowStartedAt = Date.now()
                this.startTick()
                break
            case "workflow:complete":
                this.workflowComplete = true
                this.workflowFailed = event.status === "failed"
                this.stopTick()
                this.flushRunLog()
                break
            case "step:start":
                this.onStepStart(event)
                break
            case "step:complete":
                this.onStepComplete(event)
                break
            case "step:retry":
                this.onStepRetry(event)
                break
            case "agent:spawn":
                this.onAgentSpawn(event)
                break
            case "agent:turn":
                this.onAgentTurn(event)
                break
            case "agent:tool_call":
                this.onAgentToolCall(event)
                break
            case "agent:content":
                this.onAgentContent(event)
                break
            case "agent:tool_result":
                this.onAgentToolResult(event)
                break
            case "agent:complete":
                this.onAgentComplete(event)
                break
            case "token:update":
                this.cumulativeTokens = event.cumulativeUsage
                break
            case "cost:update":
                this.totalCost = event.totalCost
                this.costByRole = event.byRole
                this.costByModel = event.byModel
                break
            case "task:status_change":
            case "task:subtask_created":
                break
            case "subtask:start":
                this.onSubtaskStart(event)
                break
            case "subtask:complete":
                this.onSubtaskComplete(event)
                break
            case "composite_cycle:start":
                this.onCompositeCycleStart(event)
                break
            case "oracle:invoked":
            case "oracle:decision":
                break
            case "oversight:check_in":
                this.onOversightCheckIn(event)
                break
        }
        this.render()
    }

    private onSubtaskStart(
        event: Extract<TaskBotEvent, { type: "subtask:start" }>
    ): void {
        const label = `Subtask ${event.index + 1}/${event.total}: ${this.truncateLabel(event.description)}`
        const node: RenderNode = {
            id: event.subtaskId,
            label,
            status: "running",
            startedAt: Date.now(),
            children: [],
        }
        if (this.subtaskStack.length > 0) {
            const parent = this.subtaskIdToNode.get(
                this.subtaskStack[this.subtaskStack.length - 1]
            )
            if (parent) parent.children.push(node)
        } else {
            this.nodes.push(node)
        }
        this.subtaskStack.push(event.subtaskId)
        this.subtaskIdToNode.set(event.subtaskId, node)
    }

    private onSubtaskComplete(
        event: Extract<TaskBotEvent, { type: "subtask:complete" }>
    ): void {
        const node = this.subtaskIdToNode.get(event.subtaskId)
        if (node) {
            node.status = event.status === "completed" ? "completed" : "failed"
            node.completedAt = Date.now()
        }
        const idx = this.subtaskStack.indexOf(event.subtaskId)
        if (idx !== -1) this.subtaskStack.splice(idx, 1)
    }

    private onCompositeCycleStart(
        event: Extract<TaskBotEvent, { type: "composite_cycle:start" }>
    ): void {
        const node: RenderNode = {
            id: `composite-cycle-${event.cycle}-${Date.now()}`,
            label: `Composite QA needs_review — cycle ${event.cycle}/${event.maxCycles} (Steward deciding)`,
            status: "running",
            startedAt: Date.now(),
            children: [],
        }
        this.nodes.push(node)
    }

    private onOversightCheckIn(
        event: Extract<TaskBotEvent, { type: "oversight:check_in" }>
    ): void {
        const label =
            event.subtaskIndex != null
                ? `Oversight check-in depth ${event.depth} subtask ${event.subtaskIndex + 1}${event.hasNudge ? " — nudge" : ""}`
                : `Oversight check-in depth ${event.depth}${event.hasNudge ? " — nudge" : ""}`
        const node: RenderNode = {
            id: `oversight-${event.depth}-${event.subtaskIndex ?? 0}-${Date.now()}`,
            label,
            status: "completed",
            startedAt: Date.now(),
            completedAt: Date.now(),
            children: [],
        }
        this.nodes.push(node)
    }

    private truncateLabel(text: string, max = 40): string {
        if (text.length <= max) return text
        return text.slice(0, max - 3) + "..."
    }

    private formatToolArgs(args: Record<string, unknown>): string {
        const parts = Object.entries(args)
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => {
                const s =
                    typeof v === "string"
                        ? v.length > 80
                            ? v.slice(0, 77) + "…"
                            : v
                        : JSON.stringify(v)
                return `${k}=${s.includes(" ") ? JSON.stringify(s) : s}`
            })
        return parts.length ? parts.join(" ") : ""
    }

    private onStepStart(
        event: Extract<TaskBotEvent, { type: "step:start" }>
    ): void {
        const node: RenderNode = {
            id: event.stepId,
            label: ROLE_LABELS[event.role] ?? event.role,
            status: "running",
            role: event.role,
            startedAt: Date.now(),
            children: [],
        }
        const parent =
            event.subtaskId != null
                ? this.subtaskIdToNode.get(event.subtaskId)
                : this.subtaskStack.length > 0
                  ? this.subtaskIdToNode.get(
                        this.subtaskStack[this.subtaskStack.length - 1]
                    )
                  : null
        if (parent) parent.children.push(node)
        else this.nodes.push(node)
        this.stepToNode.set(event.stepId, node)
        this.stepModels.set(event.stepId, event.model)
    }

    private onStepComplete(
        event: Extract<TaskBotEvent, { type: "step:complete" }>
    ): void {
        const node = this.stepToNode.get(event.stepId)
        if (!node) return
        node.status = event.status === "completed" ? "completed" : "failed"
        node.completedAt = Date.now()
        node.tokenUsage = event.tokenUsage
        node.currentTool = undefined
        node.currentTurn = undefined

        if (event.tokenUsage) {
            node.model = event.model
            node.cost = calculateCost(event.model, event.tokenUsage)
        }
    }

    private onStepRetry(
        event: Extract<TaskBotEvent, { type: "step:retry" }>
    ): void {
        const node = this.stepToNode.get(event.stepId)
        if (!node) return
        node.status = "retrying"
        node.retryInfo = { attempt: event.attempt, max: event.maxRetries }
    }

    private onAgentSpawn(
        event: Extract<TaskBotEvent, { type: "agent:spawn" }>
    ): void {
        if (event.stepId) {
            const stepNode = this.stepToNode.get(event.stepId)
            if (stepNode) {
                this.agentToNode.set(event.agentId, stepNode)
            }
        } else if (event.parentAgentId) {
            const parentNode = this.agentToNode.get(event.parentAgentId)
            if (parentNode) {
                const childNode: RenderNode = {
                    id: event.agentId,
                    label: `${ROLE_LABELS[event.role] ?? event.role}: ${truncate(event.taskDescription, 40)}`,
                    status: "running",
                    role: event.role,
                    startedAt: Date.now(),
                    children: [],
                }
                parentNode.children.push(childNode)
                this.agentToNode.set(event.agentId, childNode)
            }
        }
    }

    private onAgentTurn(
        event: Extract<TaskBotEvent, { type: "agent:turn" }>
    ): void {
        const node = this.agentToNode.get(event.agentId)
        if (!node) return
        node.currentTurn = { current: event.turnNumber, max: event.maxTurns }
        if (!node.processSteps) node.processSteps = []
        node.processSteps.push(`Turn ${event.turnNumber}`)
        if (node.processSteps.length > MAX_PROCESS_STEPS) {
            node.processSteps.shift()
        }
    }

    private static readonly MAX_TOOL_HISTORY = 10

    private static readonly MAX_TOOL_DETAILS = 20
    private static readonly MAX_CONTENT_SNIPPETS = 8
    private static readonly VERBOSE_CONTENT_LEN = 200

    private onAgentToolCall(
        event: Extract<TaskBotEvent, { type: "agent:tool_call" }>
    ): void {
        const node = this.agentToNode.get(event.agentId)
        if (!node) return
        node.currentTool = event.toolName
        if (!node.toolCallHistory) node.toolCallHistory = []
        node.toolCallHistory.push(event.toolName)
        if (node.toolCallHistory.length > TerminalRenderer.MAX_TOOL_HISTORY) {
            node.toolCallHistory.shift()
        }
        if (!node.processSteps) node.processSteps = []
        node.processSteps.push(event.toolName)
        if (node.processSteps.length > MAX_PROCESS_STEPS) {
            node.processSteps.shift()
        }
        if (this.verbose && event.toolArgs != null) {
            if (!node.toolCallDetails) node.toolCallDetails = []
            node.toolCallDetails.push({
                toolName: event.toolName,
                args: event.toolArgs,
            })
            if (
                node.toolCallDetails.length > TerminalRenderer.MAX_TOOL_DETAILS
            ) {
                node.toolCallDetails.shift()
            }
        }
    }

    private onAgentContent(
        event: Extract<TaskBotEvent, { type: "agent:content" }>
    ): void {
        if (!this.verbose) return
        const node = this.agentToNode.get(event.agentId)
        if (!node) return
        if (!node.contentSnippets) node.contentSnippets = []
        const snippet =
            event.content.length > TerminalRenderer.VERBOSE_CONTENT_LEN
                ? event.content.slice(0, TerminalRenderer.VERBOSE_CONTENT_LEN) +
                  "…"
                : event.content
        node.contentSnippets.push(snippet)
        if (
            node.contentSnippets.length > TerminalRenderer.MAX_CONTENT_SNIPPETS
        ) {
            node.contentSnippets.shift()
        }
    }

    private onAgentToolResult(
        event: Extract<TaskBotEvent, { type: "agent:tool_result" }>
    ): void {
        const node = this.agentToNode.get(event.agentId)
        if (!node) return
        node.currentTool = undefined
    }

    private onAgentComplete(
        event: Extract<TaskBotEvent, { type: "agent:complete" }>
    ): void {
        const node = this.agentToNode.get(event.agentId)
        if (!node) return
        node.summary = event.summary
    }

    private render(): void {
        const lines: string[] = []

        lines.push(
            `${chalk.bold.cyan("babylon-scriptorium")}  ${chalk.dim(this.taskDescription)}`
        )
        lines.push(chalk.dim("│"))

        for (let i = 0; i < this.nodes.length; i++) {
            const isLast = i === this.nodes.length - 1
            this.renderNode(
                this.nodes[i],
                lines,
                isLast ? "└" : "├",
                isLast ? " " : "│"
            )
        }

        const completedSteps = this.countByStatus("completed")
        const totalSteps = this.countAllNodes()
        const tokenStr = formatTokenCount(this.cumulativeTokens.totalTokens)
        const costStr = formatCost(this.totalCost.totalCost)
        const elapsedStr = this.workflowStartedAt
            ? formatDuration(Date.now() - this.workflowStartedAt)
            : ""

        lines.push(chalk.dim("│"))
        lines.push(
            chalk.dim(
                `${this.workflowComplete ? "├" : "└"}─ ${completedSteps}/${totalSteps} steps  ·  ${tokenStr} tokens  ·  ${costStr}${elapsedStr ? `  ·  ${elapsedStr}` : ""}`
            )
        )

        if (this.workflowComplete) {
            this.renderCostBreakdown(lines)
            lines.push(chalk.dim("│"))
            if (this.workflowFailed) {
                lines.push(chalk.red("╰─ Lost in the labyrinth"))
            } else {
                lines.push(chalk.green("╰─ The garden resolves"))
            }
        }

        const output = lines.join("\n")
        this.lastRenderedOutput = output
        logUpdate(output)
    }

    private flushRunLog(): void {
        if (!this.runLogPath) return
        try {
            const header = `Input: ${this.taskDescription}\n\n---\n\n`
            writeFileSync(
                this.runLogPath,
                header + this.lastRenderedOutput,
                "utf-8"
            )
        } catch {
            /* ignore write errors */
        }
    }

    private renderNode(
        node: RenderNode,
        lines: string[],
        connector: string,
        childPrefix: string
    ): void {
        const glyph = STATUS_GLYPHS[node.status]
        const elapsed = formatNodeElapsed(node)
        const tokens = node.tokenUsage
            ? chalk.dim(`${formatTokenCount(node.tokenUsage.totalTokens)} tok`)
            : ""
        const costTag = node.cost
            ? chalk.dim(formatCost(node.cost.totalCost))
            : ""
        const retryTag = node.retryInfo
            ? chalk.yellow(
                  ` ← the mirror reflects (${node.retryInfo.attempt}/${node.retryInfo.max})`
              )
            : ""

        const mainLine = [
            chalk.dim(`${connector}─`),
            glyph,
            node.label,
            elapsed ? chalk.dim(elapsed) : "",
            tokens,
            costTag,
            retryTag,
        ]
            .filter(Boolean)
            .join("  ")

        lines.push(mainLine)

        const details: string[] = []

        if (this.verbose) {
            if (node.status === "running") {
                if (node.currentTurn) {
                    details.push(
                        `turn ${node.currentTurn.current}/${node.currentTurn.max}`
                    )
                }
                if (node.currentTool) {
                    details.push(`tool: ${node.currentTool}`)
                }
            }
            if (node.processSteps?.length) {
                details.push(`process: ${node.processSteps.join(" → ")}`)
            } else if (node.toolCallHistory?.length) {
                details.push(`tools: ${node.toolCallHistory.join(" → ")}`)
            }
            for (const snippet of node.contentSnippets ?? []) {
                const oneLine = snippet.replace(/\s+/g, " ").trim()
                if (oneLine) {
                    details.push(`thought: ${oneLine}`)
                }
            }
            for (const td of node.toolCallDetails ?? []) {
                const argsStr = this.formatToolArgs(td.args)
                if (argsStr) {
                    details.push(`  ${td.toolName} ${argsStr}`)
                } else {
                    details.push(`  ${td.toolName}`)
                }
            }
        }

        if (node.summary && node.status === "completed") {
            details.push(node.summary)
        }

        const hasChildren = node.children.length > 0

        for (let i = 0; i < details.length; i++) {
            const isLastDetail = i === details.length - 1 && !hasChildren
            const detailConnector = isLastDetail ? "└─" : "├─"
            lines.push(
                chalk.dim(`${childPrefix}  ${detailConnector} ${details[i]}`)
            )
        }

        for (let i = 0; i < node.children.length; i++) {
            const isLastChild = i === node.children.length - 1
            this.renderNode(
                node.children[i],
                lines,
                `${childPrefix}  ${isLastChild ? "└" : "├"}`,
                `${childPrefix}  ${isLastChild ? " " : "│"}`
            )
        }
    }

    private renderCostBreakdown(lines: string[]): void {
        lines.push(chalk.dim("│"))
        lines.push(chalk.dim("├─ Cost Breakdown"))

        const total = this.totalCost.totalCost

        if (Object.keys(this.costByRole).length > 0) {
            const roleParts = Object.entries(this.costByRole)
                .sort(([, a], [, b]) => b.cost.totalCost - a.cost.totalCost)
                .map(([role, data]) => {
                    const pct =
                        total > 0
                            ? Math.round((data.cost.totalCost / total) * 100)
                            : 0
                    const label = ROLE_LABELS[role as AgentRole] ?? role
                    return `${label} ${formatCost(data.cost.totalCost)} (${pct}%)`
                })
                .join("  ·  ")
            lines.push(chalk.dim(`│  By role:    ${roleParts}`))
        }

        if (Object.keys(this.costByModel).length > 0) {
            const modelParts = Object.entries(this.costByModel)
                .sort(([, a], [, b]) => b.cost.totalCost - a.cost.totalCost)
                .map(([model, data]) => {
                    const pct =
                        total > 0
                            ? Math.round((data.cost.totalCost / total) * 100)
                            : 0
                    const shortModel = model.replace(/-\d{8}$/, "")
                    return `${shortModel} ${formatCost(data.cost.totalCost)} (${pct}%)`
                })
                .join("  ·  ")
            lines.push(chalk.dim(`│  By model:   ${modelParts}`))
        }

        const inTokens = formatTokenCount(this.cumulativeTokens.promptTokens)
        const outTokens = formatTokenCount(
            this.cumulativeTokens.completionTokens
        )
        lines.push(
            chalk.dim(`│  Tokens:     ${inTokens} in  ·  ${outTokens} out`)
        )
    }

    private countByStatus(status: RenderNodeStatus): number {
        let count = 0
        const walk = (nodes: RenderNode[]): void => {
            for (const node of nodes) {
                if (node.status === status) count++
                walk(node.children)
            }
        }
        walk(this.nodes)
        return count
    }

    private countAllNodes(): number {
        let count = 0
        const walk = (nodes: RenderNode[]): void => {
            for (const node of nodes) {
                count++
                walk(node.children)
            }
        }
        walk(this.nodes)
        return count
    }
}

function formatNodeElapsed(node: RenderNode): string {
    if (!node.startedAt) return ""
    const end = node.completedAt ?? Date.now()
    return formatDuration(end - node.startedAt)
}

function formatDuration(ms: number): string {
    const seconds = ms / 1000
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.round(seconds % 60)
    return `${minutes}m${String(remainingSeconds).padStart(2, "0")}s`
}

function formatTokenCount(tokens: number): string {
    if (tokens < 1000) return String(tokens)
    return `${(tokens / 1000).toFixed(1)}k`
}

function truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 1) + "…"
}
