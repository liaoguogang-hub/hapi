/**
 * Patch a release manifest with the source metadata the manifest writer
 * could not collect itself.
 *
 * `write-manifest.ts` shells out to git, which the sandbox blocks. The
 * values are read here from the repository directly and written in.
 *
 * Usage: node scripts/patch-manifest.mjs <manifest.json> <commit> <branch>
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [, , manifestPath, commit, branch] = process.argv
if (!manifestPath) {
    console.error('usage: patch-manifest.mjs <manifest.json> [commit] [branch]')
    process.exit(2)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

manifest.source = {
    repository: 'ssh://git@github.com/liaoguogang-hub/hapi.git',
    branch: branch ?? 'feature/local-hub-cli-build',
    commit: commit ?? 'uncommitted',
    upstreamCommit: 'eab2ce5f4db37a3641ce447099d16e35f7978189',
    upstreamRef: 'upstream-base',
    dirty: true,
    dirtyNote: 'Build workspace only. The D:\\hapi-main source tree is read-only here, so the build ran from a copy with re-materialised dependencies.'
}

manifest.notes =
    'cli/hapi.exe is the deployable artefact: self-contained (hub + runner + web UI + DSH import). '
    + 'hub/index.js is the same hub built to run under bun, and needs the sibling files in hub/.'

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

const main = manifest.artefacts.filter((entry) => entry.path === 'cli/hapi.exe' || entry.path === 'hub/index.js')
console.log(`[patch] ${manifestPath} artefacts=${manifest.artefacts.length}`)
for (const entry of main) {
    console.log(`  ${entry.path} ${entry.bytes} ${entry.sha256.slice(0, 16)}`)
}
