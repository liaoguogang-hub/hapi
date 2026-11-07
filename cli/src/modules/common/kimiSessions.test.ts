import { describe, expect, it } from 'vitest'
import { mapKimiWireToMessages, type KimiWireRecord } from './kimiSessions'

function appended(
    role: string,
    content: unknown,
    time: number
): KimiWireRecord {
    return {
        type: 'agent.message.appended',
        time,
        message: { message: { role, content } }
    }
}

function text(value: string): unknown {
    return [{ type: 'text', text: value }]
}

describe('mapKimiWireToMessages', () => {
    it('keeps user and assistant text in order, with stable local ids', () => {
        const records = [
            appended('user', text('你好'), 1000),
            appended('assistant', [{ type: 'think', think: 'thinking...' }], 1100),
            appended('assistant', text('你好，有什么可以帮你'), 1200)
        ]

        const messages = mapKimiWireToMessages('session_a', records, 900)

        expect(messages).toHaveLength(2)
        expect(messages[0]!.localId).toBe('kimi:session_a:0')
        expect(messages[0]!.content.role).toBe('user')
        expect(messages[0]!.content.content).toEqual({ type: 'text', text: '你好' })
        expect(messages[0]!.createdAt).toBe(1000)
        expect(messages[1]!.localId).toBe('kimi:session_a:1')
        expect(messages[1]!.content.role).toBe('agent')
        expect(messages[1]!.content.content).toEqual({
            type: 'codex',
            data: { type: 'message', message: '你好，有什么可以帮你', id: 'kimi:session_a:1' }
        })
    })

    it('drops tool traffic and empty assistant turns', () => {
        const records = [
            appended('user', text('列出文件'), 1000),
            appended('assistant', [], 1100),
            appended('tool', text('total 0'), 1200),
            appended('assistant', text('目录为空'), 1300)
        ]

        const messages = mapKimiWireToMessages('session_a', records, 0)

        expect(messages).toHaveLength(2)
        expect(messages.map((message) => message.content.role)).toEqual(['user', 'agent'])
    })

    it('drops kimi injected context that arrives as a user message', () => {
        const records = [
            appended('user', text('<system-reminder>\nToday is 2026-11-08\n</system-reminder>'), 1000),
            appended('user', text('真正的提问'), 1100),
            appended('assistant', text('回答'), 1200)
        ]

        const messages = mapKimiWireToMessages('session_a', records, 0)

        expect(messages).toHaveLength(2)
        expect(messages[0]!.content.content).toEqual({ type: 'text', text: '真正的提问' })
    })

    it('ignores non-message wire records and malformed entries', () => {
        const records: KimiWireRecord[] = [
            { type: 'turn.prompt' } as KimiWireRecord,
            { type: 'context.append_loop_event', event: { type: 'content.part' } } as KimiWireRecord,
            appended('assistant', text('只有这一条'), 1000)
        ]

        const messages = mapKimiWireToMessages('session_a', records, 0)

        expect(messages).toHaveLength(1)
        expect(messages[0]!.content.content).toEqual({
            type: 'codex',
            data: { type: 'message', message: '只有这一条', id: 'kimi:session_a:0' }
        })
    })

    it('falls back to the session time when a record carries none', () => {
        const records = [{ type: 'agent.message.appended', message: { message: { role: 'user', content: text('hi') } } }]
        const messages = mapKimiWireToMessages('session_a', records as KimiWireRecord[], 4242)
        expect(messages[0]!.createdAt).toBe(4242)
    })
})
