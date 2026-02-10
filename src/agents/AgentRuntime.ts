import { randomUUID } from "node:crypto"

import { log } from "../core/Logger.js"
import type { EventBus } from "../events/EventBus.js"
import type {
    AgentConfig,
    AgentResult,
    AgentResultStatus,
    AgentRole,
    ArtifactType,
    LLMMessage,
    LLMProvider,
    LLMResponse,
    LLMToolCall,
    TokenUsage,
    ToolContext,
    ToolDefinition,
} from "../types.js"

const MAX_CONSECUTIVE_DUPLICATES = 3
const LLM_MAX_RETRIES = 3
const LLM_RETRY_DELAYS = [1000, 2000, 4000]

interface AgentRuntimeOptions {
    config: AgentConfig
    provider: LLMProvider
    eventBus: EventBus
    toolContext: ToolContext
    abortSignal?: AbortSignal
    stepId?: string
    parentAgentId?: string
    initialContext?: string
}

export class AgentRuntime {
    private readonly agentId: string
    private readonly config: AgentConfig
    private readonly provider: LLMProvider
    private readonly eventBus: EventBus
    private readonly toolContext: ToolContext
    private readonly abortSignal?: AbortSignal
    private readonly stepId?: string
    private readonly parentAgentId?: string
    private readonly messages: LLMMessage[] = []
    private readonly toolMap: Map<string, ToolDefinition>
    private cumulativeUsage: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
    }
    private recentToolCalls: string[] = []
    private lastError: string | null = null

    constructor(options: AgentRuntimeOptions) {
        this.agentId = randomUUID()
        this.config = options.config
        this.provider = options.provider
        this.eventBus = options.eventBus
        this.toolContext = options.toolContext
        this.abortSignal = options.abortSignal
        this.stepId = options.stepId
        this.parentAgentId = options.parentAgentId

        this.toolMap = new Map(this.config.tools.map((t) => [t.name, t]))

        this.messages.push({
            role: "system",
            content: this.config.systemPrompt,
        })

        if (options.initialContext) {
            this.messages.push({
                role: "user",
                content: options.initialContext,
            })
        }
    }

    public async run(): Promise<AgentResult> {
        this.eventBus.emit({
            type: "agent:spawn",
            agentId: this.agentId,
            role: this.config.role,
            parentAgentId: this.parentAgentId,
            stepId: this.stepId,
            taskDescription:
                this.messages.find((m) => m.role === "user")?.content ?? "",
        })

        for (let turn = 1; turn <= this.config.maxTurns; turn++) {
            if (this.abortSignal?.aborted) {
                return this.buildResult("failed", "Aborted by user")
            }

            this.eventBus.emit({
                type: "agent:turn",
                agentId: this.agentId,
                turnNumber: turn,
                maxTurns: this.config.maxTurns,
            })

            if (turn === this.config.maxTurns) {
                this.messages.push({
                    role: "user",
                    content:
                        "This is your FINAL turn. You MUST call complete_task now with your best result so far. Do not call any other tools.",
                })
            }

            const response = await this.callLLMWithRetry()
            if (!response) {
                return this.buildResult(
                    "failed",
                    `LLM call failed after retries: ${this.lastError ?? "unknown error"}`
                )
            }

            this.accumulateUsage(response.usage)

            if (response.content?.trim()) {
                const truncated =
                    response.content.length > 2000
                        ? response.content.slice(0, 2000) + "\n[… truncated]"
                        : response.content
                this.eventBus.emit({
                    type: "agent:content",
                    agentId: this.agentId,
                    content: truncated,
                })
            }

            if (response.content) {
                this.messages.push({
                    role: "assistant",
                    content: response.content,
                    toolCalls:
                        response.toolCalls.length > 0
                            ? response.toolCalls
                            : undefined,
                })
            } else if (response.toolCalls.length > 0) {
                this.messages.push({
                    role: "assistant",
                    content: "",
                    toolCalls: response.toolCalls,
                })
            }

            if (response.toolCalls.length === 0) {
                if (response.stopReason === "end_turn") {
                    continue
                }
                continue
            }

            if (this.isStuckLoop(response.toolCalls)) {
                log.agent(
                    "Stuck loop detected for agent %s, breaking out",
                    this.agentId
                )
                return this.buildResult(
                    "needs_review",
                    "Agent appeared stuck in a loop — repeated the same tool call multiple times"
                )
            }

            const completionResult = await this.executeToolCalls(
                response.toolCalls
            )
            if (completionResult) {
                return completionResult
            }
        }

        return this.buildResult(
            "needs_review",
            "Agent reached maximum turns without completing"
        )
    }

    private getMessagesForLLM(): LLMMessage[] {
        const maxTurns = this.config.maxContextTurns
        if (!maxTurns || maxTurns <= 0) return this.messages
        const assistantIndices: number[] = []
        for (let i = 0; i < this.messages.length; i++) {
            if (this.messages[i].role === "assistant") assistantIndices.push(i)
        }
        if (assistantIndices.length <= maxTurns) return this.messages
        const startIndex =
            assistantIndices[assistantIndices.length - maxTurns] ?? 0
        return [
            this.messages[0],
            this.messages[1],
            ...this.messages.slice(startIndex),
        ]
    }

    private async callLLMWithRetry(): Promise<LLMResponse | null> {
        for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
            try {
                const messagesToSend = this.getMessagesForLLM()
                return await this.provider.chat(
                    messagesToSend,
                    this.config.tools,
                    this.config.model
                )
            } catch (error) {
                const errorMsg =
                    error instanceof Error ? error.message : String(error)
                this.lastError = errorMsg
                const isRetryable = this.isRetryableError(error)
                if (!isRetryable || attempt === LLM_MAX_RETRIES) {
                    log.llm(
                        "LLM call failed (attempt %d/%d): %s",
                        attempt + 1,
                        LLM_MAX_RETRIES + 1,
                        errorMsg
                    )
                    console.error(`[babylon] LLM error: ${errorMsg}`)
                    return null
                }
                const delay = LLM_RETRY_DELAYS[attempt] ?? 4000
                log.llm(
                    "LLM call failed (attempt %d/%d), retrying in %dms: %s",
                    attempt + 1,
                    LLM_MAX_RETRIES + 1,
                    delay,
                    errorMsg
                )
                await this.sleep(delay)
            }
        }
        return null
    }

    private isRetryableError(error: unknown): boolean {
        if (error instanceof Error) {
            const msg = error.message.toLowerCase()
            if (msg.includes("429") || msg.includes("rate limit")) return true
            if (
                msg.includes("500") ||
                msg.includes("502") ||
                msg.includes("503")
            )
                return true
            if (msg.includes("timeout") || msg.includes("econnreset"))
                return true
        }
        return false
    }

    private async executeToolCalls(
        toolCalls: LLMToolCall[]
    ): Promise<AgentResult | null> {
        for (const toolCall of toolCalls) {
            this.eventBus.emit({
                type: "agent:tool_call",
                agentId: this.agentId,
                toolName: toolCall.name,
                toolArgs: this.sanitizeToolArgs(toolCall.arguments),
            })

            const tool = this.toolMap.get(toolCall.name)
            const startTime = Date.now()

            if (!tool) {
                this.messages.push({
                    role: "tool",
                    content: `Unknown tool: ${toolCall.name}`,
                    toolCallId: toolCall.id,
                })
                this.eventBus.emit({
                    type: "agent:tool_result",
                    agentId: this.agentId,
                    toolName: toolCall.name,
                    isError: true,
                    duration: Date.now() - startTime,
                })
                continue
            }

            try {
                const result = await tool.execute(
                    toolCall.arguments,
                    this.toolContext
                )

                this.messages.push({
                    role: "tool",
                    content: result.content,
                    toolCallId: toolCall.id,
                })

                this.eventBus.emit({
                    type: "agent:tool_result",
                    agentId: this.agentId,
                    toolName: toolCall.name,
                    isError: result.isError,
                    duration: Date.now() - startTime,
                })

                if (toolCall.name === "complete_task") {
                    const parsed = this.parseCompletion(result.content)
                    if (parsed) {
                        return parsed
                    }
                    this.messages.push({
                        role: "user",
                        content:
                            "Your complete_task call had an invalid format. Please call complete_task again with valid status (completed/failed/needs_review), summary, and content fields.",
                    })
                }
            } catch (error) {
                const errorMsg = `Tool execution error: ${error instanceof Error ? error.message : String(error)}`
                this.messages.push({
                    role: "tool",
                    content: errorMsg,
                    toolCallId: toolCall.id,
                })
                this.eventBus.emit({
                    type: "agent:tool_result",
                    agentId: this.agentId,
                    toolName: toolCall.name,
                    isError: true,
                    duration: Date.now() - startTime,
                })
            }
        }

        return null
    }

    private parseCompletion(content: string): AgentResult | null {
        try {
            const parsed = JSON.parse(content) as Record<string, unknown>
            const status = parsed.status as string
            const summary = parsed.summary as string
            const taskContent = parsed.content as string

            if (
                !["completed", "failed", "needs_review"].includes(status) ||
                !summary ||
                !taskContent
            ) {
                return null
            }

            const result = this.buildResult(
                status as AgentResultStatus,
                summary,
                taskContent,
                parsed.handoff_notes as string | undefined,
                parsed.review_notes as string | undefined,
                parsed.metadata as Record<string, unknown> | undefined
            )

            this.eventBus.emit({
                type: "agent:complete",
                agentId: this.agentId,
                status: result.status,
                summary: result.artifact.content.slice(0, 100),
            })

            return result
        } catch {
            return null
        }
    }

    private sanitizeToolArgs(
        args: Record<string, unknown>
    ): Record<string, unknown> {
        const maxLen = 400
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(args)) {
            if (typeof v === "string" && v.length > maxLen) {
                out[k] = v.slice(0, maxLen) + "…"
            } else {
                out[k] = v
            }
        }
        return out
    }

    private isStuckLoop(currentCalls: LLMToolCall[]): boolean {
        const key = currentCalls
            .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
            .join("|")

        this.recentToolCalls.push(key)
        if (this.recentToolCalls.length > MAX_CONSECUTIVE_DUPLICATES) {
            this.recentToolCalls.shift()
        }

        if (this.recentToolCalls.length < MAX_CONSECUTIVE_DUPLICATES) {
            return false
        }

        return this.recentToolCalls.every((k) => k === this.recentToolCalls[0])
    }

    private buildResult(
        status: AgentResultStatus,
        summary: string,
        content?: string,
        handoffNotes?: string,
        reviewNotes?: string,
        metadata?: Record<string, unknown>
    ): AgentResult {
        const artifactTypeMap: Record<AgentRole, ArtifactType> = {
            analyzer: "analysis",
            planner: "spec",
            executor: "code_changes",
            reviewer: "review",
            coordinator: "coordination",
            steward: "management",
            oracle: "oracle",
        }
        const artifactType = artifactTypeMap[this.config.role]

        return {
            agentId: this.agentId,
            role: this.config.role,
            status,
            artifact: {
                type: artifactType,
                content: content ?? summary,
                metadata: {
                    ...metadata,
                    handoff_notes: handoffNotes ?? "",
                    review_notes: reviewNotes ?? "",
                },
                createdAt: new Date().toISOString(),
            },
            tokenUsage: { ...this.cumulativeUsage },
            conversationLog: [...this.messages],
        }
    }

    private accumulateUsage(usage: TokenUsage): void {
        this.cumulativeUsage.promptTokens += usage.promptTokens
        this.cumulativeUsage.completionTokens += usage.completionTokens
        this.cumulativeUsage.totalTokens += usage.totalTokens

        this.eventBus.emit({
            type: "token:update",
            agentId: this.agentId,
            usage,
            cumulativeUsage: { ...this.cumulativeUsage },
        })
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }
}
