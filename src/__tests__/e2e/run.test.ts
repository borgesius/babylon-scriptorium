import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { BabylonScriptorium } from "../../index.js"
import {
    createMockProvider,
    mockAnalyzerResponse,
    mockCompleteTaskResponse,
} from "../helpers/mockLLM.js"

describe("e2e run (LLMs mocked)", () => {
    let tempDir: string

    beforeAll(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "babylon-e2e-"))
    })

    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true })
    })

    it("completes full workflow with analyzer → executor → reviewer (direct path)", async () => {
        const analyzerResponse = mockAnalyzerResponse({
            complexity: 0.2,
            summary: "Small task",
            affectedFiles: [],
            recommendedApproach: "Direct implementation",
        })
        const executorResponse = mockCompleteTaskResponse(
            "completed",
            "Implemented",
            "Done"
        )
        const reviewerResponse = mockCompleteTaskResponse(
            "completed",
            "Approved",
            "Looks good"
        )

        const mockProvider = createMockProvider([
            analyzerResponse,
            executorResponse,
            reviewerResponse,
        ])

        const config = {
            workingDirectory: tempDir,
            persistencePath: join(tempDir, ".babylon"),
            defaultProvider: "anthropic" as const,
            defaultModel: "claude-sonnet-4-20250514",
            renderer: "none" as const,
            maxDepth: 2,
            useCli: false,
            providers: {
                anthropic: mockProvider,
                openai: mockProvider,
            },
        }

        const scriptorium = new BabylonScriptorium(config)
        const result = await scriptorium.run("Add a comment to the README")

        expect(result.status).toBe("completed")
        expect(result.taskId).toBeDefined()
        expect(result.artifacts.length).toBeGreaterThanOrEqual(1)
        expect(result.tokenUsage.totalTokens).toBeGreaterThan(0)
    })
})
