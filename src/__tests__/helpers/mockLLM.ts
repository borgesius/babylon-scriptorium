import { vi } from "vitest"

import type { LLMProvider, LLMResponse } from "../../types.js"

export function createMockProvider(responses: LLMResponse[]): LLMProvider {
    let callIndex = 0
    return {
        chat: vi.fn((): Promise<LLMResponse> => {
            const response = responses[callIndex]
            if (!response) {
                return Promise.reject(
                    new Error(`No mock response for call index ${callIndex}`)
                )
            }
            callIndex++
            return Promise.resolve(response)
        }),
    }
}

export function mockCompleteTaskResponse(
    status: string,
    summary: string,
    content: string
): LLMResponse {
    return {
        content: null,
        toolCalls: [
            {
                id: "tc-1",
                name: "complete_task",
                arguments: { status, summary, content },
            },
        ],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        stopReason: "tool_use",
    }
}

export interface MockAnalyzerContent {
    complexity: number
    summary: string
    affectedFiles?: string[]
    recommendedApproach?: string
}

export function mockAnalyzerResponse(
    content: MockAnalyzerContent
): LLMResponse {
    const json = JSON.stringify({
        complexity: content.complexity,
        summary: content.summary,
        affectedFiles: content.affectedFiles ?? [],
        recommendedApproach: content.recommendedApproach ?? "",
    })
    return mockCompleteTaskResponse("completed", content.summary, json)
}
