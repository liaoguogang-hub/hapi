import { isDeepStrictEqual } from 'node:util'
import { Hono } from 'hono'
import {
    ImportKimiSessionsRequestSchema,
    type KimiImportResult,
    type KimiImportSession
} from '@hapi/protocol/apiTypes'
import type { Metadata } from '@hapi/protocol/types'
import type { Store, StoredMessage, StoredSession } from '../../store'
import { ImportedMessageConflictError } from '../../store/messages'
import { truncateOversizedMessageContent } from '../../store/contentCodec'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import { requireCliAuth, type CliEnv } from '../middleware/cliAuth'

/**
 * Kimi Code history import.
 *
 * Mirrors `dshImport.ts`, deliberately: both write append-only desktop history
 * under a per-session `localId` prefix, both refuse to interleave it with
 * messages HAPI itself produced, and both are idempotent on re-run. The two
 * differ only in the flavour, the metadata key that identifies the native
 * session, and the prefix that marks imported rows.
 */

const importLocks = new Map<string, Promise<void>>()

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
}

function storedMetadata(session: StoredSession): JsonRecord {
    return asRecord(session.metadata) ?? {}
}

function importedPrefix(kimiSessionId: string): string {
    return `kimi:${kimiSessionId}:`
}

function findKimiSession(
    store: Store,
    namespace: string,
    machineId: string,
    kimiSessionId: string
): StoredSession | null {
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = storedMetadata(session)
        if (metadata.flavor !== 'kimi'
            || metadata.machineId !== machineId
            || metadata.kimiSessionId !== kimiSessionId) continue
        return session
    }
    return null
}

function lastUserText(session: KimiImportSession): string | null {
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
        const content = session.messages[index]!.content
        if (content.role !== 'user') continue
        const text = content.content.text.trim()
        if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text
    }
    return null
}

type ImportMachine = Pick<Machine, 'id' | 'metadata'>

function buildKimiMetadata(
    session: KimiImportSession,
    machine: ImportMachine,
    existing: JsonRecord
): Metadata {
    const summaryText = lastUserText(session) ?? session.title
    const lifecycleState = typeof existing.lifecycleState === 'string'
        ? existing.lifecycleState
        : 'imported'
    const metadata = {
        ...existing,
        path: session.cwd ?? (typeof existing.path === 'string' ? existing.path : ''),
        host: typeof existing.host === 'string'
            ? existing.host
            : machine.metadata?.host ?? machine.id,
        os: typeof existing.os === 'string'
            ? existing.os
            : machine.metadata?.platform ?? process.platform,
        name: typeof existing.name === 'string' && existing.name
            ? existing.name
            : session.title,
        machineId: machine.id,
        flavor: 'kimi',
        kimiSessionId: session.kimiSessionId,
        lifecycleState,
        lifecycleStateSince: typeof existing.lifecycleStateSince === 'number'
            ? existing.lifecycleStateSince
            : Date.now()
    } as Metadata
    if (summaryText) {
        metadata.summary = { text: summaryText, updatedAt: Date.now() }
    }
    return metadata
}

function updateMetadataWithRetry(
    store: Store,
    sessionId: string,
    namespace: string,
    transform: (metadata: JsonRecord) => Metadata
): void {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = store.sessions.getSessionByNamespace(sessionId, namespace)
        if (!current) throw new Error('Imported HAPI session disappeared')
        const next = transform(storedMetadata(current))
        const result = store.sessions.updateSessionMetadata(
            sessionId,
            next,
            current.metadataVersion,
            namespace,
            { touchUpdatedAt: false }
        )
        if (result.result === 'success') return
        if (result.result === 'error') throw new Error('Failed to persist Kimi import metadata')
    }
    throw new Error('Kimi import metadata changed concurrently')
}

function emitImportedMessages(engine: SyncEngine, sessionId: string, messages: StoredMessage[]): void {
    for (const message of messages) {
        engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId,
            message: {
                id: message.id,
                seq: message.seq,
                localId: message.localId,
                content: message.content,
                createdAt: message.createdAt,
                invokedAt: message.invokedAt
            }
        })
    }
}

type ClassifiedDelta = { messages: KimiImportSession['messages']; error?: string }

/**
 * Re-imports must be safe: entries already stored under this session's
 * `kimi:<id>:` prefix must be a content-identical prefix of the journal, and
 * only the tail may be appended. HAPI-authored messages (a session that ran
 * through `hapi kimi`) are never renumbered: appending desktop history around
 * them would duplicate or reorder the conversation.
 */
function classifyDelta(
    existing: StoredMessage[],
    session: KimiImportSession,
    prefix: string
): ClassifiedDelta {
    const imported = existing.filter((message) => message.localId?.startsWith(prefix))
    const foreign = existing.filter((message) => !message.localId?.startsWith(prefix))
    if (imported.length > session.messages.length) {
        return { messages: [], error: 'The Kimi journal no longer contains the previously imported history' }
    }
    for (let index = 0; index < imported.length; index += 1) {
        const stored = imported[index]!
        const source = session.messages[index]!
        if (stored.localId !== source.localId) {
            return { messages: [], error: `Kimi journal changed at imported entry ${stored.localId}` }
        }
        if (!isDeepStrictEqual(stored.content, truncateOversizedMessageContent(source.content))) {
            return { messages: [], error: `Kimi journal content changed at imported entry ${stored.localId}` }
        }
    }
    const delta = session.messages.slice(imported.length)
    if (delta.length > 0 && foreign.length > 0) {
        return {
            messages: [],
            error: 'This HAPI session already contains live-agent messages; importing native history would duplicate or reorder them'
        }
    }
    return { messages: delta }
}

