import { randomUUID } from "node:crypto"

import { AgentRuntime } from "../agents/AgentRuntime.js"
import { getSystemPrompt } from "../agents/roles.js"
import { getDefaultMaxTurns, getDefaultModel } from "../core/Config.js"
import { WorkflowError } from "../core/errors.js"
import { log } from "../core/Logger.js"
import { formatStewardVoice } from "../core/stewardVoice.js"
import type { EventBus } from "../events/EventBus.js"
import type {
    AgentResult,
    AgentRole,
    Artifact,
    BabylonConfig,
    LLMProvider,
    OracleAction,
    PlannerOutput,
    StewardAction,
    SubtaskDef,
    TaskComplexity,
    ToolContext,
    ToolDefinition,
    WorkflowStatus,
} from "../types.js"
import { OrgChart } from "./OrgChart.js"
import { OversightTracker } from "./OversightTracker.js"
import {
    parseAnalyzerOutput,
    parseOracleOutput,
    parsePlannerOutput,
    parseStewardOutput,
} from "./parsers.js"

const DEFAULT_MAX_RETRIES = 2

interface WorkflowResult {
    status: WorkflowStatus
    artifacts: Artifact[]
    agentResults: AgentResult[]
}

interface RunTaskOptions {
    description: string
    depth?: number
    fileScope?: string[]
    skipAnalysis?: boolean
    parentContext?: string
    branchName?: string
    subtaskId?: string
}

export interface WorkflowEngineConfig {
    providers: Record<string, LLMProvider>
    getToolsForRole: (
        role: AgentRole,
        options?: { useCli?: boolean }
    ) => ToolDefinition[]
    eventBus: EventBus
    config: BabylonConfig
    abortSignal?: AbortSignal
}

export class WorkflowEngine {
    private readonly providers: Record<string, LLMProvider>
    private readonly getTools: (
        role: AgentRole,
        options?: { useCli?: boolean }
    ) => ToolDefinition[]
    private readonly eventBus: EventBus
    private readonly config: BabylonConfig
    private readonly abortSignal?: AbortSignal
    private readonly maxDepth: number
    private readonly maxRetries: number
    private readonly maxCompositeCycles: number
    private allAgentResults: AgentResult[] = []
    private taskCounter = 0
    private rootTaskId: string | null = null
    private currentSubtaskId: string | null = null
    private orgChart: OrgChart = new OrgChart()
    private oversightTracker: OversightTracker | null = null
    private compositeOversightContext: {
        originalDescription: string
        depth: number
        currentSubtaskIndex: number
        subtaskDescriptions: string[]
    } | null = null
    private oversightCycleCount = 0
    private lastAppliedNudge: string | null = null
    private pendingOversightNudge: string | null = null

    constructor(engineConfig: WorkflowEngineConfig) {
        this.providers = engineConfig.providers
        this.getTools = engineConfig.getToolsForRole
        this.eventBus = engineConfig.eventBus
        this.config = engineConfig.config
        this.abortSignal = engineConfig.abortSignal
        this.maxDepth = engineConfig.config.maxDepth ?? 2
        this.maxRetries = engineConfig.config.maxRetries ?? DEFAULT_MAX_RETRIES
        this.maxCompositeCycles = engineConfig.config.maxCompositeCycles ?? 2
    }

    private getComplexityDirectThreshold(): number {
        return this.config.complexityDirectThreshold ?? 0.35
    }

    private getCycleOptions(complexity: TaskComplexity): {
        executorMaxTurns?: number
        executorContextPrefix?: string
        reviewerMaxTurns?: number
        reviewerModel?: string
    } {
        const threshold = this.getComplexityDirectThreshold()
        if (complexity <= threshold) {
            return {
                executorMaxTurns: this.config.simplePathMaxTurns ?? 8,
                executorContextPrefix:
                    "This is a small task. Make the minimal change. Prefer read_file and write_file; avoid invoke_cursor_cli unless necessary. Use as few turns as possible.\n\n",
                reviewerMaxTurns: 5,
                reviewerModel: "gpt-4o-mini",
            }
        }
        return {}
    }

    public async run(
        taskDescription: string,
        taskId: string
    ): Promise<WorkflowResult> {
        this.rootTaskId = taskId
        this.orgChart = new OrgChart()
        this.orgChart.setRoot(taskId, taskDescription, false)
        this.oversightTracker = new OversightTracker(this.eventBus, {
            ...this.config.oversightThresholds,
        })
        this.oversightTracker.attach()

        this.eventBus.emit({
            type: "workflow:start",
            workflowName: "babylon-cycle",
            taskId,
            taskDescription,
        })

        const startTime = Date.now()

        try {
            const result = await this.runTask({
                description: taskDescription,
                depth: 0,
            })

            this.eventBus.emit({
                type: "workflow:complete",
                taskId,
                status: result.status,
                duration: Date.now() - startTime,
            })

            return result
        } catch (error) {
            log.workflow(
                "Workflow failed with error: %s",
                error instanceof Error ? error.message : String(error)
            )

            this.eventBus.emit({
                type: "workflow:complete",
                taskId,
                status: "failed",
                duration: Date.now() - startTime,
            })

            const toThrow =
                error instanceof Error
                    ? error instanceof WorkflowError
                        ? error
                        : new WorkflowError(error.message, error)
                    : new WorkflowError(String(error))
            throw toThrow
        } finally {
            this.oversightTracker?.detach()
            this.oversightTracker = null
            this.compositeOversightContext = null
            this.rootTaskId = null
        }
    }

