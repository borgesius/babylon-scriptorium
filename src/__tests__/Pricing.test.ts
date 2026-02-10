import { describe, expect, it } from "vitest"

import { calculateCost, formatCost, getModelPricing } from "../core/Pricing.js"
import type { TokenUsage } from "../types.js"

describe("Pricing", () => {
    describe("getModelPricing", () => {
        it("should return exact pricing for known models", () => {
            const pricing = getModelPricing("gpt-4o")
            expect(pricing.inputPerMillion).toBe(2.5)
            expect(pricing.outputPerMillion).toBe(10)
        })

        it("should return pricing for Claude Sonnet", () => {
            const pricing = getModelPricing("claude-sonnet-4-20250514")
            expect(pricing.inputPerMillion).toBe(3)
            expect(pricing.outputPerMillion).toBe(15)
        })

        it("should return default pricing for unknown models", () => {
            const pricing = getModelPricing("unknown-model-xyz")
            expect(pricing.inputPerMillion).toBe(3)
            expect(pricing.outputPerMillion).toBe(15)
        })
    })

    describe("calculateCost", () => {
        it("should calculate cost correctly for a known model", () => {
            const usage: TokenUsage = {
                promptTokens: 1_000_000,
                completionTokens: 100_000,
                totalTokens: 1_100_000,
            }
            const cost = calculateCost("gpt-4o", usage)
            expect(cost.inputCost).toBe(2.5)
            expect(cost.outputCost).toBe(1)
            expect(cost.totalCost).toBe(3.5)
        })

        it("should handle zero tokens", () => {
            const usage: TokenUsage = {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
            }
            const cost = calculateCost("gpt-4o", usage)
            expect(cost.totalCost).toBe(0)
        })

        it("should calculate fractional costs", () => {
            const usage: TokenUsage = {
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
            }
            const cost = calculateCost("gpt-4o", usage)
            expect(cost.inputCost).toBeCloseTo(0.0025)
            expect(cost.outputCost).toBeCloseTo(0.005)
            expect(cost.totalCost).toBeCloseTo(0.0075)
        })
    })

    describe("formatCost", () => {
        it("should format small costs with 4 decimal places", () => {
            expect(formatCost(0.0025)).toBe("$0.0025")
        })

        it("should format larger costs with 2 decimal places", () => {
            expect(formatCost(1.5)).toBe("$1.50")
        })

        it("should format zero", () => {
            expect(formatCost(0)).toBe("$0.0000")
        })

        it("should format costs at the threshold", () => {
            expect(formatCost(0.01)).toBe("$0.01")
        })
    })
})
