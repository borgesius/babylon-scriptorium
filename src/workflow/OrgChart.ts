export interface OrgChartNode {
    id: string
    parentId: string | null
    childIds: string[]
    type: "composite" | "leaf"
    description: string
    depth: number
    hasSteward: boolean
}

export class OrgChart {
    private readonly nodes = new Map<string, OrgChartNode>()
    private rootId: string | null = null

    public setRoot(
        taskId: string,
        description: string,
        isComposite: boolean
    ): void {
        this.rootId = taskId
        this.nodes.set(taskId, {
            id: taskId,
            parentId: null,
            childIds: [],
            type: isComposite ? "composite" : "leaf",
            description,
            depth: 0,
            hasSteward: isComposite,
        })
    }

    public addChild(
        childId: string,
        parentId: string,
        description: string,
        depth: number,
        isComposite: boolean
    ): void {
        const node: OrgChartNode = {
            id: childId,
            parentId,
            childIds: [],
            type: isComposite ? "composite" : "leaf",
            description,
            depth,
            hasSteward: isComposite,
        }
        this.nodes.set(childId, node)
        const parent = this.nodes.get(parentId)
        if (parent) {
            parent.childIds.push(childId)
        }
    }

    public getNode(id: string): OrgChartNode | undefined {
        return this.nodes.get(id)
    }

    public getRootId(): string | null {
        return this.rootId
    }

    public getSnapshot(): Map<string, OrgChartNode> {
        return new Map(this.nodes)
    }
}
