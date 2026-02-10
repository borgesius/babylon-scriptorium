import { describe, expect, it } from "vitest"

describe("Example test suite", () => {
    it("should pass a basic assertion", () => {
        expect(1 + 1).toBe(2)
    })

    it("should handle string comparisons", () => {
        const greeting = "Hello, World!"
        expect(greeting).toContain("Hello")
    })

    it("should work with arrays", () => {
        const items = [1, 2, 3]
        expect(items).toHaveLength(3)
        expect(items).toContain(2)
    })
})
