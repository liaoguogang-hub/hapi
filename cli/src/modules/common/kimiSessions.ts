import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { KimiImportedMessage, KimiImportedMessageContent, KimiImportSession } from '@hapi/protocol/apiTypes'

/**
 * Reads kimi-code's own session store.
 *
 * kimi-code keeps one directory per session under
 * `<KIMI_CODE_HOME>/sessions/<workspaceId>/<sessionId>/`, where `workspaceId` is
 * `wd_<slug>_<sha256(workDir)[0..12]>` (mirrored by `encodeKimiWorkDirKey`). A
 * session directory holds:
 *
 *   state.json                 id, cwd, title, archived, createdAt, updatedAt
 *   agents/main/wire.jsonl     the turn journal
 *
 * Unlike DSH there is no host RPC to ask for a transcript, so the store is the
 * only source. `wire.jsonl` records streaming deltas *and* the consolidated
 * messages; only `agent.message.appended` is used here, because the deltas
 * (`context.append_loop_event`) would split one assistant reply across many
 * fragmentary messages.
 */

const DEFAULT_LIMIT = 500

export type KimiSessionSummary = {
    id: string
    title: string
    cwd: string | null
    updatedAt: number
    archived: boolean
    sessionDir: string
}

type JsonRecord = Record<string, unknown>

/** One parsed line of `wire.jsonl`. */
export type KimiWireRecord = JsonRecord

function asRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function getKimiCodeHome(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.KIMI_CODE_HOME?.trim()
    return configured || join(homedir(), '.kimi-code')
}

/** Text blocks of a kimi message's `content` array, in order. */
function textOfContent(content: unknown): string {
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const entry of content) {
        const block = asRecord(entry)
        if (block?.type !== 'text') continue
        const text = asString(block.text)
        if (text) parts.push(text)
    }
    return parts.join('\n').trim()
}

/**
 * Injected context kimi sends as a `user` message.
 *
 * The wire's consolidated messages normally exclude these, but a version change
 * could start including them; importing them would produce turns the user never
 * wrote.
 */
function isInjectedContext(text: string): boolean {
    const head = text.trimStart()
    return head.startsWith('<system-reminder>')
        || head.startsWith('The active project context is now')
        || head.startsWith('Auto permission mode is active')
}

async function readJsonFile(path: string): Promise<JsonRecord | null> {
    try {
        return asRecord(JSON.parse(await readFile(path, 'utf8')))
    } catch {
        return null
    }
}

/** The session's `state.json`, normalised. */
async function readState(sessionDir: string): Promise<JsonRecord | null> {
    return await readJsonFile(join(sessionDir, 'state.json'))
}

function summaryFrom(sessionDir: string, state: JsonRecord): KimiSessionSummary | null {
    const id = asString(state.id) ?? sessionDir.split(/[\\/]/).pop() ?? null
    if (!id) return null
    // kimi-code only titles a session once it has generated one; until then the
    // desktop shows the last prompt. `id.slice(0, 8)` is useless here because
    // every id starts with `session_`.
    const title = (asString(state.title) ?? '').trim() || (asString(state.lastPrompt) ?? '').trim()
    return {
        id,
        title,
        cwd: asString(state.cwd),
        updatedAt: asNumber(state.updatedAt) ?? 0,
        archived: state.archived === true,
        sessionDir
    }
}

/**
 * Every session kimi-code has on disk, newest first.
 *
 * The session directories are the source of truth; `session_index.jsonl` is a
 * derived cache that can lag behind (the CLI repairs it with its own
 * reconciliation pass), so it is deliberately not used here.
 */
