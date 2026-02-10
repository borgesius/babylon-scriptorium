import { join } from "node:path"

import { calculateCost } from "../core/Pricing.js"
import { EventBus } from "../events/EventBus.js"
import type { TaskBotEvent } from "../events/types.js"
import { createLLMProvider } from "../llm/index.js"
import { FileStore } from "../persistence/FileStore.js"
import { createRenderer } from "../renderer/index.js"
import type { Renderer } from "../renderer/types.js"
import { getToolsForRole } from "../tools/definitions.js"
import type {
    AgentCostEntry,
    BabylonConfig,
    CostBreakdown,
    LLMProvider,
    RunResult,
    TokenUsage,
    WorkflowCostSummary,
} from "../types.js"
import { WorkflowEngine } from "../workflow/WorkflowEngine.js"
import { TaskManager } from "./TaskManager.js"

export class Orchestrator {
    private readonly config: BabylonConfig
    private readonly eventBus: EventBus
    private readonly providers: Record<string, LLMProvider> = {}
    private readonly store: FileStore
    private readonly taskManager: TaskManager
    private readonly renderer: Renderer | null
    private readonly abortController: AbortController
    private readonly agentCosts: AgentCostEntry[] = []
    private totalTokens: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
    }
    private currentRunTaskId: string | null = null

    constructor(config: BabylonConfig) {
        this.config = config
        this.eventBus = new EventBus()
        this.abortController = new AbortController()

        const persistencePath =
            config.persistencePath ?? join(config.workingDirectory, ".babylon")
        this.store = new FileStore(persistencePath)
        this.taskManager = new TaskManager(this.store)

        if (config.providers && Object.keys(config.providers).length > 0) {
            for (const [key, provider] of Object.entries(config.providers)) {
                this.providers[key] = provider
            }
        } else {
            if (config.openaiApiKey) {
                this.providers.openai = createLLMProvider(
                    "openai",
                    config.openaiApiKey
                )
            }
            if (config.anthropicApiKey) {
                this.providers.anthropic = createLLMProvider(
                    "anthropic",
                    config.anthropicApiKey
                )
            }
        }

        this.renderer = createRenderer(config.renderer ?? "terminal", {
            verbose: config.verbose ?? false,
            runLogPath: config.runLogPath,
        })
        if (this.renderer) {
            this.renderer.attach(this.eventBus)
        }

        this.eventBus.on((event: TaskBotEvent) => this.handleEvent(event))
    }

    public async run(description: string): Promise<RunResult> {
        const task = await this.taskManager.create(description)
        this.currentRunTaskId = task.id
        await this.taskManager.updateStatus(task.id, "in_progress")
        const startTime = Date.now()

        try {
            const engine = new WorkflowEngine({
                providers: this.providers,
                getToolsForRole,
                eventBus: this.eventBus,
                config: this.config,
                abortSignal: this.abortController.signal,
            })

            const result = await engine.run(description, task.id)

            const status =
                result.status === "completed" ? "completed" : "failed"
            await this.taskManager.updateStatus(task.id, status)

            for (const artifact of result.artifacts) {
                await this.taskManager.addArtifact(task.id, artifact)
            }

            if (this.renderer) {
                this.renderer.detach()
            }

            return {
                taskId: task.id,
                status,
                artifacts: result.artifacts,
                tokenUsage: { ...this.totalTokens },
                costSummary: this.buildCostSummary(),
                duration: Date.now() - startTime,
            }
        } catch (error) {
            await this.taskManager.updateStatus(task.id, "failed")
            if (this.renderer) {
                this.renderer.detach()
            }
            throw error
        } finally {
            this.currentRunTaskId = null
        }
    }

    public abort(): void {
        this.abortController.abort()
    }

    private handleEvent(event: TaskBotEvent): void {
        if (event.type === "token:update") {
            this.totalTokens.promptTokens += event.usage.promptTokens
            this.totalTokens.completionTokens += event.usage.completionTokens
            this.totalTokens.totalTokens += event.usage.totalTokens

            if (this.config.budgetDollars) {
                const totalCost = this.calculateTotalCost()
                if (totalCost >= this.config.budgetDollars) {
                    this.abortController.abort()
                }
            }
        }

        if (event.type === "step:complete") {
            const cost = calculateCost(event.model, event.tokenUsage)
            this.agentCosts.push({
                agentId: event.stepId,
                role: event.role,
                model: event.model,
                tokenUsage: event.tokenUsage,
                cost,
                turns: 0,
                stepId: event.stepId,
            })

            this.eventBus.emit({
                type: "cost:update",
                totalCost: this.buildTotalCost(),
                byRole: this.buildCostByRole(),
                byModel: this.buildCostByModel(),
            })
        }

        if (event.type === "subtask:start" && this.currentRunTaskId) {
            const rootId = event.taskId
            if (rootId === this.currentRunTaskId) {
                void this.persistSubtask(rootId, event.description).catch(
                    () => {}
                )
            }
        }
    }

    private async persistSubtask(
        parentId: string,
        description: string
    ): Promise<void> {
        const child = await this.taskManager.create(description, parentId)
        await this.taskManager.addSubtask(parentId, child.id)
    }

    private calculateTotalCost(): number {
        return this.agentCosts.reduce(
            (sum, entry) => sum + entry.cost.totalCost,
            0
        )
    }

    private buildTotalCost(): CostBreakdown {
        return this.agentCosts.reduce(
            (acc, entry) => ({
                inputCost: acc.inputCost + entry.cost.inputCost,
                outputCost: acc.outputCost + entry.cost.outputCost,
                totalCost: acc.totalCost + entry.cost.totalCost,
            }),
            { inputCost: 0, outputCost: 0, totalCost: 0 }
        )
    }

    private buildCostByRole(): Record<
        string,
        { cost: CostBreakdown; tokenUsage: TokenUsage; agentCount: number }
    > {
        const byRole: Record<
            string,
            { cost: CostBreakdown; tokenUsage: TokenUsage; agentCount: number }
        > = {}
        for (const entry of this.agentCosts) {
            const existing = byRole[entry.role] ?? {
                cost: { inputCost: 0, outputCost: 0, totalCost: 0 },
                tokenUsage: {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                },
                agentCount: 0,
            }
            existing.cost.inputCost += entry.cost.inputCost
            existing.cost.outputCost += entry.cost.outputCost
            existing.cost.totalCost += entry.cost.totalCost
            existing.tokenUsage.promptTokens += entry.tokenUsage.promptTokens
            existing.tokenUsage.completionTokens +=
                entry.tokenUsage.completionTokens
            existing.tokenUsage.totalTokens += entry.tokenUsage.totalTokens
            existing.agentCount++
            byRole[entry.role] = existing
        }
        return byRole
    }

    private buildCostByModel(): Record<
        string,
        { cost: CostBreakdown; tokenUsage: TokenUsage }
    > {
        const byModel: Record<
            string,
            { cost: CostBreakdown; tokenUsage: TokenUsage }
        > = {}
        for (const entry of this.agentCosts) {
            const existing = byModel[entry.model] ?? {
                cost: { inputCost: 0, outputCost: 0, totalCost: 0 },
                tokenUsage: {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                },
            }
            existing.cost.inputCost += entry.cost.inputCost
            existing.cost.outputCost += entry.cost.outputCost
            existing.cost.totalCost += entry.cost.totalCost
            existing.tokenUsage.promptTokens += entry.tokenUsage.promptTokens
            existing.tokenUsage.completionTokens +=
                entry.tokenUsage.completionTokens
            existing.tokenUsage.totalTokens += entry.tokenUsage.totalTokens
            byModel[entry.model] = existing
        }
        return byModel
    }

    private buildCostSummary(): WorkflowCostSummary {
        return {
            totalCost: this.buildTotalCost(),
            totalTokens: { ...this.totalTokens },
            byAgent: [...this.agentCosts],
            byRole: this.buildCostByRole(),
            byModel: this.buildCostByModel(),
        }
    }
}
