import type {
    AgentResultStatus,
    AgentRole,
    CostBreakdown,
    TaskStatus,
    TokenUsage,
    WorkflowStatus,
} from "../types.js"

export type TaskBotEvent =
    | {
          type: "workflow:start"
          workflowName: string
          taskId: string
          taskDescription: string
      }
    | {
          type: "workflow:complete"
          taskId: string
          status: WorkflowStatus
          duration: number
      }
    | {
          type: "step:start"
          stepId: string
          role: AgentRole
          taskId: string
          model: string
          provider: string
          subtaskId?: string
      }
    | {
          type: "step:complete"
          stepId: string
          role: AgentRole
          status: AgentResultStatus
          duration: number
          tokenUsage: TokenUsage
          taskId: string
          model: string
          provider: string
      }
    | {
          type: "step:retry"
          stepId: string
          attempt: number
          maxRetries: number
          reason: string
      }
    | {
          type: "agent:spawn"
          agentId: string
          role: AgentRole
          parentAgentId?: string
          stepId?: string
          taskDescription: string
      }
    | {
          type: "agent:turn"
          agentId: string
          turnNumber: number
          maxTurns: number
      }
    | {
          type: "agent:tool_call"
          agentId: string
          toolName: string
          toolArgs?: Record<string, unknown>
      }
    | {
          type: "agent:content"
          agentId: string
          content: string
      }
    | {
          type: "agent:tool_result"
          agentId: string
          toolName: string
          isError: boolean
          duration: number
      }
    | {
          type: "agent:complete"
          agentId: string
          status: AgentResultStatus
          summary: string
      }
    | {
          type: "task:status_change"
          taskId: string
          from: TaskStatus
          to: TaskStatus
      }
    | {
          type: "task:subtask_created"
          parentId: string
          childId: string
          description: string
      }
    | {
          type: "subtask:start"
          taskId: string
          subtaskId: string
          description: string
          index: number
          total: number
      }
    | {
          type: "subtask:complete"
          subtaskId: string
          status: WorkflowStatus
      }
    | {
          type: "token:update"
          agentId: string
          usage: TokenUsage
          cumulativeUsage: TokenUsage
      }
    | {
          type: "cost:update"
          totalCost: CostBreakdown
          byRole: Record<
              string,
              {
                  cost: CostBreakdown
                  tokenUsage: TokenUsage
                  agentCount: number
              }
          >
          byModel: Record<
              string,
              { cost: CostBreakdown; tokenUsage: TokenUsage }
          >
      }
    | {
          type: "composite_cycle:start"
          cycle: number
          maxCycles: number
      }
    | {
          type: "oracle:invoked"
          snapshotSummary: string
      }
    | {
          type: "oracle:decision"
          action: string
      }
    | {
          type: "oversight:check_in"
          depth: number
          subtaskIndex?: number
          hasNudge: boolean
      }
