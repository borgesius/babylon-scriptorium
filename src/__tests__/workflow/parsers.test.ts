import { describe, expect, it } from "vitest"

import type { AgentResult } from "../../types.js"
import {
    parseAnalyzerOutput,
    parseOracleOutput,
    parsePlannerOutput,
    parseStewardOutput,
} from "../../workflow/parsers.js"

function artifact(content: string, type = "analysis"): AgentResult["artifact"] {
    return {
        type: type as "analysis",
        content,
        createdAt: new Date().toISOString(),
    }
}

function agentResult(content: string): AgentResult {
    return {
        agentId: "test",
        role: "analyzer",
        status: "completed",
        artifact: artifact(content),
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        conversationLog: [],
    }
}

describe("parseAnalyzerOutput", () => {
    it("parses valid JSON with numeric complexity", () => {
        const result = agentResult(
            JSON.stringify({
                complexity: 0.45,
                summary: "Summary",
                affectedFiles: ["a.ts", "b.ts"],
                recommendedApproach: "Do X then Y",
            })
        )
        const out = parseAnalyzerOutput(result)
        expect(out.complexity).toBe(0.45)
        expect(out.summary).toBe("Summary")
        expect(out.affectedFiles).toEqual(["a.ts", "b.ts"])
        expect(out.recommendedApproach).toBe("Do X then Y")
    })

    it("maps simple/medium/complex strings to numeric complexity", () => {
        expect(
            parseAnalyzerOutput(
                agentResult(JSON.stringify({ complexity: "simple" }))
            ).complexity
        ).toBe(0.25)
        expect(
            parseAnalyzerOutput(
                agentResult(JSON.stringify({ complexity: "medium" }))
            ).complexity
        ).toBe(0.5)
        expect(
            parseAnalyzerOutput(
                agentResult(JSON.stringify({ complexity: "complex" }))
            ).complexity
        ).toBe(0.85)
    })

    it("returns default complexity and content slice on invalid JSON", () => {
        const result = agentResult("not json at all")
        const out = parseAnalyzerOutput(result)
        expect(out.complexity).toBe(0.5)
        expect(out.summary).toBe("not json at all".slice(0, 500))
        expect(out.affectedFiles).toEqual([])
        expect(out.recommendedApproach).toBe("")
    })

    it("uses content as summary when summary missing", () => {
        const result = agentResult(
            JSON.stringify({ complexity: 0.3, affectedFiles: [] })
        )
        const out = parseAnalyzerOutput(result)
        expect(out.summary).toBe(result.artifact.content)
    })
})

describe("parsePlannerOutput", () => {
    it("returns spec type when valid spec JSON", () => {
        const spec = {
            type: "spec",
            spec: "Implement foo",
            acceptanceCriteria: ["AC1", "AC2"],
            expectedFiles: ["src/foo.ts"],
            fileScope: ["src/"],
        }
        const result = agentResult(JSON.stringify(spec))
        const out = parsePlannerOutput(result)
        expect(out.type).toBe("spec")
        if (out.type === "spec") {
            expect(out.spec).toBe("Implement foo")
            expect(out.acceptanceCriteria).toEqual(["AC1", "AC2"])
            expect(out.expectedFiles).toEqual(["src/foo.ts"])
            expect(out.fileScope).toEqual(["src/"])
        }
    })

    it("returns decomposition type when valid decomposition JSON", () => {
        const decomp = {
            type: "decomposition",
            subtasks: [
                {
                    description: "Subtask 1",
                    fileScope: ["src/a"],
                    skipAnalysis: true,
                },
            ],
            parallel: false,
        }
        const result = agentResult(JSON.stringify(decomp))
        const out = parsePlannerOutput(result)
        expect(out.type).toBe("decomposition")
        if (out.type === "decomposition") {
            expect(out.subtasks).toHaveLength(1)
            expect(out.subtasks[0].description).toBe("Subtask 1")
            expect(out.parallel).toBe(false)
        }
    })

    it("returns fallback spec when JSON invalid or wrong type", () => {
        const result = agentResult("not json")
        const out = parsePlannerOutput(result)
        expect(out.type).toBe("spec")
        if (out.type === "spec") {
            expect(out.spec).toBe("not json")
            expect(out.acceptanceCriteria).toEqual([])
            expect(out.expectedFiles).toEqual([])
            expect(out.fileScope).toEqual([])
        }
    })
})

describe("parseStewardOutput", () => {
    it("parses retry_merge action", () => {
        const out = parseStewardOutput(
            JSON.stringify({ action: "retry_merge" })
        )
        expect(out).toEqual({ action: "retry_merge" })
    })

    it("parses retry_children with taskIndices and retryFocus", () => {
        const out = parseStewardOutput(
            JSON.stringify({
                action: "retry_children",
                taskIndices: [0, 2],
                retryFocus: "Fix the tests",
            })
        )
        expect(out).toEqual({
            action: "retry_children",
            taskIndices: [0, 2],
            retryFocus: "Fix the tests",
        })
    })

    it("parses add_fix_task with fixDescription", () => {
        const out = parseStewardOutput(
            JSON.stringify({
                action: "add_fix_task",
                fixDescription: "Add missing type",
            })
        )
        expect(out).toEqual({
            action: "add_fix_task",
            fixDescription: "Add missing type",
        })
    })

    it("strips markdown code fence around JSON", () => {
        const out = parseStewardOutput(
            "```json\n" + JSON.stringify({ action: "escalate" }) + "\n```"
        )
        expect(out).toEqual({ action: "escalate" })
    })

    it("returns null for invalid action", () => {
        expect(
            parseStewardOutput(JSON.stringify({ action: "invalid" }))
        ).toBeNull()
    })

    it("returns null for invalid JSON", () => {
        expect(parseStewardOutput("not json")).toBeNull()
    })
})

describe("parseOracleOutput", () => {
    it("parses nudge_root_steward with nudgeMessage", () => {
        const out = parseOracleOutput(
            JSON.stringify({
                action: "nudge_root_steward",
                nudgeMessage: "Focus on tests",
            })
        )
        expect(out).toEqual({
            action: "nudge_root_steward",
            nudgeMessage: "Focus on tests",
        })
    })

    it("parses retry_once", () => {
        const out = parseOracleOutput(JSON.stringify({ action: "retry_once" }))
        expect(out).toEqual({ action: "retry_once" })
    })

    it("parses escalate_to_user", () => {
        const out = parseOracleOutput(
            JSON.stringify({ action: "escalate_to_user" })
        )
        expect(out).toEqual({ action: "escalate_to_user" })
    })

    it("strips markdown code fence around JSON", () => {
        const out = parseOracleOutput(
            "```\n" + JSON.stringify({ action: "retry_once" }) + "\n```"
        )
        expect(out).toEqual({ action: "retry_once" })
    })

    it("returns null for invalid action", () => {
        expect(
            parseOracleOutput(JSON.stringify({ action: "nudge" }))
        ).toBeNull()
    })

    it("returns null for invalid JSON", () => {
        expect(parseOracleOutput("not json")).toBeNull()
    })
})
