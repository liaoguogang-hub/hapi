import { execFile } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { DshImportedMessage, DshImportedMessageContent, DshImportSession } from '@hapi/protocol/apiTypes'

const execFileAsync = promisify(execFile)

const PROBE_TIMEOUT_MS = 2_500
const RPC_TIMEOUT_MS = 60_000
const PAGE_MAX_MESSAGES = 200
const MAX_PAGES = 500
const MAX_EVENTS = 50_000
const DEFAULT_SESSION_LIMIT = 500
const COOKIE_TTL_MS = 24 * 60 * 60 * 1_000

/** Absolute origin of a running DSH desktop Host, plus the cookie that authenticates it. */
export type DshHostTarget = {
    baseUrl: string
    /** Value the Host sees in its `Host` header; the cookie is signed for exactly this. */
    authority: string
    cookie: string
}

/** One persisted root Session as the Host reports it in `session/list`. */
export type DshSessionSummary = {
    id: string
    title: string
    cwd: string | null
    updatedAt: number
    running: boolean
    agentAvailable: boolean
    blank: boolean
    origin: string | null
}

export class DshHostUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DshHostUnavailableError'
    }
}

export class DshHostAuthError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DshHostAuthError'
    }
}

type JsonRecord = Record<string, unknown>

export type DshSessionEvent = {
    type: string
    seq: number
    time: number
    data?: unknown
}

function asRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

export function getDshHome(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.DSH_HOME?.trim()
    return configured || join(homedir(), '.dsh')
}

function readDshRemoteStatus(home: string): { upstreamPort: number | null; authority: string | null; cookie: string | null } | null {
    const file = join(home, 'dsh-remote', 'status.json')
    if (!existsSync(file)) return null
    try {
        const parsed = asRecord(JSON.parse(readFileSync(file, 'utf8')))
        return {
            upstreamPort: asNumber(parsed?.upstreamPort),
            authority: asString(parsed?.authority),
            cookie: asString(parsed?.cookie)
        }
    } catch {
        return null
    }
}

/** Extract the browser-session HMAC secret from `~/.dsh/.credentials.yaml`. */
function readDshCookieSecret(home: string): string | null {
    const file = join(home, '.credentials.yaml')
    if (!existsSync(file)) return null
    let text: string
    try {
        text = readFileSync(file, 'utf8')
    } catch {
        return null
    }
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        if (!/client-connection\/browser-session:/.test(lines[index]!)) continue
        for (let offset = index; offset < Math.min(index + 10, lines.length); offset += 1) {
            const match = lines[offset]!.match(/^\s*secret:\s*(\S+)\s*$/)
            if (match) return match[1]!
        }
    }
    return null
}

function base64url(value: Buffer | string): string {
    return Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

export type DshCookieClaims = {
    authority: string
    issuedAt: number
    expiresAt: number
}

/**
 * Sign a browser-session cookie exactly like the desktop Host's own minting path:
 * `dsh-auth-<sha256(authority)>` = `v1.<base64url(claims)>.<hmac-sha256(claims)>`.
 */
export function buildDshBrowserCookie(secret: string, claims: DshCookieClaims): string {
    const body = base64url(Buffer.from(JSON.stringify({
        version: 1,
        authority: claims.authority,
        issuedAt: claims.issuedAt,
        expiresAt: claims.expiresAt
    })))
    const signature = base64url(createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest())
    const name = `dsh-auth-${base64url(createHash('sha256').update(claims.authority).digest())}`
    return `${name}=v1.${body}.${signature}`
}

export function mintDshBrowserCookie(authority: string, options?: {
    home?: string
    now?: number
    ttlMs?: number
}): string | null {
    const home = options?.home ?? getDshHome()
    const secret = readDshCookieSecret(home)
    if (!secret) return null
    const issuedAt = options?.now ?? Date.now()
    return buildDshBrowserCookie(secret, {
        authority,
        issuedAt,
        expiresAt: issuedAt + (options?.ttlMs ?? COOKIE_TTL_MS)
    })
}

function normalizeBaseUrl(raw: string): string {
    let value = raw.trim()
    if (!value) return ''
    if (!value.startsWith('http://') && !value.startsWith('https://')) value = `http://${value}`
    const parsed = new URL(value)
    return `${parsed.protocol}//${parsed.host}`
}

function authorityFromBaseUrl(baseUrl: string): string {
    return new URL(baseUrl).host
}

function parsePorts(stdout: string): number[] {
    return stdout
        .split(/\s+/)
        .map((entry) => Number(entry))
        .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535)
}

