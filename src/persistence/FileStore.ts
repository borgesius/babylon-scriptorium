import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { log } from "../core/Logger.js"

export class FileStore {
    private readonly basePath: string

    constructor(basePath: string) {
        this.basePath = basePath
    }

    public async write(key: string, data: unknown): Promise<void> {
        const filePath = this.keyToPath(key)
        const tempPath = `${filePath}.tmp.${Date.now()}`
        const content = JSON.stringify(data, null, 2)

        await mkdir(dirname(filePath), { recursive: true })

        try {
            await writeFile(tempPath, content, "utf-8")
            await rename(tempPath, filePath)
        } catch (error) {
            log.persistence(
                "Failed to write %s: %s",
                key,
                error instanceof Error ? error.message : String(error)
            )
            throw error
        }
    }

    public async read<T>(key: string): Promise<T | null> {
        const filePath = this.keyToPath(key)
        try {
            const content = await readFile(filePath, "utf-8")
            return JSON.parse(content) as T
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return null
            }
            log.persistence(
                "Failed to read %s: %s",
                key,
                error instanceof Error ? error.message : String(error)
            )
            throw error
        }
    }

    public async exists(key: string): Promise<boolean> {
        try {
            await readFile(this.keyToPath(key))
            return true
        } catch {
            return false
        }
    }

    private keyToPath(key: string): string {
        return join(this.basePath, `${key}.json`)
    }
}
