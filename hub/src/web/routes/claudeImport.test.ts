import { afterEach, describe, expect, it } from 'bun:test'
import type { ClaudeImportedMessage, ClaudeImportSession } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import { importClaudeSession } from './claudeImport'

function machine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: `${id}.local`,
            platform: 'win32',
            happyCliVersion: 'test'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function userMessage(sessionId: string, ordinal: number, text: string, createdAt: number): ClaudeImportedMessage {
    return {
        localId: `claude:${sessionId}:${ordinal}`,
        createdAt,
        content: {
            role: 'user',
            content: { type: 'text', text },
            meta: { sentFrom: 'cli' }
        }
    }
}

function agentMessage(sessionId: string, ordinal: number, text: string, createdAt: number): ClaudeImportedMessage {
    return {
        localId: `claude:${sessionId}:${ordinal}`,
        createdAt,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: text, id: `claude-${ordinal}` }
            },
            meta: { sentFrom: 'cli' }
        }
    }
}

function transcript(sessionId: string, messages: ClaudeImportedMessage[]): ClaudeImportSession {
    return {
        claudeSessionId: sessionId,
        title: `Session ${sessionId}`,
        cwd: 'D:\\ClaudeCode',
        updatedAt: messages.at(-1)?.createdAt ?? 1,
        messages
    }
}

describe('Claude Code session import', () => {
    const stores: Store[] = []

    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    function setup() {
        const store = new Store(':memory:')
        stores.push(store)
        const events: unknown[] = []
        const engine = {
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: (event: unknown) => events.push(event)
        } as unknown as SyncEngine
        return { store, engine, events }
    }

    it('creates an inactive HAPI session with the native history and metadata', () => {
        const { store, engine } = setup()
        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            session: transcript('session_a', [
                userMessage('session_a', 0, 'hello', 100),
                agentMessage('session_a', 1, 'world', 200)
            ])
        })

        expect(result.error).toBeUndefined()
        expect(result.action).toBe('created')
        expect(result.appended).toBe(2)
        const stored = store.sessions.getSessionByNamespace(result.hapiSessionId!, 'default')!
        expect(stored.metadata).toMatchObject({
            flavor: 'claude',
            claudeSessionId: 'session_a',
            machineId: 'machine-1',
            lifecycleState: 'imported',
            name: 'Session session_a'
        })
        expect(store.messages.getAllMessages(result.hapiSessionId!)).toHaveLength(2)
    })

    it('is idempotent and appends only new entries on re-import', () => {
        const { store, engine } = setup()
        const first = transcript('session_a', [
            userMessage('session_a', 0, 'hello', 100),
            agentMessage('session_a', 1, 'world', 200)
        ])
        const created = importClaudeSession({ store, engine, namespace: 'default', machine: machine('machine-1'), session: first })
        expect(created.appended).toBe(2)

        const unchanged = importClaudeSession({ store, engine, namespace: 'default', machine: machine('machine-1'), session: first })
        expect(unchanged.action).toBe('unchanged')
        expect(unchanged.appended).toBe(0)

        const extended = transcript('session_a', [
            ...first.messages,
            userMessage('session_a', 2, 'again', 300),
            agentMessage('session_a', 3, 'sure', 400)
        ])
        const updated = importClaudeSession({ store, engine, namespace: 'default', machine: machine('machine-1'), session: extended })
        expect(updated.action).toBe('updated')
        expect(updated.appended).toBe(2)
        expect(store.messages.getAllMessages(created.hapiSessionId!)).toHaveLength(4)
    })

    it('does not append desktop history beside messages recorded by a live HAPI session', () => {
        const { store, engine } = setup()
        const session = store.sessions.getOrCreateSession('hapi-claude-live', {
            flavor: 'claude',
            machineId: 'machine-1',
            claudeSessionId: 'session_a'
        }, {}, 'default')
        store.messages.addImportedMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'live', id: 'live-1' } },
            meta: { sentFrom: 'cli' }
        }, 'live:1', 50)

        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            session: transcript('session_a', [userMessage('session_a', 0, 'hello', 100)])
        })

        expect(result.error?.code).toBe('transcript_diverged')
        expect(result.error?.message).toContain('live-agent')
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
    })

    it('rejects a rewrite of already imported history', () => {
        const { store, engine } = setup()
        const created = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            session: transcript('session_a', [userMessage('session_a', 0, 'hello', 100)])
        })
        expect(created.error).toBeUndefined()

        const rewritten = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            session: transcript('session_a', [userMessage('session_a', 0, 'changed', 100)])
        })
        expect(rewritten.error?.code).toBe('transcript_diverged')
    })

    it('keeps claude and DSH sessions of the same machine apart', () => {
        const { store, engine } = setup()
        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            session: transcript('session_a', [userMessage('session_a', 0, 'hello', 100)])
        })
        expect(result.error).toBeUndefined()
        const other = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-2'),
            session: transcript('session_a', [userMessage('session_a', 0, 'hello', 100)])
        })
        expect(other.hapiSessionId).not.toBe(result.hapiSessionId)
    })
})
