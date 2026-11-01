import type {
  CodeDependencyGraph,
  CodeDependencyGraphEdge,
  CodeDependencyGraphNode,
  CodeSourceIdentity,
} from './types.js'

export interface DependencyGraphWalkOptions {
  identity: CodeSourceIdentity
  seeds: string[]
  maxDepth: number
  maxNodes: number
  maxEdges: number
  readEdges(frontier: string[], limit: number, signal: AbortSignal): Promise<Array<{ from: string; to: string }>>
  excluded(path: string): boolean
  signal: AbortSignal
}

/** Deterministic bounded BFS over already-resolved source import edges. */
export async function walkDependencyGraph(options: DependencyGraphWalkOptions): Promise<CodeDependencyGraph> {
  const { identity, maxDepth, maxNodes, maxEdges, signal } = options
  const seeds = [...new Set(options.seeds)].sort()
  const nodes: CodeDependencyGraphNode[] = seeds.map((path) => ({
    path, depth: 0, seed: path, parent: null, relation: 'seed',
  }))
  const visited = new Map(nodes.map((node) => [node.path, node]))
  const edges: CodeDependencyGraphEdge[] = []
  const edgeKeys = new Set<string>()
  let frontier = [...seeds]
  let nodeLimited = false
  let edgeLimited = false

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    signal.throwIfAborted()
    // Keep per-level reads bounded independently of how many duplicate edges
    // from earlier frontiers are encountered.
    const candidates = await options.readEdges(frontier, maxEdges + 1, signal)
    const next: string[] = []
    for (const candidate of candidates) {
      signal.throwIfAborted()
      const key = `${candidate.from}\0${candidate.to}`
      const knownEdge = edgeKeys.has(key)
      const fromInFrontier = frontier.includes(candidate.from)
      const direction = fromInFrontier ? 'imports' : 'importedBy'
      const neighbor = fromInFrontier ? candidate.to : candidate.from
      const parent = fromInFrontier ? candidate.from : candidate.to
      if (options.excluded(candidate.from) || options.excluded(candidate.to)) continue
      const parentNode = visited.get(parent)
      if (!parentNode) continue
      const existingNode = visited.get(neighbor)
      if (!existingNode && visited.size >= maxNodes) {
        nodeLimited = true
        continue
      }
      if (!knownEdge && edges.length >= maxEdges) {
        edgeLimited = true
        continue
      }
      if (!knownEdge) {
        edgeKeys.add(key)
        edges.push({ from: candidate.from, to: candidate.to, direction })
      }
      if (!existingNode) {
        const node: CodeDependencyGraphNode = {
          path: neighbor,
          depth,
          seed: parentNode.seed,
          parent,
          relation: direction,
        }
        visited.set(neighbor, node)
        nodes.push(node)
        next.push(neighbor)
      }
    }
    frontier = [...new Set(next)].sort()
  }
  const reachedDepth = nodes.reduce((max, node) => Math.max(max, node.depth), 0)
  return {
    identity: structuredClone(identity),
    seeds,
    nodes,
    edges,
    requestedDepth: maxDepth,
    reachedDepth,
    // Reaching the configured boundary says only that traversal stopped there.
    limits: { depth: reachedDepth >= maxDepth, nodes: nodeLimited, edges: edgeLimited },
  }
}
