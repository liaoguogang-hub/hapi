import { afterEach, describe, expect, it } from 'bun:test'
import type { DshImportedMessage, DshImportSession } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import { importDshSession } from './dshImport'

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

function userMessage(sessionId: string, seq: number, text: string, createdAt: number): DshImportedMessage {
    return {
        localId: `dsh:${sessionId}:${seq}:u0`,
        createdAt,
        content: {
            role: 'user',
            content: { type: 'text', text },
            meta: { sentFrom: 'cli' }
        }
    }
}

function agentMessage(sessionId: string, seq: number, text: string, createdAt: number): DshImportedMessage {
    return {
        localId: `dsh:${sessionId}:${seq}:a0`,
        createdAt,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: text, id: `dsh-${seq}-0` }
            },
            meta: { sentFrom: 'cli' }
        }
    }
}

function transcript(sessionId: string, messages: DshImportedMessage[]): DshImportSession {
    return {
        dshSessionId: sessionId,
        title: `Session ${sessionId}`,
        cwd: 'D:\\KimiCode',
        updatedAt: messages.at(-1)?.createdAt ?? 1,
        messages
    }
}

describe('DSH session import', () => {
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
        const result = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            session: transcript('native-1', [
                userMessage('native-1', 2, 'hello', 100),
                agentMessage('native-1', 4, 'world', 200)
            ])
        })

        expect(result.error).toBeUndefined()
        expect(result.action).toBe('created')
        expect(result.appended).toBe(2)
        const stored = store.sessions.getSessionByNamespace(result.hapiSessionId!, 'default')!
        expect(stored.metadata).toMatchObject({
            flavor: 'dsh',
            dshSessionId: 'native-1',
            machineId: 'machine-1',
            lifecycleState: 'imported',
            name: 'Session native-1'
        })
        expect(store.messages.getAllMessages(result.hapiSessionId!)).toHaveLength(2)
    })

    it('is idempotent and appends only new entries on re-import', () => {
        const { store, engine } = setup()
        const first = transcript('native-1', [
            userMessage('native-1', 2, 'hello', 100),
            agentMessage('native-1', 4, 'world', 200)
        ])
        const created = importDshSession({ store, engine, namespace: 'default', machine: machine('machine-1'), session: first })
        expect(created.appended).toBe(2)

        const unchanged = importDshSession({ store, engine, namespace: 'default', machine: machine('machine-1'), session: first })
        expect(unchanged.action).toBe('unchanged')
        expect(unchanged.appended).toBe(0)

        const extended = transcript('native-1', [
            ...first.messages,
            userMessage('native-1', 9, 'again', 300),
            agentMessage('native-1', 11, 'sure', 400)
        ])
        const updated = importDshSession({ store, engine, namespace: 'default', machine: machine('machine-1'), session: extended })
        expect(updated.action).toBe('updated')
        expect(updated.appended).toBe(2)
        expect(store.messages.getAllMessages(created.hapiSessionId!)).toHaveLength(4)
    })

    it('does not append desktop history beside messages recorded by a live HAPI session', () => {
        const { store, engine } = setup()
        const session = store.sessions.getOrCreateSession('hapi-live-session', {
            flavor: 'dsh',
            machineId: 'machine-1',
            dshSessionId: 'native-1'
        }, {}, 'default')
        store.messages.addImportedMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'live', id: 'live-1' } },
            meta: { sentFrom: 'cli' }
        }, 'live:1', 50)

        const result = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            session: transcript('native-1', [userMessage('native-1', 2, 'hello', 100)])
        })

        expect(result.error?.code).toBe('transcript_diverged')
        expect(result.error?.message).toContain('live-agent')
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
    })

    it('rejects a rewrite of already imported history', () => {
        const { store, engine } = setup()
        const created = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            session: transcript('native-1', [userMessage('native-1', 2, 'hello', 100)])
        })
        expect(created.error).toBeUndefined()

        const rewritten = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            session: transcript('native-1', [userMessage('native-1', 2, 'changed', 100)])
        })
        expect(rewritten.error?.code).toBe('transcript_diverged')
    })
})
