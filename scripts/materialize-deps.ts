/**
 * Materialise bun's isolated dependency store into hoisted `node_modules`
 * trees that contain the full dependency closure.
 *
 * The problem
 * -----------
 * bun's default `linker = "isolated"` layout stores packages under
 * `node_modules/.bun/<name>@<version>/node_modules/<name>` and wires every
 * dependency edge with a symlink. Windows cannot create those symlinks
 * without elevated privileges, so a copied tree silently loses every edge:
 * `zod` resolves but `proper-lockfile` does not, and the type checker
 * reports a wall of "Cannot find module".
 *
 * A hoisted layout needs no symlinks — every package is a real directory at
 * the top level of `node_modules` — but it must contain the *closure*, not
 * only the direct dependencies, because a package's own `require` calls
 * resolve against the hoisted root.
 *
 * How the edges are read
 * ----------------------
 * The store is the authority on which version satisfies which range. Each
 * store package lists its dependencies as sibling symlinks, whose link text
 * names the store directory that holds the dependency's real files:
 *
 *   .bun/vitest@4.0.16+40a0f651ed895612/node_modules/
 *       vitest/            <- the package
 *       chai -> ../../chai@5.3.3/node_modules/chai
 *
 * The link text is read (not the target's contents) so the exact version
 * bun selected is reproduced. Because the link text points back into the
 * store, the closure is followed there and materialised into the
 * workspace.
 *
 * Usage:
 *   bun scripts/materialize-deps.ts --store <dir> [--workspace <dir>]
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

function parseArgs(argv: string[]): { store: string; workspace: string } {
    const options = { store: 'node_modules/.bun', workspace: '.' }
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--store') options.store = argv[index + 1]!
        if (argv[index] === '--workspace') options.workspace = argv[index + 1]!
    }
    return options
}

/**
 * Every store entry for a package name, newest first.
 *
 * The store directory name encodes the version: `<name>@<version>` for a
 * plain package and `<scope>+<name>@<version>` for a scoped one.
 */
function storeCandidates(storeRoot: string, name: string): { version: string; dir: string }[] {
    // The store directory is `<name>@<version>` for a plain package and
    // `<scope>+<name>@<version>` for a scoped one.
    const marker = name.includes('/') ? `${name.replace('/', '+')}@` : `${name}@`
    const candidates: { version: string; dir: string }[] = []
    for (const entry of readdirSync(storeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith(marker)) continue
        const version = entry.name.slice(marker.length)
        const dir = join(storeRoot, entry.name, 'node_modules', ...name.split('/'))
        if (!existsSync(join(dir, 'package.json'))) continue
        candidates.push({ version, dir })
    }
    return candidates.sort((left, right) => compareVersions(right.version, left.version))
}

/** Numeric-aware version comparison; build metadata is ignored. */
function compareVersions(left: string, right: string): number {
    const parse = (value: string): number[] => value
        .split('+')[0]!
        .split('-')[0]!
        .split('.')
        .map((part) => Number.parseInt(part, 10) || 0)
    const a = parse(left)
    const b = parse(right)
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0)
        if (difference !== 0) return difference
    }
    return 0
}

/**
 * The store entry that satisfies a declared range.
 *
 * A caret range (`^4.0.16`) accepts any higher minor/patch of the same
 * major; an exact range accepts only that version. Ranges that cannot be
 * parsed fall back to the newest candidate, which is what bun's own
 * resolver effectively does for a workspace without a lockfile entry.
 */
function pickVersion(candidates: { version: string; dir: string }[], range: string | undefined): string | undefined {
    if (candidates.length === 0) return undefined
    if (!range) return candidates[0]!.dir
    const trimmed = range.trim()
    if (trimmed === '' || trimmed === '*' || trimmed === 'latest') return candidates[0]!.dir
    const caret = trimmed.match(/^\^(\d+)\.(\d+)\.(\d+)/)
    if (caret) {
        const major = Number(caret[1])
        const matching = candidates.find((candidate) => {
            const parts = candidate.version.split('+')[0]!.split('.')
            return Number(parts[0]) === major
        })
        return (matching ?? candidates[0]!).dir
    }
    const exact = trimmed.match(/^(\d+\.\d+\.\d+)/)
    if (exact) {
        const matching = candidates.find((candidate) => candidate.version.startsWith(exact[1]!))
        return (matching ?? candidates[0]!).dir
    }
    return candidates[0]!.dir
}

