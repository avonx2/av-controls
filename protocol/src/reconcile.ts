import * as Base from './controls/base'

// Controls are identified across the controller, timeline and persistence by a
// leaf path: the chain of control ids from the root, joined with '/'. When an
// artwork's control tree changes (a control is renamed, moved or removed) saved
// states bind to paths that no longer exist. These helpers diff the paths of a
// loaded file against the current spec so a user can match orphaned saved data
// onto the current controls and translate (migrate) the file.

export const PATH_SEPARATOR = '/'

export type LeafPath = string

export interface SpecLeaf {
  path: LeafPath
  type: string
}

export interface FileLeaf {
  path: LeafPath
  /** Control type, when it can be derived from the file. Often unknown for serialized states. */
  type?: string
}

export interface ReconcileDiff {
  /** Paths present in both spec and file (applied as-is). */
  matched: LeafPath[]
  /** LEFT column: current controls with no matching saved data. */
  onlyInSpec: SpecLeaf[]
  /** RIGHT column: saved data with no matching current control (orphans). */
  onlyInFile: FileLeaf[]
}

/** Maps an orphaned file path onto a current spec path. */
export type MatchMap = Record<LeafPath, LeafPath>

// A container sender/state is detected structurally so this stays agnostic of
// the concrete Group/Tabs/Modal classes.
type SenderNode = { senders?: Record<string, SenderNode>; spec?: { type?: string } }
type StateNode = { states?: Record<string, StateNode> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Walk a live sender tree (e.g. the controller's rootSender) to the leaf
 * controls, mirroring the path convention used by Persistence.walkReceivers:
 * the root container itself is not emitted and child paths start at [id].
 */
export function walkSenderLeaves(root: Base.Sender): SpecLeaf[] {
  const leaves: SpecLeaf[] = []
  const walk = (node: SenderNode, path: string[]) => {
    if (node.senders && isRecord(node.senders)) {
      for (const id in node.senders) {
        walk(node.senders[id]!, [...path, id])
      }
      return
    }
    leaves.push({ path: path.join(PATH_SEPARATOR), type: node.spec?.type ?? '' })
  }
  walk(root as unknown as SenderNode, [])
  return leaves
}

/**
 * Walk a serialized control-state tree (a parsed export, i.e. plain JSON shaped
 * like Group.State { states: { id: childState } }) to its leaf paths.
 */
export function walkStateLeaves(root: Base.State): FileLeaf[] {
  const leaves: FileLeaf[] = []
  const walk = (node: StateNode, path: string[]) => {
    if (node && node.states && isRecord(node.states)) {
      for (const id in node.states) {
        walk(node.states[id]!, [...path, id])
      }
      return
    }
    leaves.push({ path: path.join(PATH_SEPARATOR) })
  }
  walk(root as unknown as StateNode, [])
  return leaves
}

export function diffPaths(spec: SpecLeaf[], file: FileLeaf[]): ReconcileDiff {
  const specByPath = new Map(spec.map(leaf => [leaf.path, leaf]))
  const filePaths = new Set(file.map(leaf => leaf.path))

  const matched: LeafPath[] = []
  const onlyInFile: FileLeaf[] = []
  for (const leaf of file) {
    if (specByPath.has(leaf.path)) {
      matched.push(leaf.path)
    } else {
      onlyInFile.push(leaf)
    }
  }
  const onlyInSpec = spec.filter(leaf => !filePaths.has(leaf.path))

  return { matched, onlyInSpec, onlyInFile }
}

function leafName(path: LeafPath): string {
  const segments = path.split(PATH_SEPARATOR)
  return segments[segments.length - 1] ?? ''
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Propose a match for each orphan by leaf-name similarity, preferring an equal
 * control type when the orphan's type is known. Only one spec target is used
 * per orphan, and a given spec target is suggested at most once. Returns a map
 * of fileOrphanPath -> specPath; orphans with no good candidate are omitted.
 */
export function suggestMatches(diff: ReconcileDiff): MatchMap {
  const map: MatchMap = {}
  const usedSpecPaths = new Set<LeafPath>()

  for (const orphan of diff.onlyInFile) {
    const orphanName = normalize(leafName(orphan.path))
    let best: { path: LeafPath; score: number } | null = null

    for (const candidate of diff.onlyInSpec) {
      if (usedSpecPaths.has(candidate.path)) continue
      if (orphan.type && candidate.type && orphan.type !== candidate.type) continue

      const candidateName = normalize(leafName(candidate.path))
      let score = 0
      if (candidateName === orphanName) {
        score = 3
      } else if (candidateName.includes(orphanName) || orphanName.includes(candidateName)) {
        score = 2
      } else {
        continue
      }
      if (orphan.type && candidate.type && orphan.type === candidate.type) {
        score += 1
      }
      if (!best || score > best.score) {
        best = { path: candidate.path, score }
      }
    }

    if (best) {
      map[orphan.path] = best.path
      usedSpecPaths.add(best.path)
    }
  }

  return map
}

function splitPath(path: LeafPath): string[] {
  return path.split(PATH_SEPARATOR)
}

function getStateAtPath(root: StateNode, segments: string[]): StateNode | undefined {
  let node: StateNode | undefined = root
  for (const segment of segments) {
    if (!node || !node.states) return undefined
    node = node.states[segment]
  }
  return node
}

function deleteStateAtPath(root: StateNode, segments: string[]): void {
  if (segments.length === 0) return
  const parentSegments = segments.slice(0, -1)
  const leaf = segments[segments.length - 1]!
  const parent = getStateAtPath(root, parentSegments)
  if (parent && parent.states) {
    delete parent.states[leaf]
  }
}

function setStateAtPath(root: StateNode, segments: string[], value: StateNode): boolean {
  if (segments.length === 0) return false
  const parentSegments = segments.slice(0, -1)
  const leaf = segments[segments.length - 1]!
  const parent = getStateAtPath(root, parentSegments)
  // Only place onto an existing parent container (the target control must exist
  // in the current spec for the migration to be meaningful).
  if (!parent || !parent.states) return false
  parent.states[leaf] = value
  return true
}

/**
 * Translate a serialized control-state tree by moving each mapped orphan leaf
 * (fileOrphanPath) onto its matched current control (specPath). Orphans without
 * a mapping are dropped. Pure: operates on a deep clone of `root`.
 */
export function remapControlState<T extends Base.State>(root: T, map: MatchMap): T {
  const clone = JSON.parse(JSON.stringify(root)) as StateNode

  // Collect moves first so deletions don't disturb lookups mid-iteration.
  const moves: Array<{ from: string[]; to: string[]; value: StateNode }> = []
  for (const fromPath in map) {
    const toPath = map[fromPath]!
    const value = getStateAtPath(clone, splitPath(fromPath))
    if (value !== undefined) {
      moves.push({ from: splitPath(fromPath), to: splitPath(toPath), value })
    }
  }

  for (const move of moves) {
    deleteStateAtPath(clone, move.from)
  }
  for (const move of moves) {
    setStateAtPath(clone, move.to, move.value)
  }

  return clone as unknown as T
}