/**
 * Ports bound by the DSH desktop Host process.
 *
 * The Host picks a random port on every launch, so a fixed address is never
 * reliable. Windows is the primary target; other platforms fall back to lsof.
 */
async function listDshHostPorts(): Promise<number[]> {
    if (process.platform === 'win32') {
        const script = [
            'Get-CimInstance Win32_Process -Filter "Name=\'DeepSeek Harness.exe\'"',
            '| Where-Object { $_.CommandLine -match \'dsh-desktop-host\' }',
            '| ForEach-Object { Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique }'
        ].join(' ')
        try {
            const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 8_000 })
            return [...new Set(parsePorts(stdout))]
        } catch {
            return []
        }
    }

    try {
        const { stdout: processList } = await execFileAsync('ps', ['-axo', 'pid=,command='], { timeout: 5_000 })
        const pids = processList
            .split(/\r?\n/)
            .filter((line) => /dsh-desktop-host|DeepSeek Harness/.test(line))
            .map((line) => Number(line.trim().split(/\s+/)[0]))
            .filter((pid) => Number.isInteger(pid) && pid > 0)
        const ports = new Set<number>()
        for (const pid of pids) {
            try {
                const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], { timeout: 5_000 })
                for (const match of stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g)) ports.add(Number(match[1]))
            } catch {
                // The process may be gone between ps and lsof.
            }
        }
        return [...ports]
    } catch {
        return []
    }
}

async function dshRpc(
    target: Pick<DshHostTarget, 'baseUrl' | 'cookie'>,
    endpoint: string,
    args: unknown,
    timeoutMs = RPC_TIMEOUT_MS
): Promise<JsonRecord> {
    const response = await fetch(`${target.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            cookie: target.cookie
        },
        body: JSON.stringify({
            type: 'client-request',
            rpcId: `hapi-dsh-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            method: endpoint,
            payload: { args }
        }),
        signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await response.text()
    if (response.status === 401 || response.status === 403) {
        throw new DshHostAuthError(`DSH Host rejected the cookie for ${target.baseUrl} (HTTP ${response.status})`)
    }
    if (!response.ok) {
        throw new Error(`DSH ${endpoint} failed with HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    let envelope: JsonRecord
    try {
        envelope = JSON.parse(text) as JsonRecord
    } catch {
        throw new Error(`DSH ${endpoint} returned non-JSON output`)
    }
    const result = asRecord(envelope.result)
    if (!result || result.ok !== true) {
        const error = asRecord(result?.error)
        const code = asString(error?.code) ?? 'unknown'
        const message = asString(error?.message) ?? `${endpoint} failed`
        throw new Error(`DSH ${endpoint} failed (${code}): ${message}`)
    }
    return asRecord(result.value) ?? {}
}

async function probeDshHost(baseUrl: string, cookie: string): Promise<boolean> {
    try {
        await dshRpc({ baseUrl, cookie }, 'session/list', { _request: {} }, PROBE_TIMEOUT_MS)
        return true
    } catch {
        return false
    }
}

export type DiscoverDshHostOptions = {
    url?: string
    cookie?: string
    env?: NodeJS.ProcessEnv
}

/**
 * Find the running desktop Host.
 *
 * Order: explicit URL (env/flag) → the remote plugin's status file → the Host
 * process's listening ports. A cookie for the exact `Host` authority is minted
 * from `~/.dsh/.credentials.yaml`, because the Host validates the audience bound
 * into the cookie instead of trusting a shared token.
 */
export async function discoverDshHost(options: DiscoverDshHostOptions = {}): Promise<DshHostTarget> {
    const env = options.env ?? process.env
    const home = getDshHome(env)
    const status = readDshRemoteStatus(home)

    const explicitUrl = options.url?.trim() || env.HAPI_DSH_HOST_URL?.trim()
    if (explicitUrl) {
        const baseUrl = normalizeBaseUrl(explicitUrl)
        const authority = authorityFromBaseUrl(baseUrl)
        const cookie = options.cookie?.trim()
            || env.HAPI_DSH_HOST_COOKIE?.trim()
            || (status?.authority === authority ? status.cookie ?? undefined : undefined)
            || mintDshBrowserCookie(authority, { home })
        if (!cookie) {
            throw new DshHostUnavailableError(
                `No DSH browser cookie available for ${authority}. `
                + `Set HAPI_DSH_HOST_COOKIE or make sure ${join(home, '.credentials.yaml')} contains client-connection/browser-session.`
            )
        }
        if (!await probeDshHost(baseUrl, cookie)) {
            throw new DshHostUnavailableError(`No DSH Host answered at ${baseUrl}`)
        }
        return { baseUrl, authority, cookie }
    }

    const candidatePorts = new Set<number>()
    if (status?.upstreamPort) candidatePorts.add(status.upstreamPort)
    for (const port of await listDshHostPorts()) candidatePorts.add(port)

    for (const port of candidatePorts) {
        const authority = `127.0.0.1:${port}`
        const baseUrl = `http://${authority}`
        const cookie = mintDshBrowserCookie(authority, { home })
            ?? (status?.authority === authority ? status.cookie : null)
        if (!cookie) continue
        if (await probeDshHost(baseUrl, cookie)) return { baseUrl, authority, cookie }
    }

    throw new DshHostUnavailableError(
        'DSH desktop Host was not found. Start the DeepSeek Harness desktop app '
        + 'or pass HAPI_DSH_HOST_URL (and HAPI_DSH_HOST_COOKIE if the Host uses a tunnel).'
    )
}

