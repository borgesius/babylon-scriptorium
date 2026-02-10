import { describe, expect, it } from "vitest"

import { AgentRuntime } from "../agents/AgentRuntime.js"
import { EventBus } from "../events/EventBus.js"
import type { LLMResponse, ModelConfig, ToolDefinition } from "../types.js"
import {
    createMockProvider,
    mockCompleteTaskResponse,
} from "./helpers/mockLLM.js"

function makeCompleteTaskTool(): ToolDefinition {
    return {
        name: "complete_task",
        description: "Complete the task",
        parameters: {
            type: "object",
            properties: {
                status: { type: "string" },
                summary: { type: "string" },
                content: { type: "string" },
            },
            required: ["status", "summary", "content"],
        },
        execute: (args) =>
            Promise.resolve({
                content: JSON.stringify(args),
                isError: false,
            }),
    }
}

describe("AgentRuntime", () => {
    it("should complete a simple task in one turn", async () => {
        const provider = createMockProvider([
            mockCompleteTaskResponse("completed", "done", "the result"),
        ])

        const runtime = new AgentRuntime({
            config: {
                role: "analyzer",
                systemPrompt: "You are an analyzer.",
                tools: [makeCompleteTaskTool()],
                model: {
                    provider: "anthropic",
                    model: "test-model",
                } as ModelConfig,
                maxTurns: 5,
            },
            provider,
            eventBus: new EventBus(),
            toolContext: {
                taskId: "test-task",
                agentId: "test-agent",
                workingDirectory: "/tmp",
            },
            initialContext: "Analyze this task",
        })

        const result = await runtime.run()
        expect(result.status).toBe("completed")
        expect(result.role).toBe("analyzer")
        expect(result.tokenUsage.totalTokens).toBe(150)
    })

    it("should handle multiple turns before completion", async () => {
        const provider = createMockProvider([
            {
                content: "Let me think about this...",
                toolCalls: [],
                usage: {
                    promptTokens: 50,
                    completionTokens: 20,
                    totalTokens: 70,
                },
                stopReason: "end_turn",
            },
            mockCompleteTaskResponse("completed", "analyzed", "the analysis"),
        ])

        const runtime = new AgentRuntime({
            config: {
                role: "analyzer",
                systemPrompt: "You are an analyzer.",
                tools: [makeCompleteTaskTool()],
                model: {
                    provider: "anthropic",
                    model: "test-model",
                } as ModelConfig,
                maxTurns: 5,
            },
            provider,
            eventBus: new EventBus(),
            toolContext: {
                taskId: "test-task",
                agentId: "test-agent",
                workingDirectory: "/tmp",
            },
            initialContext: "Analyze this task",
        })

        const result = await runtime.run()
        expect(result.status).toBe("completed")
        expect(result.tokenUsage.totalTokens).toBe(220)
    })

    it("should return needs_review when max turns exceeded", async () => {
        const thinkResponse: LLMResponse = {
            content: "Still thinking...",
            toolCalls: [],
            usage: {
                promptTokens: 50,
                completionTokens: 20,
                totalTokens: 70,
            },
            stopReason: "end_turn",
        }

        const provider = createMockProvider([
            thinkResponse,
            thinkResponse,
            thinkResponse,
        ])

        const runtime = new AgentRuntime({
            config: {
                role: "analyzer",
                systemPrompt: "You are an analyzer.",
                tools: [makeCompleteTaskTool()],
                model: {
                    provider: "anthropic",
                    model: "test-model",
                } as ModelConfig,
                maxTurns: 3,
            },
            provider,
            eventBus: new EventBus(),
            toolContext: {
                taskId: "test-task",
                agentId: "test-agent",
                workingDirectory: "/tmp",
            },
            initialContext: "Analyze this task",
        })

        const result = await runtime.run()
        expect(result.status).toBe("needs_review")
    })

    it("should detect stuck loops", async () => {
        const sameToolCall: LLMResponse = {
            content: null,
            toolCalls: [
                {
                    id: "tc-1",
                    name: "read_file",
                    arguments: { path: "src/index.ts" },
                },
            ],
            usage: {
                promptTokens: 50,
                completionTokens: 20,
                totalTokens: 70,
            },
            stopReason: "tool_use",
        }

        const readFileTool: ToolDefinition = {
            name: "read_file",
            description: "Read a file",
            parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            },
            execute: () =>
                Promise.resolve({
                    content: "file contents",
                    isError: false,
                }),
        }

        const provider = createMockProvider([
            sameToolCall,
            sameToolCall,
            sameToolCall,
        ])

        const runtime = new AgentRuntime({
            config: {
                role: "analyzer",
                systemPrompt: "You are an analyzer.",
                tools: [readFileTool, makeCompleteTaskTool()],
                model: {
                    provider: "anthropic",
                    model: "test-model",
                } as ModelConfig,
                maxTurns: 10,
            },
            provider,
            eventBus: new EventBus(),
            toolContext: {
                taskId: "test-task",
                agentId: "test-agent",
                workingDirectory: "/tmp",
            },
            initialContext: "Analyze this task",
        })

        const result = await runtime.run()
        expect(result.status).toBe("needs_review")
    })

    it("should emit events during execution", async () => {
        const eventBus = new EventBus()
        const events: string[] = []
        eventBus.on((event) => events.push(event.type))

        const provider = createMockProvider([
            mockCompleteTaskResponse("completed", "done", "result"),
        ])

        const runtime = new AgentRuntime({
            config: {
                role: "analyzer",
                systemPrompt: "You are an analyzer.",
                tools: [makeCompleteTaskTool()],
                model: {
                    provider: "anthropic",
                    model: "test-model",
                } as ModelConfig,
                maxTurns: 5,
            },
            provider,
            eventBus,
            toolContext: {
                taskId: "test-task",
                agentId: "test-agent",
                workingDirectory: "/tmp",
            },
            initialContext: "Analyze this task",
        })

        await runtime.run()
        expect(events).toContain("agent:spawn")
        expect(events).toContain("agent:turn")
        expect(events).toContain("agent:tool_call")
        expect(events).toContain("agent:tool_result")
        expect(events).toContain("agent:complete")
        expect(events).toContain("token:update")
    })

    it("should respect abort signal", async () => {
        const controller = new AbortController()
        controller.abort()

        const provider = createMockProvider([])

        const runtime = new AgentRuntime({
            config: {
                role: "analyzer",
                systemPrompt: "You are an analyzer.",
                tools: [makeCompleteTaskTool()],
                model: {
                    provider: "anthropic",
                    model: "test-model",
                } as ModelConfig,
                maxTurns: 5,
            },
            provider,
            eventBus: new EventBus(),
            toolContext: {
                taskId: "test-task",
                agentId: "test-agent",
                workingDirectory: "/tmp",
            },
            abortSignal: controller.signal,
            initialContext: "Analyze this task",
        })

        const result = await runtime.run()
        expect(result.status).toBe("failed")
    })
})