/**
 * The dependency edges of a store package, as `dependency name -> the store
 * directory that holds it`.
 *
 * In the isolated layout a package's dependencies are the sibling symlinks
 * in its own `node_modules` directory. The link text ends with
 * `<store dir>/node_modules/<package path>`. Scoped dependencies live one
 * level deeper — as a `@scope` directory whose entries are the symlinks —
 * so both shapes are walked.
 */
function readDependencyEdges(packageDir: string): Map<string, string> {
    const edges = new Map<string, string>()
    const container = dirname(packageDir)
    if (!existsSync(container)) return edges

    const record = (name: string, linkPath: string): void => {
        let target: string
        try {
            target = readlinkSync(linkPath)
        } catch {
            return
        }
        const normalized = target.split('\\').join('/')
        const marker = '/node_modules/'
        const at = normalized.lastIndexOf(marker)
        if (at < 0) return
        const tail = normalized.slice(at + marker.length).split('/').filter(Boolean)
        if (tail.length === 0) return
        // The store directory is the segment before `node_modules`.
        const prefix = normalized.slice(0, at)
        edges.set(name, prefix.slice(prefix.lastIndexOf('/') + 1))
    }

    for (const entry of readdirSync(container, { withFileTypes: true })) {
        const entryPath = join(container, entry.name)
        if (entry.isSymbolicLink()) {
            record(entry.name, entryPath)
            continue
        }
        // A scoped package occupies two levels: @scope/name.
        if (!entry.isDirectory() || !entry.name.startsWith('@')) continue
        for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
            if (!scoped.isSymbolicLink()) continue
            record(`${entry.name}/${scoped.name}`, join(entryPath, scoped.name))
        }
    }
    return edges
}

/** The directory in the store that holds a package's real files. */
function storeDirFor(storeRoot: string, storeDirName: string, name: string): string {
    return join(storeRoot, storeDirName, 'node_modules', ...name.split('/'))
}

/**
 * Copy a package and its whole dependency closure into `outRoot`.
 *
 * `source` pins the exact store directory, so the version bun selected is
 * the version that gets copied — no re-resolution that could pick a
 * different one.
 */
function materializeClosure(
    storeRoot: string,
    outRoot: string,
    name: string,
    source: string,
    seen: Set<string>
): number {
    if (seen.has(name)) return 0
    seen.add(name)
    if (!existsSync(join(source, 'package.json'))) return 0

    const target = join(outRoot, ...name.split('/'))
    // A package already present at a different version is replaced: the
    // closure that reaches it here is the authoritative one.
    if (existsSync(join(target, 'package.json'))) {
        const existing = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { version?: string }
        const incoming = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { version?: string }
        if (existing.version === incoming.version) return 0
        rmSync(target, { recursive: true, force: true })
    }
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, dereference: true })

    let count = 1
    for (const [depName, depStoreDir] of readDependencyEdges(source)) {
        const depSource = storeDirFor(storeRoot, depStoreDir, depName)
        if (!existsSync(join(depSource, 'package.json'))) continue
        count += materializeClosure(storeRoot, outRoot, depName, depSource, seen)
    }
    return count
}

/** The packages a workspace declares directly, with their version ranges. */
function declaredDependencies(workspaceDir: string): Map<string, string> {
    const manifest = JSON.parse(readFileSync(join(workspaceDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
    }
    const declared = new Map<string, string>()
    for (const group of [manifest.dependencies, manifest.devDependencies]) {
        for (const [name, range] of Object.entries(group ?? {})) declared.set(name, range)
    }
    return declared
}

function main(): void {
    const options = parseArgs(process.argv.slice(2))
    const storeRoot = resolve(options.store)
    const workspaceRoot = resolve(options.workspace)

    const workspaces = ['cli', 'hub', 'shared', 'web']
        .map((name) => join(workspaceRoot, name))
        .filter((dir) => existsSync(join(dir, 'package.json')))

    for (const workspace of workspaces) {
        const wanted = declaredDependencies(workspace)
        const seen = new Set<string>()
        let copied = 0
        const missing: string[] = []
        for (const [name, range] of wanted) {
            if (name.startsWith('@hapi/')) continue
            const candidates = storeCandidates(storeRoot, name)
            const source = pickVersion(candidates, range)
            if (!source) {
                missing.push(name)
                continue
            }
            copied += materializeClosure(storeRoot, join(workspace, 'node_modules'), name, source, seen)
        }
        console.log(`[deps] ${basename(workspace)}: ${copied} packages` + (missing.length ? `, missing ${missing.join(', ')}` : ''))
    }
}

main()
