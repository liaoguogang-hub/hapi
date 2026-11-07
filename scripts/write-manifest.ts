/**
 * Write a manifest for a built release: what was produced, from which
 * commit, and what each artefact's checksum is.
 *
 * A local build is not reproducible by `git checkout` alone — the working
 * copy had to be re-materialised because the dependency store could not be
 * reinstalled on this machine. The manifest records exactly what was built
 * so a later build can be compared against it.
 *
 * Usage: bun scripts/write-manifest.ts --dist <dir> [--version <v>] [--repo <dir>]
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

function parseArgs(argv: string[]): { dist: string; version: string; repo: string } {
    const options = { dist: 'dist', version: '', repo: '.' }
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--dist') options.dist = argv[index + 1]!
        if (argv[index] === '--version') options.version = argv[index + 1]!
        if (argv[index] === '--repo') options.repo = argv[index + 1]!
    }
    return options
}

function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Every file under a directory, relative to it, sorted. */
function walk(dir: string, base = dir): string[] {
    if (!existsSync(dir)) return []
    const found: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) found.push(...walk(path, base))
        else found.push(relative(base, path).split('\\').join('/'))
    }
    return found.sort()
}

/**
 * Read a git value.
 *
 * `execFileSync` is used rather than a shell so the repository path is not
 * re-parsed by the shell, and so a non-zero exit is an empty string rather
 * than a thrown error.
 */
function git(args: string[], repo: string): string {
    try {
        return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
        return ''
    }
}

function main(): void {
    const options = parseArgs(process.argv.slice(2))
    const distDir = resolve(options.dist)
    const repoDir = resolve(options.repo)

    const version = options.version
        || JSON.parse(readFileSync(join(repoDir, 'cli', 'package.json'), 'utf8')).version

    const files = walk(distDir)
    const artefacts = files
        .filter((file) => !file.endsWith('manifest.json'))
        .map((file) => ({
            path: file,
            bytes: statSync(join(distDir, file)).size,
            sha256: sha256(join(distDir, file))
        }))

    const manifest = {
        name: 'hapi-kestrel-local',
        version,
        builtAt: new Date().toISOString(),
        source: {
            repository: git(['config', '--get', 'remote.fork.url'], repoDir),
            branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir),
            commit: git(['rev-parse', 'HEAD'], repoDir),
            upstreamCommit: git(['rev-parse', 'upstream-base'], repoDir),
            dirty: git(['status', '--porcelain'], repoDir) !== ''
        },
        toolchain: {
            bun: process.versions.bun ?? 'unknown',
            node: process.versions.node
        },
        artefacts
    }

    const target = join(distDir, 'manifest.json')
    writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    console.log(`[manifest] ${target}`)
    console.log(`[manifest] version=${version} commit=${manifest.source.commit} artefacts=${artefacts.length}`)
}

main()
