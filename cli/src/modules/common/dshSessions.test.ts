import { describe, expect, it } from 'vitest'
import {
    buildDshBrowserCookie,
    mapDshEventsToMessages,
    type DshSessionEvent
} from './dshSessions'

function cookieParts(cookie: string): { name: string; body: string; signature: string } {
    const [pair] = cookie.split('=')
    const [name, payload] = [pair!, cookie.slice(pair!.length + 1)]
    const [prefix, body, signature] = payload.split('.')
    expect(prefix).toBe('v1')
    return { name: name!, body: body!, signature: signature! }
}

describe('buildDshBrowserCookie', () => {
    const secret = Buffer.from('test-secret').toString('base64url')

    it('binds the authority into the cookie name and claims', () => {
        const issuedAt = 1_700_000_000_000
        const cookie = buildDshBrowserCookie(secret, {
            authority: '127.0.0.1:6413',
            issuedAt,
            expiresAt: issuedAt + 60_000
        })
        const parts = cookieParts(cookie)
        expect(parts.name).toMatch(/^dsh-auth-[A-Za-z0-9_-]+$/)
        const claims = JSON.parse(Buffer.from(parts.body, 'base64url').toString('utf8'))
        expect(claims).toEqual({
            version: 1,
            authority: '127.0.0.1:6413',
            issuedAt,
            expiresAt: issuedAt + 60_000
        })
        expect(parts.signature.length).toBeGreaterThan(20)
    })

    it('changes the signature when the secret changes', () => {
        const claims = { authority: '127.0.0.1:6413', issuedAt: 1, expiresAt: 2 }
        const first = buildDshBrowserCookie(secret, claims)
        const second = buildDshBrowserCookie(Buffer.from('other').toString('base64url'), claims)
        expect(first).not.toBe(second)
    })
})

describe('mapDshEventsToMessages', () => {
    const events: DshSessionEvent[] = [
        { type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } },
        {
            type: 'user/message',
            seq: 2,
            time: 100,
            data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }
        },
        {
            type: 'user/message',
            seq: 3,
            time: 101,
            data: { content: [{ type: 'text', text: '<system-reminder>' }], source: { kind: 'agent-instructions' } }
        },
        {
            type: 'assistant/message',
            seq: 4,
            time: 200,
            data: {
                message: {
                    content: [
                        { type: 'reasoning', text: 'thinking' },
                        { type: 'text', text: 'answer' },
                        { type: 'tool-call', id: 'call-1', name: 'pwsh' }
                    ]
                }
            }
        },
        {
            type: 'assistant/message',
            seq: 5,
            time: 300,
            data: { message: { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] } }
        }
    ]

    it('keeps human and assistant text only, with stable local ids', () => {
        const messages = mapDshEventsToMessages('session-1', events)
        expect(messages.map((message) => message.localId)).toEqual([
            'dsh:session-1:2:u0',
            'dsh:session-1:4:a0',
            'dsh:session-1:5:a0',
            'dsh:session-1:5:a1'
        ])
        expect(messages.map((message) => message.createdAt)).toEqual([100, 200, 300, 300])
        expect(messages[0]!.content).toEqual({
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { sentFrom: 'cli' }
        })
        const agent = messages[1]!.content
        expect(agent.role).toBe('agent')
        if (agent.role !== 'agent') return
        expect(agent.content.type).toBe('codex')
        expect(agent.content.data).toEqual({ type: 'message', message: 'answer', id: 'dsh-4-0' })
    })

    it('ignores host-injected turns and non-text assistant content', () => {
        const messages = mapDshEventsToMessages('session-1', events)
        const userTexts = messages
            .filter((message) => message.content.role === 'user')
            .map((message) => (message.content.content as { text: string }).text)
        expect(userTexts).toEqual(['hello'])
        const agentTexts = messages
            .filter((message) => message.content.role === 'agent')
            .map((message) => (message.content.content as { data?: { message?: string } }).data?.message)
        expect(agentTexts).toEqual(['answer', 'first', 'second'])
    })
})