function projectionValues(row: JsonRecord): JsonRecord | null {
    const projections = asRecord(row.projections)
    if (!projections) return null
    return asRecord(projections.values) ?? projections
}

/** Persisted root Sessions, newest first. Subagent rows are hidden. */
export async function listDshSessions(
    target: DshHostTarget,
    options?: { limit?: number }
): Promise<DshSessionSummary[]> {
    const value = await dshRpc(target, 'session/list', { _request: {} })
    const items = Array.isArray(value.items) ? value.items : []
    const sessions: DshSessionSummary[] = []
    for (const item of items) {
        const row = asRecord(item)
        if (!row) continue
        const id = asString(row.sessionId)
        if (!id) continue
        const origin = asString(row.origin)
        if (origin === 'subagent') continue
        const title = asString(projectionValues(row)?.title)
        sessions.push({
            id,
            title: title && title !== 'null' ? title : `DSH ${id.slice(0, 8)}`,
            cwd: asString(row.cwd),
            updatedAt: asNumber(row.updatedAt) ?? 0,
            running: row.running === true,
            agentAvailable: row.agentAvailable === true,
            blank: row.blank === true,
            origin
        })
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return sessions.slice(0, Math.max(1, options?.limit ?? DEFAULT_SESSION_LIMIT))
}

function parseEvent(value: unknown): DshSessionEvent | null {
    const event = asRecord(value)
    if (!event) return null
    const type = asString(event.type)
    const seq = asNumber(event.seq)
    const time = asNumber(event.time)
    if (!type || seq === null || time === null) return null
    return { type, seq, time, data: event.data }
}

/**
 * Read the durable event log for one Session.
 *
 * `session/projections` gives the current head watermark (`asOfSeq`), which is
 * the inclusive cut `session/page` needs. Pages walk backwards until the Host
 * reports no more, then the union is sorted by seq.
 */
export async function readDshSessionEvents(
    target: DshHostTarget,
    sessionId: string
): Promise<DshSessionEvent[]> {
    const projections = await dshRpc(target, 'session/projections', { request: { sessionId } })
    const throughSeq = asNumber(projections.asOfSeq)
    if (throughSeq === null) {
        throw new Error(`DSH did not report a head seq for session ${sessionId}`)
    }

    const events = new Map<number, DshSessionEvent>()
    let beforeSeq: number | null = null
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
        const request: JsonRecord = {
            address: { kind: 'session', sessionId },
            throughSeq,
            maxMessages: PAGE_MAX_MESSAGES
        }
        if (beforeSeq !== null) request.beforeSeq = beforeSeq
        const page = await dshRpc(target, 'session/page', { request })
        const records = Array.isArray(page.records) ? page.records : []
        let oldest: number | null = null
        for (const record of records) {
            const row = asRecord(record)
            const event = parseEvent(row?.event)
            if (!event) continue
            events.set(event.seq, event)
            if (oldest === null || event.seq < oldest) oldest = event.seq
        }
        if (events.size > MAX_EVENTS) {
            throw new Error(`Session ${sessionId} has more than ${MAX_EVENTS} events; import was stopped`)
        }
        if (page.hasMore !== true) break
        if (oldest === null || (beforeSeq !== null && oldest >= beforeSeq)) break
        beforeSeq = oldest
    }

    return [...events.values()].sort((a, b) => a.seq - b.seq)
}