    public getAgentResults(): AgentResult[] {
        return this.allAgentResults
    }

    private async runTask(options: RunTaskOptions): Promise<WorkflowResult> {
        const {
            description,
            depth = 0,
            fileScope,
            skipAnalysis = false,
            parentContext,
            subtaskId,
        } = options

        const previousSubtaskId = this.currentSubtaskId
        this.currentSubtaskId = subtaskId ?? null

        try {
            const artifacts: Artifact[] = []

            if (skipAnalysis) {
                return this.runExecuteReviewCycle(
                    description,
                    description,
                    fileScope,
                    depth,
                    { ...this.getCycleOptions(0.5), subtaskId }
                )
            }

            const analyzerResult = await this.runAgent(
                "analyzer",
                description,
                parentContext,
                fileScope,
                depth,
                { subtaskIdForEmit: subtaskId ?? undefined }
            )
            artifacts.push(analyzerResult.artifact)

            if (analyzerResult.status === "failed") {
                return {
                    status: "failed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            const analysis = parseAnalyzerOutput(analyzerResult)

            if (analysis.complexity <= this.getComplexityDirectThreshold()) {
                const handoff =
                    (analyzerResult.artifact.metadata
                        ?.handoff_notes as string) ?? ""
                const context = handoff
                    ? `${description}\n\nAnalysis: ${analysis.summary}\n\n${handoff}`
                    : `${description}\n\nAnalysis: ${analysis.summary}`
                const result = await this.runExecuteReviewCycle(
                    context,
                    description,
                    fileScope,
                    depth,
                    { ...this.getCycleOptions(analysis.complexity), subtaskId }
                )
                return {
                    ...result,
                    artifacts: [...artifacts, ...result.artifacts],
                }
            }

            const plannerContext = [
                `Task: ${description}`,
                `Complexity (0–1): ${analysis.complexity}`,
                `Analysis: ${analysis.summary}`,
                `Affected files: ${analysis.affectedFiles.join(", ")}`,
                `Recommended approach: ${analysis.recommendedApproach}`,
                (analyzerResult.artifact.metadata?.handoff_notes as string) ??
                    "",
            ]
                .filter(Boolean)
                .join("\n\n")

            const plannerResult = await this.runAgent(
                "planner",
                plannerContext,
                undefined,
                fileScope,
                depth,
                { subtaskIdForEmit: subtaskId ?? undefined }
            )
            artifacts.push(plannerResult.artifact)

            if (plannerResult.status === "failed") {
                return {
                    status: "failed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            const plannerOutput = parsePlannerOutput(plannerResult)

            if (plannerOutput.type === "spec") {
                const specContext = [
                    `Task: ${description}`,
                    `\nSpec:\n${plannerOutput.spec}`,
                    `\nAcceptance Criteria:\n${plannerOutput.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
                    `\nExpected files: ${plannerOutput.expectedFiles.join(", ")}`,
                ].join("\n")

                const result = await this.runExecuteReviewCycle(
                    specContext,
                    description,
                    plannerOutput.fileScope,
                    depth,
                    { ...this.getCycleOptions(analysis.complexity), subtaskId }
                )
                return {
                    ...result,
                    artifacts: [...artifacts, ...result.artifacts],
                }
            }

            if (depth >= this.maxDepth) {
                log.workflow(
                    "Max depth %d reached, forcing spec mode",
                    this.maxDepth
                )
                const forcedContext = `Task: ${description}\n\nThis task was going to be decomposed but max recursion depth was reached. Implement it as a single unit of work.`
                const result = await this.runExecuteReviewCycle(
                    forcedContext,
                    description,
                    fileScope,
                    depth,
                    { ...this.getCycleOptions(analysis.complexity), subtaskId }
                )
                return {
                    ...result,
                    artifacts: [...artifacts, ...result.artifacts],
                }
            }

            return this.runDecomposition(
                plannerOutput,
                description,
                depth,
                artifacts
            )
        } finally {
            this.currentSubtaskId = previousSubtaskId
        }
    }

    private filterDuplicateSetupSubtask(
        plan: Extract<PlannerOutput, { type: "decomposition" }>
    ): SubtaskDef[] {
        if (!plan.setupTask) return plan.subtasks
        const setupDesc = plan.setupTask.description.trim().toLowerCase()
        return plan.subtasks.filter((s) => {
            const d = s.description.trim().toLowerCase()
            if (d === setupDesc) return false
            const words = setupDesc.split(/\s+/).filter((w) => w.length > 2)
            const sameMeaning =
                words.length >= 2 && words.every((w) => d.includes(w))
            return !sameMeaning
        })
    }

    private haveOverlappingFileScopes(subtasks: SubtaskDef[]): boolean {
        const normalize = (p: string): string => p.replace(/\/$/, "") || "."
        for (let i = 0; i < subtasks.length; i++) {
            const a = (subtasks[i].fileScope ?? []).map(normalize)
            for (let j = i + 1; j < subtasks.length; j++) {
                const b = (subtasks[j].fileScope ?? []).map(normalize)
                if (a.length === 0 || b.length === 0) return true
                for (const pa of a) {
                    for (const pb of b) {
                        if (
                            pa === pb ||
                            pa.startsWith(pb + "/") ||
                            pb.startsWith(pa + "/")
                        )
                            return true
                    }
                }
            }
        }
        return false
    }

    private async runDecomposition(
        plan: Extract<PlannerOutput, { type: "decomposition" }>,
        originalDescription: string,
        depth: number,
        existingArtifacts: Artifact[]
    ): Promise<WorkflowResult> {
        const artifacts = [...existingArtifacts]

        const taskId = this.rootTaskId ?? randomUUID()
        if (depth === 0) {
            const rootNode = this.orgChart.getNode(taskId)
            if (rootNode) {
                rootNode.type = "composite"
                rootNode.hasSteward = true
            }
        }
        const subtasks = this.filterDuplicateSetupSubtask(plan)
        const parallel =
            plan.parallel && !this.haveOverlappingFileScopes(subtasks)
        if (subtasks.length < plan.subtasks.length) {
            log.workflow(
                "Filtered %d duplicate setup subtask(s)",
                plan.subtasks.length - subtasks.length
            )
        }
        if (plan.parallel && !parallel) {
            log.workflow(
                "Overlapping file scopes detected; running subtasks sequentially"
            )
        }
        const totalWithSetup = (plan.setupTask ? 1 : 0) + subtasks.length
        this.compositeOversightContext = {
            originalDescription,
            depth,
            currentSubtaskIndex: 0,
            subtaskDescriptions: subtasks.map((s) => s.description),
        }
        this.oversightCycleCount = 0

        try {
            if (plan.setupTask) {
                log.workflow("Running setup subtask before parallel work")
                const setupSubtaskId = randomUUID()
                this.orgChart.addChild(
                    setupSubtaskId,
                    taskId,
                    plan.setupTask.description,
                    depth + 1,
                    false
                )
                this.eventBus.emit({
                    type: "subtask:start",
                    taskId,
                    subtaskId: setupSubtaskId,
                    description: plan.setupTask.description,
                    index: 0,
                    total: totalWithSetup,
                })
                const setupResult = await this.runTask({
                    description: plan.setupTask.description,
                    depth: depth + 1,
                    fileScope: plan.setupTask.fileScope,
                    skipAnalysis: plan.setupTask.skipAnalysis,
                    parentContext: `Setup task for: ${originalDescription}`,
                    subtaskId: setupSubtaskId,
                })
                this.eventBus.emit({
                    type: "subtask:complete",
                    subtaskId: setupSubtaskId,
                    status: setupResult.status,
                })
                artifacts.push(...setupResult.artifacts)
                if (setupResult.status === "failed") {
                    return {
                        status: "failed",
                        artifacts,
                        agentResults: this.allAgentResults,
                    }
                }
            }

            let subtaskResults: WorkflowResult[]
            if (parallel) {
                log.workflow(
                    "The path forks — %d branches (parallel)",
                    subtasks.length
                )
                const subtaskIds = subtasks.map(() => randomUUID())
                subtasks.forEach((subtask, i) => {
                    this.orgChart.addChild(
                        subtaskIds[i],
                        taskId,
                        subtask.description,
                        depth + 1,
                        false
                    )
                    this.eventBus.emit({
                        type: "subtask:start",
                        taskId,
                        subtaskId: subtaskIds[i],
                        description: subtask.description,
                        index: i + (plan.setupTask ? 1 : 0),
                        total: totalWithSetup,
                    })
                })
                subtaskResults = await Promise.all(
                    subtasks.map((subtask, i) =>
                        this.runTask({
                            description: subtask.description,
                            depth: depth + 1,
                            fileScope: subtask.fileScope,
                            skipAnalysis: subtask.skipAnalysis,
                            parentContext: `Subtask of: ${originalDescription}`,
                            subtaskId: subtaskIds[i],
                        })
                    )
                )
                subtaskIds.forEach((subtaskId, i) => {
                    this.eventBus.emit({
                        type: "subtask:complete",
                        subtaskId,
                        status: subtaskResults[i].status,
                    })
                })
            } else {
                log.workflow(
                    "The path forks — %d branches (sequential)",
                    subtasks.length
                )
                subtaskResults = []
                for (let i = 0; i < subtasks.length; i++) {
                    const subtask = subtasks[i]
                    const subtaskId = randomUUID()
                    if (this.compositeOversightContext) {
                        this.compositeOversightContext.currentSubtaskIndex = i
                    }
                    await this.maybeOversightCheckIn()
                    let parentContext = `Subtask of: ${originalDescription}`
                    if (this.pendingOversightNudge) {
                        parentContext += `\n\n${formatStewardVoice(this.pendingOversightNudge)}`
                        this.lastAppliedNudge = this.pendingOversightNudge
                        this.pendingOversightNudge = null
                    }
                    this.orgChart.addChild(
                        subtaskId,
                        taskId,
                        subtask.description,
                        depth + 1,
                        false
                    )
                    this.eventBus.emit({
                        type: "subtask:start",
                        taskId,
                        subtaskId,
                        description: subtask.description,
                        index: i + (plan.setupTask ? 1 : 0),
                        total: totalWithSetup,
                    })
                    const result = await this.runTask({
                        description: subtask.description,
                        depth: depth + 1,
                        fileScope: subtask.fileScope,
                        skipAnalysis: subtask.skipAnalysis,
                        parentContext,
                        subtaskId,
                    })
                    if (this.lastAppliedNudge && this.oversightTracker) {
                        this.oversightTracker.recordNudgeOutcome(
                            this.lastAppliedNudge,
                            result.status
                        )
                        this.lastAppliedNudge = null
                    }
                    this.eventBus.emit({
                        type: "subtask:complete",
                        subtaskId,
                        status: result.status,
                    })
                    subtaskResults.push(result)
                    if (result.status === "failed") break
                }
            }

            for (const sr of subtaskResults) {
                artifacts.push(...sr.artifacts)
            }

            const anyFailed = subtaskResults.some((r) => r.status === "failed")
            if (anyFailed) {
                return {
                    status: "failed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            const buildSubtaskSummaries = (results: WorkflowResult[]): string =>
                results
                    .map((r, i) => {
                        const lastArtifact = r.artifacts[r.artifacts.length - 1]
                        return `Subtask ${i + 1}: ${lastArtifact?.content?.slice(0, 200) ?? "completed"}`
                    })
                    .join("\n\n")

            const buildCoordinatorContext = (
                summaries: string,
                reviewNotes?: string
            ): string => {
                const base = [
                    `Original task: ${originalDescription}`,
                    `\nCompleted subtasks:\n${summaries}`,
                    "\nMerge the results and verify coherence. Run the full test suite.",
                ].join("\n")
                if (reviewNotes) {
                    return `${base}\n\nPrevious verification found issues. Fix them:\n${reviewNotes}`
                }
                return base
            }

            log.workflow("Paths converge at the aleph")

            let subtaskSummaries = buildSubtaskSummaries(subtaskResults)
            let coordinatorContext = buildCoordinatorContext(subtaskSummaries)
            let coordinatorResult = await this.runAgent(
                "coordinator",
                coordinatorContext,
                undefined,
                undefined,
                depth
            )
            artifacts.push(coordinatorResult.artifact)

            let cycle = 0
            const qaDidNotPass =
                coordinatorResult.status === "needs_review" ||
                coordinatorResult.status === "failed"
            let lastReviewNotes =
                (coordinatorResult.artifact.metadata?.review_notes as string) ??
                ""

            while (qaDidNotPass && cycle < this.maxCompositeCycles) {
                cycle++
                log.workflow(
                    "Composite QA did not pass — management cycle %d/%d",
                    cycle,
                    this.maxCompositeCycles
                )
                this.eventBus.emit({
                    type: "composite_cycle:start",
                    cycle,
                    maxCycles: this.maxCompositeCycles,
                })

                let stewardAction = await this.runStewardAndParse(
                    originalDescription,
                    plan,
                    subtaskResults,
                    coordinatorResult,
                    lastReviewNotes,
                    depth
                )

                if (!stewardAction || stewardAction.action === "escalate") {
                    if (depth === 0) {
                        const oracleAction = await this.runOracle(
                            originalDescription,
                            plan,
                            subtaskResults,
                            coordinatorResult,
                            lastReviewNotes
                        )
                        if (
                            oracleAction?.action === "nudge_root_steward" &&
                            oracleAction.nudgeMessage
                        ) {
                            stewardAction = await this.runStewardAndParse(
                                originalDescription,
                                plan,
                                subtaskResults,
                                coordinatorResult,
                                lastReviewNotes,
                                depth,
                                oracleAction.nudgeMessage
                            )
                        } else if (oracleAction?.action === "retry_once") {
                            stewardAction = { action: "retry_merge" }
                        }
                    }
                    if (!stewardAction || stewardAction.action === "escalate") {
                        return {
                            status: "needs_review",
                            artifacts,
                            agentResults: this.allAgentResults,
                        }
                    }
                }

                if (stewardAction.action === "retry_merge") {
                    coordinatorContext = buildCoordinatorContext(
                        subtaskSummaries,
                        lastReviewNotes
                    )
                    coordinatorResult = await this.runAgent(
                        "coordinator",
                        coordinatorContext,
                        undefined,
                        undefined,
                        depth
                    )
                    artifacts.push(coordinatorResult.artifact)
                    lastReviewNotes =
                        (coordinatorResult.artifact.metadata
                            ?.review_notes as string) ?? ""
                    if (coordinatorResult.status === "completed") {
                        return {
                            status: "completed",
                            artifacts,
                            agentResults: this.allAgentResults,
                        }
                    }
                    continue
                }

                if (stewardAction.action === "retry_children") {
                    const indices = stewardAction.taskIndices ?? []
                    const focus = stewardAction.retryFocus ?? ""
                    for (const i of indices) {
                        if (i < 0 || i >= subtasks.length) continue
                        const subtask = subtasks[i]
                        const subtaskId = randomUUID()
                        this.eventBus.emit({
                            type: "subtask:start",
                            taskId,
                            subtaskId,
                            description: subtask.description,
                            index: i + (plan.setupTask ? 1 : 0),
                            total: totalWithSetup,
                        })
                        const baseContext = `Subtask of: ${originalDescription}`
                        const parentContext = focus
                            ? `${baseContext}\n\n${formatStewardVoice(focus)}`
                            : baseContext
                        const result = await this.runTask({
                            description: subtask.description,
                            depth: depth + 1,
                            fileScope: subtask.fileScope,
                            skipAnalysis: subtask.skipAnalysis,
                            parentContext,
                            subtaskId,
                        })
                        this.eventBus.emit({
                            type: "subtask:complete",
                            subtaskId,
                            status: result.status,
                        })
                        subtaskResults[i] = result
                        artifacts.push(...result.artifacts)
                    }
                    subtaskSummaries = buildSubtaskSummaries(subtaskResults)
                    coordinatorContext =
                        buildCoordinatorContext(subtaskSummaries)
                    coordinatorResult = await this.runAgent(
                        "coordinator",
                        coordinatorContext,
                        undefined,
                        undefined,
                        depth
                    )
                    artifacts.push(coordinatorResult.artifact)
                    lastReviewNotes =
                        (coordinatorResult.artifact.metadata
                            ?.review_notes as string) ?? ""
                    if (coordinatorResult.status === "completed") {
                        return {
                            status: "completed",
                            artifacts,
                            agentResults: this.allAgentResults,
                        }
                    }
                    continue
                }

                if (stewardAction.action === "add_fix_task") {
                    const fixDescription =
                        stewardAction.fixDescription ?? lastReviewNotes
                    const fixSubtaskId = randomUUID()
                    this.eventBus.emit({
                        type: "subtask:start",
                        taskId,
                        subtaskId: fixSubtaskId,
                        description: fixDescription,
                        index: totalWithSetup,
                        total: totalWithSetup + 1,
                    })
                    const fixResult = await this.runTask({
                        description: fixDescription,
                        depth: depth + 1,
                        skipAnalysis: true,
                        parentContext: `Fix task for: ${originalDescription}\n\n${formatStewardVoice(fixDescription)}`,
                        subtaskId: fixSubtaskId,
                    })
                    this.eventBus.emit({
                        type: "subtask:complete",
                        subtaskId: fixSubtaskId,
                        status: fixResult.status,
                    })
                    subtaskResults = [...subtaskResults, fixResult]
                    artifacts.push(...fixResult.artifacts)
                    subtaskSummaries = buildSubtaskSummaries(subtaskResults)
                    coordinatorContext =
                        buildCoordinatorContext(subtaskSummaries)
                    coordinatorResult = await this.runAgent(
                        "coordinator",
                        coordinatorContext,
                        undefined,
                        undefined,
                        depth
                    )
                    artifacts.push(coordinatorResult.artifact)
                    lastReviewNotes =
                        (coordinatorResult.artifact.metadata
                            ?.review_notes as string) ?? ""
                    if (coordinatorResult.status === "completed") {
                        return {
                            status: "completed",
                            artifacts,
                            agentResults: this.allAgentResults,
                        }
                    }
                    continue
                }

                if (stewardAction.action === "re_decompose") {
                    const plannerContext = `Re-decompose this task:\n${originalDescription}`
                    const plannerResult = await this.runAgent(
                        "planner",
                        plannerContext,
                        undefined,
                        undefined,
                        depth
                    )
                    artifacts.push(plannerResult.artifact)
                    const newPlan = parsePlannerOutput(plannerResult)
                    if (newPlan?.type === "decomposition") {
                        const newSubtasks =
                            this.filterDuplicateSetupSubtask(newPlan)
                        const newParallel =
                            newPlan.parallel &&
                            !this.haveOverlappingFileScopes(newSubtasks)
                        const newTotal =
                            (newPlan.setupTask ? 1 : 0) + newSubtasks.length
                        if (newParallel) {
                            const newIds = newSubtasks.map(() => randomUUID())
                            newSubtasks.forEach((subtask, i) => {
                                this.eventBus.emit({
                                    type: "subtask:start",
                                    taskId,
                                    subtaskId: newIds[i],
                                    description: subtask.description,
                                    index: i + (newPlan.setupTask ? 1 : 0),
                                    total: newTotal,
                                })
                            })
                            subtaskResults = await Promise.all(
                                newSubtasks.map((subtask, i) =>
                                    this.runTask({
                                        description: subtask.description,
                                        depth: depth + 1,
                                        fileScope: subtask.fileScope,
                                        skipAnalysis: subtask.skipAnalysis,
                                        parentContext: `Subtask of: ${originalDescription}`,
                                        subtaskId: newIds[i],
                                    })
                                )
                            )
                            newIds.forEach((subtaskId, i) => {
                                this.eventBus.emit({
                                    type: "subtask:complete",
                                    subtaskId,
                                    status: subtaskResults[i].status,
                                })
                            })
                        } else {
                            subtaskResults = []
                            for (let i = 0; i < newSubtasks.length; i++) {
                                const subtask = newSubtasks[i]
                                const subtaskId = randomUUID()
                                this.eventBus.emit({
                                    type: "subtask:start",
                                    taskId,
                                    subtaskId,
                                    description: subtask.description,
                                    index: i + (newPlan.setupTask ? 1 : 0),
                                    total: newTotal,
                                })
                                const result = await this.runTask({
                                    description: subtask.description,
                                    depth: depth + 1,
                                    fileScope: subtask.fileScope,
                                    skipAnalysis: subtask.skipAnalysis,
                                    parentContext: `Subtask of: ${originalDescription}`,
                                    subtaskId,
                                })
                                this.eventBus.emit({
                                    type: "subtask:complete",
                                    subtaskId,
                                    status: result.status,
                                })
                                subtaskResults.push(result)
                                if (result.status === "failed") break
                            }
                        }
                        for (const sr of subtaskResults) {
                            artifacts.push(...sr.artifacts)
                        }
                        const anyNewFailed = subtaskResults.some(
                            (r) => r.status === "failed"
                        )
                        if (anyNewFailed) {
                            return {
                                status: "failed",
                                artifacts,
                                agentResults: this.allAgentResults,
                            }
                        }
                        subtaskSummaries = buildSubtaskSummaries(subtaskResults)
                        coordinatorContext =
                            buildCoordinatorContext(subtaskSummaries)
                        coordinatorResult = await this.runAgent(
                            "coordinator",
                            coordinatorContext,
                            undefined,
                            undefined,
                            depth
                        )
                        artifacts.push(coordinatorResult.artifact)
                        lastReviewNotes =
                            (coordinatorResult.artifact.metadata
                                ?.review_notes as string) ?? ""
                        if (coordinatorResult.status === "completed") {
                            return {
                                status: "completed",
                                artifacts,
                                agentResults: this.allAgentResults,
                            }
                        }
                    }
                }
            }

            if (coordinatorResult.status === "completed") {
                return {
                    status: "completed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            if (
                depth === 0 &&
                (coordinatorResult.status === "needs_review" ||
                    coordinatorResult.status === "failed")
            ) {
                const oracleAction = await this.runOracle(
                    originalDescription,
                    plan,
                    subtaskResults,
                    coordinatorResult,
                    lastReviewNotes
                )
                if (
                    oracleAction?.action === "nudge_root_steward" &&
                    oracleAction.nudgeMessage
                ) {
                    const withNudge = await this.runStewardAndParse(
                        originalDescription,
                        plan,
                        subtaskResults,
                        coordinatorResult,
                        lastReviewNotes,
                        0,
                        oracleAction.nudgeMessage
                    )
                    if (withNudge?.action === "retry_merge") {
                        const ctx = buildCoordinatorContext(
                            subtaskSummaries,
                            lastReviewNotes
                        )
                        coordinatorResult = await this.runAgent(
                            "coordinator",
                            ctx,
                            undefined,
                            undefined,
                            depth
                        )
                        artifacts.push(coordinatorResult.artifact)
                        if (coordinatorResult.status === "completed") {
                            return {
                                status: "completed",
                                artifacts,
                                agentResults: this.allAgentResults,
                            }
                        }
                    }
                } else if (oracleAction?.action === "retry_once") {
                    const ctx = buildCoordinatorContext(
                        subtaskSummaries,
                        lastReviewNotes
                    )
                    coordinatorResult = await this.runAgent(
                        "coordinator",
                        ctx,
                        undefined,
                        undefined,
                        depth
                    )
                    artifacts.push(coordinatorResult.artifact)
                    if (coordinatorResult.status === "completed") {
                        return {
                            status: "completed",
                            artifacts,
                            agentResults: this.allAgentResults,
                        }
                    }
                }
            }

            return {
                status:
                    coordinatorResult.status === "needs_review"
                        ? "needs_review"
                        : "failed",
                artifacts,
                agentResults: this.allAgentResults,
            }
        } finally {
            this.compositeOversightContext = null
        }
    }

    private async runStewardAndParse(
        originalDescription: string,
        _plan: Extract<PlannerOutput, { type: "decomposition" }>,
        subtaskResults: WorkflowResult[],
        coordinatorResult: AgentResult,
        reviewNotes: string,
        depth: number,
        oracleNudge?: string
    ): Promise<StewardAction | null> {
        const summaries = subtaskResults
            .map((r, i) => {
                const last = r.artifacts[r.artifacts.length - 1]
                return `Subtask ${i + 1}: ${last?.content?.slice(0, 150) ?? ""}`
            })
            .join("\n")
        const baseContext = [
            `Original task for this level: ${originalDescription}`,
            `\nSubtasks (${subtaskResults.length}):`,
            summaries,
            `\nMerge/QA result: ${coordinatorResult.status}. Summary: ${coordinatorResult.artifact.content?.slice(0, 300) ?? ""}`,
            `\nReview notes: ${reviewNotes}`,
            "\nDecide the next action and call complete_task with content = JSON: { action, ... }.",
        ].join("\n")
        const context = oracleNudge
            ? `The Oracle says: ${oracleNudge}\n\n${baseContext}`
            : baseContext
        const stewardResult = await this.runAgent(
            "steward",
            context.trim(),
            undefined,
            undefined,
            depth
        )
        const content = stewardResult.artifact.content ?? ""
        const parsed = parseStewardOutput(content)
        if (parsed) return parsed
        return { action: "escalate" }
    }

    private async runOracle(
        originalDescription: string,
        _plan: Extract<PlannerOutput, { type: "decomposition" }>,
        subtaskResults: WorkflowResult[],
        coordinatorResult: AgentResult,
        reviewNotes: string
    ): Promise<OracleAction | null> {
        const summaries = subtaskResults
            .map((r, i) => {
                const last = r.artifacts[r.artifacts.length - 1]
                return `Child ${i + 1}: ${last?.content?.slice(0, 80) ?? "done"}`
            })
            .join("; ")
        const snapshot = [
            `Root task: ${originalDescription}`,
            `Root steward situation: Merge/QA ${coordinatorResult.status}.`,
            `Review notes: ${reviewNotes.slice(0, 500)}`,
            `Direct children (${subtaskResults.length}): ${summaries}`,
            "The root steward is stuck. What do you do? Respond with JSON only.",
        ].join("\n")
        this.eventBus.emit({
            type: "oracle:invoked",
            snapshotSummary: snapshot.slice(0, 200),
        })
        const oracleResult = await this.runAgent(
            "oracle",
            snapshot,
            undefined,
            undefined,
            0
        )
        const content = oracleResult.artifact.content ?? ""
        const parsed = parseOracleOutput(content)
        if (parsed) {
            this.eventBus.emit({
                type: "oracle:decision",
                action: parsed.action,
            })
        }
        return parsed
    }

    private async maybeOversightCheckIn(executorDepth?: number): Promise<void> {
        if (!this.oversightTracker) return
        const signals = this.oversightTracker.getSignals()
        const lastOutcome = this.oversightTracker.getLastNudgeOutcome()
        if (Object.keys(signals).length === 0 && !lastOutcome) return

        const ctx = this.compositeOversightContext
        if (ctx) {
            const probability =
                Object.keys(signals).length > 0
                    ? 1
                    : (this.config.oversightProbability ?? 0.25)
            if (Math.random() >= probability) return
            const maxPer = this.config.maxOversightPerComposite ?? 2
            if (this.oversightCycleCount >= maxPer) return
            const nextDesc =
                ctx.subtaskDescriptions[ctx.currentSubtaskIndex] ??
                "next subtask"
            const parts = [
                `Oversight check-in for composite at depth ${ctx.depth}.`,
                `Original: ${ctx.originalDescription}`,
                `About to run subtask ${ctx.currentSubtaskIndex + 1}/${ctx.subtaskDescriptions.length}: ${nextDesc}`,
            ]
            if (Object.keys(signals).length > 0) {
                parts.push(`Signals: ${JSON.stringify(signals)}`)
            }
            if (lastOutcome) {
                parts.push(
                    `Last nudge outcome: "${lastOutcome.nudge.slice(0, 80)}..." → ${lastOutcome.outcome}`
                )
            }
            parts.push(
                'Optionally provide a short nudge for the next step. Respond with JSON only: { "nudge": "..." } or {}.'
            )
            const oversightContext = parts.join("\n")
            const stewardResult = await this.runAgent(
                "steward",
                oversightContext,
                undefined,
                undefined,
                ctx.depth
            )
            const content = stewardResult.artifact.content ?? ""
            let nudge: string | null = null
            try {
                const parsed = JSON.parse(content) as { nudge?: string }
                if (typeof parsed.nudge === "string" && parsed.nudge.trim()) {
                    nudge = parsed.nudge.trim()
                }
            } catch {
                // ignore parse errors
            }
            this.pendingOversightNudge = nudge
            this.oversightCycleCount += 1
            this.eventBus.emit({
                type: "oversight:check_in",
                depth: ctx.depth,
                subtaskIndex: ctx.currentSubtaskIndex,
                hasNudge: !!nudge,
            })
            return
        }

        const depth = executorDepth ?? 0
        const parts = [
            "Oversight check-in for current task. The Dreamer (executor) is about to retry.",
            `Signals from last run: ${JSON.stringify(signals)}`,
            'Provide a short nudge to get the Dreamer back on task. Respond with JSON only: { "nudge": "..." } or {}.',
        ]
        const oversightContext = parts.join("\n")
        const stewardResult = await this.runAgent(
            "steward",
            oversightContext,
            undefined,
            undefined,
            depth
        )
        const content = stewardResult.artifact.content ?? ""
        let nudge: string | null = null
        try {
            const parsed = JSON.parse(content) as { nudge?: string }
            if (typeof parsed.nudge === "string" && parsed.nudge.trim()) {
                nudge = parsed.nudge.trim()
            }
        } catch {
            // ignore parse errors
        }
        this.pendingOversightNudge = nudge
        this.eventBus.emit({
            type: "oversight:check_in",
            depth,
            subtaskIndex: undefined,
            hasNudge: !!nudge,
        })
    }

    private async runExecuteReviewCycle(
        specContext: string,
        originalDescription: string,
        fileScope: string[] | undefined,
        depth: number,
        options?: {
            executorMaxTurns?: number
            executorContextPrefix?: string
            reviewerMaxTurns?: number
            reviewerModel?: string
            subtaskId?: string
        }
    ): Promise<WorkflowResult> {
        const artifacts: Artifact[] = []
        const baseExecutorContext =
            (options?.executorContextPrefix ?? "") + specContext
        let executorContext = baseExecutorContext

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (this.abortSignal?.aborted) {
                return {
                    status: "failed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            const executorResult = await this.runAgent(
                "executor",
                executorContext,
                undefined,
                fileScope,
                depth,
                {
                    maxTurns: options?.executorMaxTurns,
                    subtaskIdForEmit: options?.subtaskId,
                }
            )
            artifacts.push(executorResult.artifact)

            if (executorResult.status === "failed") {
                return {
                    status: "failed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            const handoff =
                (executorResult.artifact.metadata?.handoff_notes as string) ??
                ""
            const reviewContext = [
                `Original task: ${originalDescription}`,
                `\nSpec/Context:\n${specContext}`,
                `\nExecutor summary: ${executorResult.artifact.content.slice(0, 500)}`,
                handoff ? `\nExecutor notes: ${handoff}` : "",
            ]
                .filter(Boolean)
                .join("\n")

            const effectiveReviewerModel =
                options?.reviewerModel ??
                this.config.reviewerModel ??
                (this.config.economyMode ? "gpt-4o-mini" : undefined)
            const reviewerResult = await this.runAgent(
                "reviewer",
                reviewContext,
                undefined,
                fileScope,
                depth,
                {
                    maxTurns: options?.reviewerMaxTurns,
                    model: effectiveReviewerModel,
                    subtaskIdForEmit: options?.subtaskId,
                }
            )
            artifacts.push(reviewerResult.artifact)

            if (reviewerResult.status === "completed") {
                return {
                    status: "completed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            const reviewNotes =
                (reviewerResult.artifact.metadata?.review_notes as string) ?? ""
            if (attempt < this.maxRetries) {
                log.workflow(
                    "The mirror reflects — revision needed (attempt %d/%d)",
                    attempt + 1,
                    this.maxRetries
                )
                const stepId = `executor-retry-${attempt + 1}`
                this.eventBus.emit({
                    type: "step:retry",
                    stepId,
                    attempt: attempt + 1,
                    maxRetries: this.maxRetries,
                    reason: reviewNotes.slice(0, 100) || "Review failed",
                })

                await this.maybeOversightCheckIn(depth)
                const revisionParts = [
                    specContext,
                    `\n\n--- REVISION REQUIRED ---`,
                    `The Mirror (reviewer) found issues with your previous implementation:`,
                    reviewNotes,
                    `\nFix ONLY the issues described above. Do not change anything else.`,
                ]
                if (this.pendingOversightNudge) {
                    revisionParts.push(
                        `\n\n${formatStewardVoice(this.pendingOversightNudge)}`
                    )
                    this.pendingOversightNudge = null
                }
                executorContext = revisionParts.join("\n")
            }
        }

        return {
            status: "failed",
            artifacts,
            agentResults: this.allAgentResults,
        }
    }

    private async runAgent(
        role: AgentRole,
        userMessage: string,
        parentContext: string | undefined,
        fileScope: string[] | undefined,
        _depth: number,
        agentOptions?: {
            maxTurns?: number
            model?: string
            subtaskIdForEmit?: string | null
        }
    ): Promise<AgentResult> {
        this.taskCounter++
        const stepId = `${role}-${this.taskCounter}`
        const effectiveSubtaskId =
            agentOptions?.subtaskIdForEmit !== undefined
                ? agentOptions.subtaskIdForEmit
                : this.currentSubtaskId

        const startTime = Date.now()
        let modelConfig = getDefaultModel(
            role,
            this.config.defaultProvider,
            this.config.defaultModel
        )
        if (agentOptions?.model) {
            modelConfig = { ...modelConfig, model: agentOptions.model }
        }
        let provider = this.providers[modelConfig.provider]

        if (!provider) {
            const fallbackEntry = Object.entries(this.providers)[0]
            if (fallbackEntry) {
                const [fallbackProviderName, fallbackProvider] = fallbackEntry
                provider = fallbackProvider
                const fallbackModel =
                    fallbackProviderName === "openai"
                        ? "gpt-4o"
                        : "claude-sonnet-4-20250514"
                modelConfig = {
                    ...modelConfig,
                    provider: fallbackProviderName as "openai" | "anthropic",
                    model: fallbackModel,
                }
                log.workflow(
                    "Provider %s unavailable for %s, falling back to %s/%s",
                    modelConfig.provider,
                    role,
                    fallbackProviderName,
                    fallbackModel
                )
            }
        }

        this.eventBus.emit({
            type: "step:start",
            stepId,
            role,
            taskId: this.rootTaskId ?? stepId,
            model: modelConfig.model,
            provider: modelConfig.provider,
            ...(effectiveSubtaskId && { subtaskId: effectiveSubtaskId }),
        })

        if (!provider) {
            const failResult: AgentResult = {
                agentId: "none",
                role,
                status: "failed",
                artifact: {
                    type: "analysis",
                    content: `No LLM provider available for ${modelConfig.provider}`,
                    createdAt: new Date().toISOString(),
                },
                tokenUsage: {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                },
                conversationLog: [],
            }
            this.eventBus.emit({
                type: "step:complete",
                stepId,
                role,
                status: "failed",
                duration: Date.now() - startTime,
                tokenUsage: failResult.tokenUsage,
                taskId: this.rootTaskId ?? stepId,
                model: modelConfig.model,
                provider: modelConfig.provider,
                ...(effectiveSubtaskId && { subtaskId: effectiveSubtaskId }),
            })
            return failResult
        }

        const tools = this.getTools(role, {
            useCli: this.config.useCli ?? true,
        })

        const toolContext: ToolContext = {
            taskId: this.rootTaskId ?? stepId,
            agentId: "",
            workingDirectory: this.config.workingDirectory,
            fileScope,
            abortSignal: this.abortSignal,
        }

        const runtime = new AgentRuntime({
            config: {
                role,
                systemPrompt: getSystemPrompt(role),
                tools,
                model: modelConfig,
                maxTurns: agentOptions?.maxTurns ?? getDefaultMaxTurns(role),
                maxContextTurns: this.config.maxContextTurns,
            },
            provider,
            eventBus: this.eventBus,
            toolContext,
            abortSignal: this.abortSignal,
            stepId,
            initialContext: parentContext
                ? `${parentContext}\n\n${userMessage}`
                : userMessage,
        })

        const result = await runtime.run()
        this.allAgentResults.push(result)

        this.eventBus.emit({
            type: "step:complete",
            stepId,
            role,
            status: result.status,
            duration: Date.now() - startTime,
            tokenUsage: result.tokenUsage,
            taskId: this.rootTaskId ?? stepId,
            model: modelConfig.model,
            provider: modelConfig.provider,
            ...(effectiveSubtaskId && { subtaskId: effectiveSubtaskId }),
        })

        return result
    }
}
