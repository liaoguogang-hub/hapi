import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'

export type CliEnv = {
    Variables: {
        namespace: string
    }
}

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

/**
 * Bearer-token auth for every `/cli` route: the token must match the hub's
 * configured `CLI_API_TOKEN`, and its namespace becomes the request namespace.
 */
export const requireCliAuth: MiddlewareHandler<CliEnv> = async (c, next) => {
    c.header('X-Hapi-Protocol-Version', String(PROTOCOL_VERSION))

    const raw = c.req.header('authorization')
    if (!raw) {
        return c.json({ error: 'Missing Authorization header' }, 401)
    }

    const parsed = bearerSchema.safeParse(raw)
    if (!parsed.success) {
        return c.json({ error: 'Invalid Authorization header' }, 401)
    }

    const token = parsed.data.replace(/^Bearer\s+/i, '')
    const configuration = getConfiguration()
    const parsedToken = parseAccessToken(token)
    if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
        return c.json({ error: 'Invalid token' }, 401)
    }

    c.set('namespace', parsedToken.namespace)
    return await next()
}
