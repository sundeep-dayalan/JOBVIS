/**
 * JOBVIS API configuration
 *
 * In development:  falls back to localhost:8000 (server default)
 * In production:   start.sh exports VITE_API_BASE=http://localhost:8001
 *                  so the prod UI talks to the prod server, not dev.
 *
 * All fetch/WebSocket calls should import from here — never hardcode localhost:8000.
 */

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000'

export const WS_BASE: string =
  (import.meta.env.VITE_WS_BASE as string | undefined) ??
  API_BASE.replace(/^http/, 'ws')