function textBlocks(content: unknown): string[] {
    if (!Array.isArray(content)) return []
    const blocks: string[] = []
    for (const entry of content) {
        const block = asRecord(entry)
        if (block?.type !== 'text') continue
        const text = asString(block.text)
        if (text && text.trim()) blocks.push(text)
    }
    return blocks
}

function importedUser(text: string): DshImportedMessageContent {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: { sentFrom: 'cli' }
    }
}

function importedAgent(text: string, id: string): DshImportedMessageContent {
    return {
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: text, id } },
        meta: { sentFrom: 'cli' }
    }
}

/**
 * DSH events that carry conversation text, mapped to HAPI's imported-message
 * shape. Tool calls and reasoning stay out of the transcript (same policy as the
 * desktop app's own chat view), and local ids are derived from `seq` so a
 * re-import is stable.
 */
export function mapDshEventsToMessages(
    sessionId: string,
    events: DshSessionEvent[]
): DshImportedMessage[] {
    const messages: DshImportedMessage[] = []
    for (const event of events) {
        const data = asRecord(event.data)
        if (!data) continue
        if (event.type === 'user/message') {
            // The log also carries Host-injected turns; only real human input is shown.
            const source = asRecord(data.source)
            if (source?.kind !== 'user') continue
            textBlocks(data.content).forEach((text, index) => {
                messages.push({
                    localId: `dsh:${sessionId}:${event.seq}:u${index}`,
                    createdAt: event.time,
                    content: importedUser(text)
                })
            })
            continue
        }
        if (event.type === 'assistant/message') {
            const message = asRecord(data.message)
            if (!message) continue
            textBlocks(message.content).forEach((text, index) => {
                messages.push({
                    localId: `dsh:${sessionId}:${event.seq}:a${index}`,
                    createdAt: event.time,
                    content: importedAgent(text, `dsh-${event.seq}-${index}`)
                })
            })
        }
    }
    return messages
}

/**
 * The list endpoint omits projections on a cold Host, so the readable title is
 * recovered from the durable `session/title` event while the log is open.
 */
function titleFromEvents(events: DshSessionEvent[]): string | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!
        if (event.type !== 'session/title') continue
        const title = asString(asRecord(event.data)?.title)
        if (title && title !== 'null') return title
    }
    return null
}

/** Read summaries + full transcripts for the requested Session ids. */
export async function readDshImportSessions(
    target: DshHostTarget,
    sessionIds: string[],
    options?: { summaries?: DshSessionSummary[] }
): Promise<DshImportSession[]> {
    const summaries = options?.summaries ?? await listDshSessions(target)
    const byId = new Map(summaries.map((summary) => [summary.id, summary]))
    const result: DshImportSession[] = []
    for (const sessionId of sessionIds) {
        const summary = byId.get(sessionId)
        const events = await readDshSessionEvents(target, sessionId)
        const messages = mapDshEventsToMessages(sessionId, events)
        result.push({
            dshSessionId: sessionId,
            title: titleFromEvents(events) ?? summary?.title ?? `DSH ${sessionId.slice(0, 8)}`,
            cwd: summary?.cwd ?? null,
            updatedAt: summary?.updatedAt ?? (events.at(-1)?.time ?? Date.now()),
            messages
        })
    }
    return result
}
