import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { TaskManager } from "../orchestrator/TaskManager.js"
import { FileStore } from "../persistence/FileStore.js"

describe("TaskManager", () => {
    let manager: TaskManager
    let tempDir: string

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "babylon-tm-test-"))
        const store = new FileStore(tempDir)
        manager = new TaskManager(store)
    })

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true })
    })

    it("should create a task with default values", async () => {
        const task = await manager.create("implement feature X")
        expect(task.id).toBeDefined()
        expect(task.description).toBe("implement feature X")
        expect(task.status).toBe("pending")
        expect(task.artifacts).toEqual([])
        expect(task.subtaskIds).toEqual([])
    })

    it("should create a task with parentId", async () => {
        const parent = await manager.create("parent task")
        const child = await manager.create("child task", parent.id)
        expect(child.parentId).toBe(parent.id)
    })

    it("should get a task by id", async () => {
        const task = await manager.create("test task")
        const found = manager.get(task.id)
        expect(found).toBeDefined()
        expect(found?.description).toBe("test task")
    })

    it("should return undefined for non-existent task", () => {
        const found = manager.get("non-existent-id")
        expect(found).toBeUndefined()
    })

    it("should update task status", async () => {
        const task = await manager.create("test task")
        const updated = await manager.updateStatus(task.id, "in_progress")
        expect(updated?.status).toBe("in_progress")
    })

    it("should set complexity", async () => {
        const task = await manager.create("test task")
        await manager.setComplexity(task.id, 0.85)
        const found = manager.get(task.id)
        expect(found?.complexity).toBe(0.85)
    })

    it("should assign role", async () => {
        const task = await manager.create("test task")
        await manager.assignRole(task.id, "executor")
        const found = manager.get(task.id)
        expect(found?.assignedRole).toBe("executor")
    })

    it("should add artifacts", async () => {
        const task = await manager.create("test task")
        await manager.addArtifact(task.id, {
            type: "analysis",
            content: "the analysis",
            createdAt: new Date().toISOString(),
        })
        const found = manager.get(task.id)
        expect(found?.artifacts).toHaveLength(1)
        expect(found?.artifacts[0].content).toBe("the analysis")
    })

    it("should add subtasks", async () => {
        const parent = await manager.create("parent")
        const child = await manager.create("child", parent.id)
        await manager.addSubtask(parent.id, child.id)
        const found = manager.get(parent.id)
        expect(found?.subtaskIds).toContain(child.id)
    })
})
