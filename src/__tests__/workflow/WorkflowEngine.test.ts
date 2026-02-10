import { describe, expect, it, vi } from "vitest"

import { EventBus } from "../../events/EventBus.js"
import type { TaskBotEvent } from "../../events/types.js"
import type { LLMProvider, ToolDefinition } from "../../types.js"
import { WorkflowEngine } from "../../workflow/WorkflowEngine.js"

function createFailingProvider(): LLMProvider {
    return {
        chat: vi.fn().mockRejectedValue(new Error("mock provider failure")),
    }
}

describe("WorkflowEngine", () => {
    it("emits workflow:start and workflow:complete with the same taskId passed to run()", async (): Promise<void> => {
        const eventBus = new EventBus()
        const workflowStarts: Extract<
            TaskBotEvent,
            { type: "workflow:start" }
        >[] = []
        const workflowCompletes: Extract<
            TaskBotEvent,
            { type: "workflow:complete" }
        >[] = []
        eventBus.on((event: TaskBotEvent): void => {
            if (event.type === "workflow:start") workflowStarts.push(event)
            if (event.type === "workflow:complete")
                workflowCompletes.push(event)
        })

        const engine = new WorkflowEngine({
            providers: { openai: createFailingProvider() },
            getToolsForRole: (): ToolDefinition[] => [],
            eventBus,
            config: {
                workingDirectory: "/tmp",
                defaultProvider: "openai",
                defaultModel: "gpt-4o",
            },
        })

        const taskId = "test-task-id-123"
        const result = await engine.run("do something", taskId)

        expect(workflowStarts).toHaveLength(1)
        expect(workflowStarts[0].taskId).toBe(taskId)
        expect(workflowCompletes).toHaveLength(1)
        expect(workflowCompletes[0].taskId).toBe(taskId)
        expect(workflowCompletes[0].status).toBe("failed")
        expect(result.status).toBe("failed")
    })
})
