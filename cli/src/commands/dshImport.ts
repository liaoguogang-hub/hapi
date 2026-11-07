import chalk from 'chalk'
import { MAX_DSH_SESSION_IMPORTS } from '@hapi/protocol/apiTypes'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { ApiClient } from '@/api/api'
import {
    discoverDshHost,
    listDshSessions,
    readDshImportSessions,
    type DshSessionSummary
} from '@/modules/common/dshSessions'
import type { CommandDefinition } from './types'

export type ParsedDshImportArgs = {
    help: boolean
    all: boolean
    cwd?: string
    url?: string
    cookie?: string
    selectors: string[]
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi dsh-import')} - Import DeepSeek Harness desktop history into HAPI

${chalk.bold('Usage:')}
  hapi dsh-import                      List importable DSH sessions
  hapi dsh-import <index|session-id>   Import one session (repeatable)
  hapi dsh-import --all                Import every non-blank DSH session

${chalk.bold('Options:')}
  --all                Import all sessions (batched)
  --cwd <dir>          Only sessions whose workspace is <dir>
  --url <url>          DSH Host base URL (default: auto-discover a local Host)
  --cookie <cookie>    Host cookie; required when --url points at a tunnel/bridge
  -h, --help           Show this help

${chalk.bold('How it works:')}
  The command asks the running DSH desktop Host for its durable session log
  (session/list -> session/projections -> session/page), maps user/assistant
  messages to HAPI's message shape, and posts them to this hub. Imported
  sessions keep their original timestamps and appear in the web/phone session
  list, so they can be read there without resuming the agent.

${chalk.bold('Environment:')}
  HAPI_DSH_HOST_URL, HAPI_DSH_HOST_COOKIE   Same as --url / --cookie
  DSH_HOME                                  DSH data root (default ~/.dsh)
`)
}

export function parseDshImportArgs(argv: string[]): ParsedDshImportArgs {
    const parsed: ParsedDshImportArgs = { help: false, all: false, selectors: [] }
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
        if (arg === '--cwd' || arg === '--url' || arg === '--cookie') {
            const value = argv[index + 1]
            if (!value || value.startsWith('--')) {
                throw new Error(`${arg} requires a value`)
            }
            index += 1
            if (arg === '--cwd') parsed.cwd = value
            if (arg === '--url') parsed.url = value
            if (arg === '--cookie') parsed.cookie = value
            continue
        }
        if (arg.startsWith('--cwd=')) { parsed.cwd = arg.slice('--cwd='.length); continue }
        if (arg.startsWith('--url=')) { parsed.url = arg.slice('--url='.length); continue }
        if (arg.startsWith('--cookie=')) { parsed.cookie = arg.slice('--cookie='.length); continue }
        if (arg.startsWith('-')) {
            throw new Error(`unexpected flag: ${arg}`)
        }
        parsed.selectors.push(arg)
    }
    if (parsed.all && parsed.selectors.length > 0) {
        throw new Error('--all cannot be combined with explicit session ids')
    }
    return parsed
}

function formatTimestamp(value: number): string {
    const date = new Date(value)
    const pad = (part: number) => String(part).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function normalizePath(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function printSessions(targetUrl: string, sessions: DshSessionSummary[]): void {
    console.log(chalk.bold(`DSH sessions on ${targetUrl}`))
    sessions.forEach((session, index) => {
        const running = session.running ? chalk.yellow(' [running]') : ''
        const cwd = session.cwd ? chalk.dim(` ${session.cwd}`) : ''
        console.log(`  ${String(index + 1).padStart(3)}. ${formatTimestamp(session.updatedAt)}  ${session.title}${running}${cwd}`)
        console.log(`       ${chalk.dim(session.id)}`)
    })
    console.log('')
    console.log(`Import one with ${chalk.cyan('hapi dsh-import <index>')}, or everything with ${chalk.cyan('hapi dsh-import --all')}.`)
}

function resolveSelectors(selectors: string[], sessions: DshSessionSummary[]): DshSessionSummary[] {
    const selected: DshSessionSummary[] = []
    const seen = new Set<string>()
    for (const raw of selectors) {
        let match: DshSessionSummary | undefined
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
        if (!match) throw new Error(`no DSH session matches "${raw}"`)
        if (seen.has(match.id)) continue
        seen.add(match.id)
        selected.push(match)
    }
    return selected
}

export async function runDshImport(argv: string[]): Promise<void> {
    const parsed = parseDshImportArgs(argv)
    if (parsed.help) {
        showHelp()
        return
    }

    await initializeToken()
    await maybeAutoStartServer()
    const { machineId } = await authAndSetupMachineIfNeeded()
    const api = await ApiClient.create()

    const target = await discoverDshHost({ url: parsed.url, cookie: parsed.cookie })
    console.log(chalk.dim(`DSH Host: ${target.baseUrl}`))

    let sessions = await listDshSessions(target)
    if (parsed.cwd) {
        const wanted = normalizePath(parsed.cwd)
        sessions = sessions.filter((session) => session.cwd && normalizePath(session.cwd) === wanted)
    }
    sessions = sessions.filter((session) => !session.blank)

    if (!parsed.all && parsed.selectors.length === 0) {
        if (sessions.length === 0) {
            console.log('No importable DSH sessions found.')
            return
        }
        printSessions(target.baseUrl, sessions)
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

    for (let offset = 0; offset < selected.length; offset += MAX_DSH_SESSION_IMPORTS) {
        const batch = selected.slice(offset, offset + MAX_DSH_SESSION_IMPORTS)
        for (const session of batch) {
            try {
                const [transcript] = await readDshImportSessions(target, [session.id], { summaries: sessions })
                if (!transcript || transcript.messages.length === 0) {
                    failures += 1
                    console.log(`  ${chalk.yellow('–')} ${session.title}: no importable messages`)
                    continue
                }
                const response = await api.importDshSessions({ machineId, sessions: [transcript] })
                const result = response.results[0]
                if (!result || result.error) {
                    failures += 1
                    console.log(`  ${chalk.red('✗')} ${session.title}: ${result?.error?.message ?? 'import failed'}`)
                    continue
                }
                imported += 1
                appended += result.appended ?? 0
                const action = result.action === 'unchanged' ? 'already up to date' : `+${result.appended ?? 0} messages`
                console.log(`  ${chalk.green('✓')} ${session.title} → ${result.hapiSessionId} (${action})`)
            } catch (error) {
                failures += 1
                const message = error instanceof Error ? error.message : String(error)
                console.log(`  ${chalk.red('✗')} ${session.title}: ${message}`)
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

export const dshImportCommand: CommandDefinition = {
    name: 'dsh-import',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await runDshImport(commandArgs)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}
