export type AgentRole =
    | "analyzer"
    | "planner"
    | "executor"
    | "reviewer"
    | "coordinator"
    | "steward"
    | "oracle"

export type LLMProviderType = "openai" | "anthropic"

export type TaskStatus =
    | "pending"
    | "in_progress"
    | "blocked"
    | "review"
    | "completed"
    | "failed"

/** Complexity score in [0, 1]: 0 = trivial, 1 = very complex. */
export type TaskComplexity = number

export type ArtifactType =
    | "analysis"
    | "spec"
    | "decomposition"
    | "code_changes"
    | "review"
    | "coordination"
    | "management"
    | "oracle"

export type WorkflowStatus =
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "paused"
    | "needs_review"

export type AgentResultStatus = "completed" | "failed" | "needs_review"

export type StopReason = "end_turn" | "tool_use" | "max_tokens"

export interface ModelConfig {
    provider: LLMProviderType
    model: string
    temperature?: number
    maxTokens?: number
}

export interface TokenUsage {
    promptTokens: number
    completionTokens: number
    totalTokens: number
}

export interface LLMMessage {
    role: "system" | "user" | "assistant" | "tool"
    content: string
    toolCalls?: LLMToolCall[]
    toolCallId?: string
}

export interface LLMToolCall {
    id: string
    name: string
    arguments: Record<string, unknown>
}

export interface LLMResponse {
    content: string | null
    toolCalls: LLMToolCall[]
    usage: TokenUsage
    stopReason: StopReason
}

export interface JSONSchemaProperty {
    type: "string" | "number" | "boolean" | "array" | "object"
    description?: string
    items?: JSONSchemaProperty
    properties?: Record<string, JSONSchemaProperty>
    required?: string[]
    enum?: string[]
}

export interface ToolParameterSchema {
    type: "object"
    properties: Record<string, JSONSchemaProperty>
    required?: string[]
}

export interface ToolDefinition {
    name: string
    description: string
    parameters: ToolParameterSchema
    execute: (
        args: Record<string, unknown>,
        context: ToolContext
    ) => Promise<ToolExecutionResult>
}

export interface ToolContext {
    taskId: string
    agentId: string
    workingDirectory: string
    fileScope?: string[]
    abortSignal?: AbortSignal
}

export interface ToolExecutionResult {
    content: string
    isError: boolean
}

export interface AgentConfig {
    role: AgentRole
    systemPrompt: string
    tools: ToolDefinition[]
    model: ModelConfig
    maxTurns: number
    maxContextTurns?: number
}

export interface AgentResult {
    agentId: string
    role: AgentRole
    status: AgentResultStatus
    artifact: Artifact
    tokenUsage: TokenUsage
    conversationLog: LLMMessage[]
}

export interface Artifact {
    type: ArtifactType
    content: string
    metadata?: Record<string, unknown>
    createdAt: string
}

export interface SubtaskDef {
    description: string
    fileScope: string[]
    skipAnalysis: boolean
}

export type PlannerOutput =
    | {
          type: "spec"
          spec: string
          acceptanceCriteria: string[]
          expectedFiles: string[]
          fileScope: string[]
      }
    | {
          type: "decomposition"
          subtasks: SubtaskDef[]
          parallel: boolean
          setupTask?: SubtaskDef
          compositeAcceptanceCriteria?: string[]
      }

export interface AnalyzerOutput {
    complexity: TaskComplexity
    summary: string
    affectedFiles: string[]
    recommendedApproach: string
}

export interface TaskData {
    id: string
    parentId?: string
    description: string
    status: TaskStatus
    complexity?: TaskComplexity
    assignedRole?: AgentRole
    artifacts: Artifact[]
    subtaskIds: string[]
    workflowId?: string
    createdAt: string
    updatedAt: string
}

export interface WorkflowState {
    id: string
    taskId: string
    status: WorkflowStatus
    depth: number
    stepResults: Record<string, SerializedAgentResult>
    retryCount: Record<string, number>
    artifacts: Artifact[]
    startedAt: string
    updatedAt: string
    completedAt?: string
}

export interface SerializedAgentResult {
    agentId: string
    role: AgentRole
    status: AgentResultStatus
    artifact: Artifact
    tokenUsage: TokenUsage
}

export type RendererType = "terminal" | "log" | "none"

export type StewardActionType =
    | "retry_merge"
    | "retry_children"
    | "add_fix_task"
    | "re_decompose"
    | "escalate"

export interface StewardAction {
    action: StewardActionType
    taskIndices?: number[]
    retryFocus?: string
    fixDescription?: string
}

export type OracleActionType =
    | "nudge_root_steward"
    | "retry_once"
    | "escalate_to_user"

export interface OracleAction {
    action: OracleActionType
    nudgeMessage?: string
    retryFocus?: string
}

export interface BabylonConfig {
    openaiApiKey?: string
    anthropicApiKey?: string
    workingDirectory: string
    persistencePath?: string
    defaultProvider?: LLMProviderType
    defaultModel?: string
    renderer?: RendererType
    maxDepth?: number
    maxRetries?: number
    budgetDollars?: number
    useCli?: boolean
    simplePathMaxTurns?: number
    verbose?: boolean
    runLogPath?: string
    maxCompositeCycles?: number
    oversightProbability?: number
    maxOversightPerComposite?: number
    oversightThresholds?: {
        repeatedToolCount?: number
        longStepSeconds?: number
    }
    reviewerModel?: string
    economyMode?: boolean
    complexityDirectThreshold?: number
    maxContextTurns?: number
    providers?: Record<string, LLMProvider>
}

export interface CostBreakdown {
    inputCost: number
    outputCost: number
    totalCost: number
}

export interface AgentCostEntry {
    agentId: string
    role: AgentRole
    model: string
    tokenUsage: TokenUsage
    cost: CostBreakdown
    turns: number
    stepId?: string
}

export interface WorkflowCostSummary {
    totalCost: CostBreakdown
    totalTokens: TokenUsage
    byAgent: AgentCostEntry[]
    byRole: Record<
        string,
        { cost: CostBreakdown; tokenUsage: TokenUsage; agentCount: number }
    >
    byModel: Record<string, { cost: CostBreakdown; tokenUsage: TokenUsage }>
}

export interface RunResult {
    taskId: string
    status: TaskStatus
    artifacts: Artifact[]
    tokenUsage: TokenUsage
    costSummary: WorkflowCostSummary
    duration: number
}

export interface LLMProvider {
    chat(
        messages: LLMMessage[],
        tools: ToolDefinition[],
        model: ModelConfig
    ): Promise<LLMResponse>
}
