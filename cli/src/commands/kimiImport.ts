import chalk from 'chalk'
import { MAX_KIMI_SESSION_IMPORTS } from '@hapi/protocol/apiTypes'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { ApiClient } from '@/api/api'
import {
    getKimiCodeHome,
    listKimiSessions,
    readKimiImportSession,
    type KimiSessionSummary
} from '@/modules/common/kimiSessions'
import type { CommandDefinition } from './types'

export type ParsedKimiImportArgs = {
    help: boolean
    all: boolean
    includeArchived: boolean
    cwd?: string
    limit?: number
    selectors: string[]
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi kimi-import')} - Import Kimi Code desktop history into HAPI

${chalk.bold('Usage:')}
  hapi kimi-import                      List importable Kimi Code sessions
  hapi kimi-import <index|session-id>   Import one session (repeatable)
  hapi kimi-import --all                Import every session with messages

${chalk.bold('Options:')}
  --all                Import all sessions (batched)
  --cwd <dir>          Only sessions whose workspace is <dir>
  --archived           Include archived sessions
  --limit <n>          Consider at most n sessions (default: all found)
  -h, --help           Show this help

${chalk.bold('How it works:')}
  Reads kimi-code's own session store (${getKimiCodeHome()}/sessions), maps the
  consolidated turns from each session's agents/main/wire.jsonl onto HAPI's
  message shape, and posts them to this hub. Imported sessions keep their
  original timestamps and appear in the web/phone session list, so they can be
  read there without resuming the agent.

${chalk.bold('Environment:')}
  KIMI_CODE_HOME       kimi-code data root (default ~/.kimi-code, legacy ~/.kimi)
`)
}

function normalizePath(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function formatTimestamp(value: number): string {
    const date = new Date(value)
    const pad = (part: number) => String(part).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function parseKimiImportArgs(argv: string[]): ParsedKimiImportArgs {
    const parsed: ParsedKimiImportArgs = {
        help: false,
        all: false,
        includeArchived: false,
        selectors: []
    }
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!
        if (arg === '-h' || arg === '--help') {
            parsed.help = true
            continue
        }
        if (arg === '--all') {
            parsed.all = true
            continue
        }
        if (arg === '--archived') {
            parsed.includeArchived = true
            continue
        }
        if (arg === '--cwd' || arg === '--limit') {
            const value = argv[index + 1]
            if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
            index += 1
            if (arg === '--cwd') parsed.cwd = value
            if (arg === '--limit') parsed.limit = Number(value)
            continue
        }
        if (arg.startsWith('--cwd=')) { parsed.cwd = arg.slice('--cwd='.length); continue }
        if (arg.startsWith('--limit=')) { parsed.limit = Number(arg.slice('--limit='.length)); continue }
        if (arg.startsWith('-')) throw new Error(`unexpected flag: ${arg}`)
        parsed.selectors.push(arg)
    }
    if (parsed.all && parsed.selectors.length > 0) {
        throw new Error('--all cannot be combined with explicit session ids')
    }
    if (parsed.limit !== undefined && (!Number.isInteger(parsed.limit) || parsed.limit < 1)) {
        throw new Error('--limit must be a positive integer')
    }
    return parsed
}

function printSessions(sessions: KimiSessionSummary[]): void {
    console.log(chalk.bold(`Kimi Code sessions in ${getKimiCodeHome()}`))
    sessions.forEach((session, index) => {
        const archived = session.archived ? chalk.dim(' [archived]') : ''
        const cwd = session.cwd ? chalk.dim(` ${session.cwd}`) : ''
        const title = session.title || chalk.dim('(no title)')
        console.log(`  ${String(index + 1).padStart(3)}. ${formatTimestamp(session.updatedAt)}  ${title}${archived}${cwd}`)
        console.log(`       ${chalk.dim(session.id)}`)
    })
    console.log('')
    console.log(`Import one with ${chalk.cyan('hapi kimi-import <index>')}, or everything with ${chalk.cyan('hapi kimi-import --all')}.`)
}

function resolveSelectors(selectors: string[], sessions: KimiSessionSummary[]): KimiSessionSummary[] {
    const selected: KimiSessionSummary[] = []
    const seen = new Set<string>()
    for (const raw of selectors) {
        let match: KimiSessionSummary | undefined
        const index = Number(raw)
        if (Number.isInteger(index) && String(index) === raw && index >= 1 && index <= sessions.length) {
            match = sessions[index - 1]
        } else {
            match = sessions.find((session) => session.id === raw)
            if (!match) {
                const prefixed = sessions.filter((session) => session.id.startsWith(raw))
                if (prefixed.length === 1) match = prefixed[0]
                else if (prefixed.length > 1) throw new Error(`session id prefix "${raw}" is ambiguous`)
            }
        }
        if (!match) throw new Error(`no Kimi Code session matches "${raw}"`)
        if (seen.has(match.id)) continue
        seen.add(match.id)
        selected.push(match)
    }
    return selected
}

export async function runKimiImport(argv: string[]): Promise<void> {
    const parsed = parseKimiImportArgs(argv)
    if (parsed.help) {
        showHelp()
        return
    }

    await initializeToken()
    await maybeAutoStartServer()
    const { machineId } = await authAndSetupMachineIfNeeded()
    const api = await ApiClient.create()

    const cwd = parsed.cwd ? parsed.cwd : undefined
    let sessions = await listKimiSessions({
        cwd,
        includeArchived: parsed.includeArchived,
        limit: parsed.limit
    })
    if (cwd) {
        // listKimiSessions already filtered; this keeps the reporting honest when
        // the caller passed a path with a different drive-letter casing.
        const wanted = normalizePath(cwd)
        sessions = sessions.filter((session) => session.cwd && normalizePath(session.cwd) === wanted)
    }

    if (!parsed.all && parsed.selectors.length === 0) {
        if (sessions.length === 0) {
            console.log('No importable Kimi Code sessions found.')
            return
        }
        printSessions(sessions)
        return
    }

    const selected = parsed.all ? sessions : resolveSelectors(parsed.selectors, sessions)
    if (selected.length === 0) {
        console.log('No sessions selected.')
        return
    }

    console.log(chalk.bold(`Importing ${selected.length} session(s) into HAPI (machine ${machineId})`))
    let failures = 0
    let imported = 0
    let appended = 0

    for (let offset = 0; offset < selected.length; offset += MAX_KIMI_SESSION_IMPORTS) {
        const batch = selected.slice(offset, offset + MAX_KIMI_SESSION_IMPORTS)
        for (const summary of batch) {
            const label = summary.title || summary.id.slice(0, 8)
            try {
                const transcript = await readKimiImportSession(summary)
                if (transcript.messages.length === 0) {
                    failures += 1
                    console.log(`  ${chalk.yellow('–')} ${label}: no importable messages`)
                    continue
                }
                const response = await api.importKimiSessions({ machineId, sessions: [transcript] })
                const result = response.results[0]
                if (!result || result.error) {
                    failures += 1
                    console.log(`  ${chalk.red('✗')} ${label}: ${result?.error?.message ?? 'import failed'}`)
                    continue
                }
                imported += 1
                appended += result.appended ?? 0
                const action = result.action === 'unchanged'
                    ? 'already up to date'
                    : `+${result.appended ?? 0} messages`
                console.log(`  ${chalk.green('✓')} ${label} → ${result.hapiSessionId} (${action})`)
            } catch (error) {
                failures += 1
                const message = error instanceof Error ? error.message : String(error)
                console.log(`  ${chalk.red('✗')} ${label}: ${message}`)
            }
        }
    }

    console.log('')
    console.log(`Imported ${imported} session(s), ${appended} message(s) appended; ${failures} skipped.`)
    console.log('Open the HAPI web app or phone app and refresh the session list.')
    if (failures > 0 && imported === 0) {
        process.exitCode = 1
    }
}

export const kimiImportCommand: CommandDefinition = {
    name: 'kimi-import',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await runKimiImport(commandArgs)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}