export async function listKimiSessions(options?: {
    cwd?: string
    includeArchived?: boolean
    limit?: number
    home?: string
}): Promise<KimiSessionSummary[]> {
    const home = options?.home ?? getKimiCodeHome()
    const sessionsRoot = join(home, 'sessions')
    if (!existsSync(sessionsRoot)) return []

    const wantedCwd = options?.cwd?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const includeArchived = options?.includeArchived === true
    const sessions: KimiSessionSummary[] = []

    for (const workspace of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (!workspace.isDirectory() || !workspace.name.startsWith('wd_')) continue
        const workspaceDir = join(sessionsRoot, workspace.name)
        let entries
        try {
            entries = await readdir(workspaceDir, { withFileTypes: true })
        } catch {
            continue
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('session_')) continue
            const sessionDir = join(workspaceDir, entry.name)
            const state = await readState(sessionDir)
            if (!state) continue
            const summary = summaryFrom(sessionDir, state)
            if (!summary) continue
            if (!includeArchived && summary.archived) continue
            if (wantedCwd) {
                const cwd = summary.cwd?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
                if (cwd !== wantedCwd) continue
            }
            sessions.push(summary)
        }
    }

    sessions.sort((left, right) => right.updatedAt - left.updatedAt)
    return sessions.slice(0, Math.max(1, options?.limit ?? DEFAULT_LIMIT))
}

/** Parses `agents/main/wire.jsonl`, ignoring unreadable lines. */
async function readWireRecords(sessionDir: string): Promise<JsonRecord[]> {
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl')
    let text: string
    try {
        text = await readFile(wirePath, 'utf8')
    } catch {
        return []
    }
    const records: JsonRecord[] = []
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
            const parsed = asRecord(JSON.parse(trimmed))
            if (parsed) records.push(parsed)
        } catch {
            // A partially written trailing line is normal for a live journal.
        }
    }
    return records
}

function importedUser(text: string): KimiImportedMessageContent {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: { sentFrom: 'cli' }
    }
}

function importedAgent(text: string, id: string): KimiImportedMessageContent {
    return {
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: text, id } },
        meta: { sentFrom: 'cli' }
    }
}

/**
 * Maps the consolidated turn records of a kimi wire journal onto HAPI's
 * imported-message shape.
 *
 * Tool traffic and reasoning are dropped: the phone's chat view renders neither
 * for imported history, and keeping them would balloon a session that the
 * desktop shows as a handful of turns.
 *
 * Local ids are `<prefix><ordinal>`, so a re-import lines up with what the hub
 * already stored and only a genuine tail is appended.
 */
export function mapKimiWireToMessages(
    kimiSessionId: string,
    records: KimiWireRecord[],
    fallbackTime: number
): KimiImportedMessage[] {
    const prefix = `kimi:${kimiSessionId}:`
    const messages: KimiImportedMessage[] = []

    for (const record of records) {
        if (record.type !== 'agent.message.appended') continue
        const envelope = asRecord(record.message)
        const body = asRecord(envelope?.message)
        const role = asString(body?.role)
        if (role !== 'user' && role !== 'assistant') continue

        const text = textOfContent(body?.content)
        if (!text) continue
        if (role === 'user' && isInjectedContext(text)) continue

        const createdAt = asNumber(record.time) ?? asNumber(envelope?.time) ?? fallbackTime
        const localId = `${prefix}${messages.length}`
        messages.push({
            localId,
            createdAt,
            content: role === 'user' ? importedUser(text) : importedAgent(text, localId)
        })
    }

    return messages
}

/** Reads one session's transcript and packages it for the hub import route. */
export async function readKimiImportSession(summary: KimiSessionSummary): Promise<KimiImportSession> {
    const state = await readState(summary.sessionDir)
    const records = await readWireRecords(summary.sessionDir)
    const updatedAt = asNumber(state?.updatedAt) ?? summary.updatedAt
    const messages = mapKimiWireToMessages(summary.id, records, updatedAt)
    const title = summary.title || `Kimi ${summary.id.replace(/^session_/, '').slice(0, 8)}`
    return {
        kimiSessionId: summary.id,
        title,
        cwd: summary.cwd,
        updatedAt,
        messages
    }
}
