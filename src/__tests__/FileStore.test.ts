import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { FileStore } from "../persistence/FileStore.js"

describe("FileStore", () => {
    let store: FileStore
    let tempDir: string

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "babylon-test-"))
        store = new FileStore(tempDir)
    })

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true })
    })

    it("should write and read data", async () => {
        const data = { name: "test", value: 42 }
        await store.write("test-key", data)
        const result = await store.read<typeof data>("test-key")
        expect(result).toEqual(data)
    })

    it("should return null for non-existent keys", async () => {
        const result = await store.read("does-not-exist")
        expect(result).toBeNull()
    })

    it("should check existence correctly", async () => {
        expect(await store.exists("missing")).toBe(false)
        await store.write("present", { ok: true })
        expect(await store.exists("present")).toBe(true)
    })

    it("should handle nested keys", async () => {
        const data = { nested: true }
        await store.write("tasks/abc-123", data)
        const result = await store.read<typeof data>("tasks/abc-123")
        expect(result).toEqual(data)
    })

    it("should overwrite existing data", async () => {
        await store.write("key", { version: 1 })
        await store.write("key", { version: 2 })
        const result = await store.read<{ version: number }>("key")
        expect(result?.version).toBe(2)
    })
})
