import { createMiddleware } from 'hono/factory';

export function createAuthMiddleware(token: string) {
  return createMiddleware(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (authHeader === `Bearer ${token}`) {
      return next();
    }

    // Fallback: query param (for Ponder which cannot set custom headers)
    const queryToken = c.req.query('token');
    if (queryToken === token) {
      return next();
    }

    return c.json({ error: 'Unauthorized' }, 401);
  });
}
