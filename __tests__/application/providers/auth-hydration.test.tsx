import { act } from 'react'
import { renderToString } from 'react-dom/server'
import { hydrateRoot } from 'react-dom/client'
import { render, screen } from '@testing-library/react'
import { AuthProvider, useAuth } from '@/src/application/providers/auth.provider'
import { QueryProvider } from '@/src/application/providers/query-provider'

let resolveSessionLookup: ((response: Response) => void) | undefined
const originalFetch = globalThis.fetch
jest.mock('@/src/application/telemetry/usage-analytics', () => ({ setUserProps: jest.fn(), trackEvent: jest.fn() }))
jest.mock('@/src/shared/hooks/use-app-version.hook', () => ({ useAppVersion: () => null }))
jest.mock('@/src/application/services/beta-features-sync', () => ({ syncBetaFeaturesForAccount: jest.fn() }))
jest.mock('@/src/application/services/outpatient-prefs-sync', () => ({ syncOutpatientPrefsForAccount: jest.fn() }))
jest.mock('@/src/application/stores/ai-config.store', () => ({ useAiConfigStore: jest.fn() }))
jest.mock('@/src/infrastructure/fhir/services/local-bundle.service', () => ({ LocalBundleService: {} }))
jest.mock('@/src/infrastructure/fhir/client/fhir-client.service', () => ({ clearSmartSession: jest.fn() }))
jest.mock('@/src/infrastructure/cache/encrypted-session-cache', () => ({ purgeAiResultCaches: jest.fn() }))
jest.mock('@/src/shared/utils/reset-on-bundle-change', () => ({ notifyBundleChanged: jest.fn() }))

function Status() {
  const { loading } = useAuth()
  return <p>{loading ? '正在恢復登入' : '登入'}</p>
}

function App() {
  return <QueryProvider><AuthProvider><Status /></AuthProvider></QueryProvider>
}

describe('AuthProvider hydration', () => {
  beforeEach(() => {
    resolveSessionLookup = undefined
    globalThis.fetch = jest.fn(() => new Promise<Response>((resolve) => {
      resolveSessionLookup = resolve
    })) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('hydrates server markup unchanged while the self-hosted session lookup is pending', async () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(<App />)
    expect(container.textContent).toBe('正在恢復登入')
    document.body.appendChild(container)
    const onRecoverableError = jest.fn()
    let root: ReturnType<typeof hydrateRoot>
    await act(async () => { root = hydrateRoot(container, <App />, { onRecoverableError }) })
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container.textContent).toBe('正在恢復登入')
    await act(async () => {
      resolveSessionLookup!({
        ok: true,
        json: async () => ({ user: null }),
      } as Response)
    })
    expect(container.textContent).toBe('登入')
    await act(async () => { root!.unmount() })
    container.remove()
  })

  it('finishes loading after mount when the self-hosted session endpoint is unavailable', async () => {
    render(<App />)
    await act(async () => { resolveSessionLookup!({ ok: false } as Response) })
    expect(screen.getByText('登入')).toBeInTheDocument()
  })
})