export function importKimiSession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: ImportMachine
    session: KimiImportSession
}): KimiImportResult {
    const { store, engine, namespace, machine, session } = options
    let stored: StoredSession | null = findKimiSession(
        store,
        namespace,
        machine.id,
        session.kimiSessionId
    )
    try {
        const committed = store.runInTransaction(() => {
            const created = !stored
            if (stored) {
                const current = store.sessions.getSessionByNamespace(stored.id, namespace)
                if (!current) throw new Error('Imported HAPI session disappeared')
                stored = current
            } else {
                stored = store.sessions.getOrCreateSession(
                    `kimi-import:${machine.id}:${session.kimiSessionId}`,
                    buildKimiMetadata(session, machine, {}),
                    {},
                    namespace
                )
            }

            const prefix = importedPrefix(session.kimiSessionId)
            const delta = classifyDelta(store.messages.getAllMessages(stored.id), session, prefix)
            if (delta.error) {
                return {
                    result: {
                        kimiSessionId: session.kimiSessionId,
                        hapiSessionId: stored.id,
                        error: { code: 'transcript_diverged', message: delta.error }
                    } satisfies KimiImportResult,
                    appended: [] as StoredMessage[]
                }
            }
            if (stored.active && delta.messages.length > 0) {
                return {
                    result: {
                        kimiSessionId: session.kimiSessionId,
                        hapiSessionId: stored.id,
                        appended: 0,
                        error: { code: 'session_active', message: 'The matching HAPI session is active; stop it before importing more history' }
                    } satisfies KimiImportResult,
                    appended: [] as StoredMessage[]
                }
            }

            const appended: StoredMessage[] = []
            for (const source of delta.messages) {
                const inserted = store.messages.addImportedMessage(
                    stored.id,
                    source.content,
                    source.localId,
                    source.createdAt
                )
                if (inserted.inserted) appended.push(inserted.message)
            }
            updateMetadataWithRetry(store, stored.id, namespace, (metadata) => buildKimiMetadata(session, machine, metadata))
            return {
                result: {
                    kimiSessionId: session.kimiSessionId,
                    hapiSessionId: stored.id,
                    action: created ? 'created' : appended.length > 0 ? 'updated' : 'unchanged',
                    appended: appended.length
                } satisfies KimiImportResult,
                appended
            }
        })

        if (committed.result.error) return committed.result
        const sessionId = committed.result.hapiSessionId!
        const activityAt = committed.appended.at(-1)?.createdAt ?? session.updatedAt
        engine.recordSessionActivity(sessionId, activityAt)
        emitImportedMessages(engine, sessionId, committed.appended)
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId })
        return committed.result
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to persist imported Kimi history'
        const code = error instanceof ImportedMessageConflictError ? 'transcript_diverged' : 'import_failed'
        const surviving = stored ? store.sessions.getSessionByNamespace(stored.id, namespace) : null
        return {
            kimiSessionId: session.kimiSessionId,
            ...(surviving ? { hapiSessionId: surviving.id } : {}),
            error: { code, message }
        }
    }
}

async function importWithLock(key: string, work: () => KimiImportResult): Promise<KimiImportResult> {
    const prior = importLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const current = prior.catch(() => {}).then(() => gate)
    importLocks.set(key, current)
    await prior.catch(() => {})
    try {
        return work()
    } finally {
        release()
        if (importLocks.get(key) === current) importLocks.delete(key)
    }
}

export function createKimiImportRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<CliEnv> {
    const app = new Hono<CliEnv>()

    app.use('*', requireCliAuth)

    app.post('/kimi/import', async (c) => {
        const engine = options.getSyncEngine()
        if (!engine) return c.json({ error: 'Not ready' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = ImportKimiSessionsRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
        }

        const namespace = c.get('namespace')
        const knownMachine = engine.getMachine(parsed.data.machineId)
        if (knownMachine && knownMachine.namespace !== namespace) {
            return c.json({ error: 'Machine access denied' }, 403)
        }
        // A CLI-only machine (no runner connected) is legitimate: the import
        // route only needs its id and whatever host/platform metadata exists.
        const machine: ImportMachine = engine.getMachineByNamespace(parsed.data.machineId, namespace)
            ?? { id: parsed.data.machineId, metadata: null }

        const results: KimiImportResult[] = []
        for (const session of parsed.data.sessions) {
            results.push(await importWithLock(
                `${namespace}:${machine.id}:${session.kimiSessionId}`,
                () => importKimiSession({
                    store: options.store,
                    engine,
                    namespace,
                    machine,
                    session
                })
            ))
        }
        return c.json({ success: results.every((result) => !result.error), results })
    })

    return app
}
