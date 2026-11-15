// Shared FHIR Bundle import logic — used by both the header
// `ImportBundleButton` and the drop zone in `WelcomeOnboarding` so the
// parse/save/cache-invalidate pipeline lives in one place.
//
// Cross-instance sync: each call to this hook owns its own React state,
// but localStorage is global. When one instance imports / clears the
// bundle, all other instances need to learn about it (e.g. so the header
// trash button appears after the welcome screen drops a file). We solve
// that with a window event the writer dispatches and every instance
// subscribes to.
"use client"

import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LocalBundleService } from '@/src/infrastructure/fhir/services/local-bundle.service'
import { shouldUseLocalBundle } from '@/src/infrastructure/fhir/client/fhir-client.service'
import {
  purgeAiResultCaches,
  purgeExpiredAiResultCaches,
} from '@/src/infrastructure/cache/encrypted-session-cache'
import { generateId } from '@/src/shared/utils/id.utils'
import { serializeLocalBundleMutation } from '@/src/infrastructure/fhir/services/local-bundle-mutation-queue'
import {
  BUNDLE_CHANGED_EVENT,
  notifyBundleChangeSettled,
  notifyBundleChanged,
} from '@/src/shared/utils/reset-on-bundle-change'
import type { ClinicalSourceMetadata } from '@/src/core/entities/clinical-data.entity'
import { prepareLocalImportFile } from '../services/local-import-file.service'
import { ProgressiveImportError } from '../services/progressive-import-transaction'
import { persistSummaryVersions } from '@/src/application/hooks/medical-summary/summary-versions.store'
import { reportHospitalCapture } from '@/src/infrastructure/telemetry/hospital-capture'

export interface ImportBundleOptions {
  signal?: AbortSignal
  expectedImportId?: string
  requireEmpty?: boolean
  onCommitted?: (importId: string) => void
  /** Only the validated progressive transaction supplies this ownership. */
  progressiveRunId?: string
  /** The progressive stage, so a finished 北榮 capture can be logged (no clinical effect). */
  progressiveStage?: string
  /** Why a cloud-only stage has no hospital data (closed code from the progressive request). */
  progressiveReason?: string
}

export interface UseImportBundleReturn {
  /** Parse + persist a FHIR Bundle file. Throws on validation error;
   *  errors are also captured into the `error` state for UI use. */
  importFile: (file: File, options?: ImportBundleOptions) => Promise<void>
  /** Wipe the imported bundle from localStorage. */
  clear: () => Promise<void>
  loading: boolean
  error: string | null
  hasBundle: boolean
  bundleIsActive: boolean
}

export function useImportBundle(): UseImportBundleReturn {
  const queryClient = useQueryClient()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // SSR-safe initial values (false); synced post-hydration so server and
  // client first paints match.
  const [hasBundle, setHasBundle] = useState(false)
  const [bundleIsActive, setBundleIsActive] = useState(false)

  useEffect(() => {
    const sync = () => {
      setHasBundle(LocalBundleService.hasData())
      setBundleIsActive(shouldUseLocalBundle())
    }

    // A localStorage presence marker is shared by every tab on this origin,
    // while the bundle's decryption key is deliberately tab-scoped. Validate
    // the persisted bundle before publishing the initial badge state: a newly
    // opened tab may see the marker but be unable to decrypt the chart. load()
    // clears that inaccessible record; the follow-up sync then keeps both the
    // "Local data" badge and its trash action hidden on the welcome screen.
    let active = true
    const reconcileInitialState = async () => {
      if (LocalBundleService.hasData()) {
        // A freshly opened tab may have inherited sessionStorage from an
        // opener while the bridge immediately starts a new import. Serialize
        // startup reconciliation with save/clear so a late legacy load cannot
        // overwrite the newly imported tab scope in memory.
        await serializeLocalBundleMutation(() => LocalBundleService.load())
      }
      if (active) sync()
    }
    void reconcileInitialState()

    window.addEventListener(BUNDLE_CHANGED_EVENT, sync)
    return () => {
      active = false
      window.removeEventListener(BUNDLE_CHANGED_EVENT, sync)
    }
  }, [])

  // Shared persist core for real imports: validate, save, then refresh
  // presence state + invalidate queries.
  const persistBundle = useCallback(async (
    bundle: any,
    originalFhir: Blob,
    sourceMetadata?: ClinicalSourceMetadata,
    patientProfile?: ReturnType<typeof LocalBundleService.getUserEnteredPatientProfile>,
    signal?: AbortSignal,
    beforeCommit?: () => void,
    onCommitted?: (importId: string) => void,
    preserveMedicalSummary = false,
  ) => {
    if (bundle?.resourceType !== 'Bundle') {
      throw new Error('Not a FHIR Bundle (resourceType must be "Bundle")')
    }
    const localImportId = generateId()
    const parsed = LocalBundleService.validateImport(bundle, { importId: localImportId, sourceMetadata })
    if (!parsed) {
      throw new Error('Bundle must contain at least one Patient resource')
    }
    // Close the background-AI gate BEFORE publishing a newly imported real
    // bundle. The local save/query refresh still completes normally (the bridge
    // waits for that settled signal), while the contextual consent dialog can be
    // answered afterwards.
    // The storage layer checks again after preparing encrypted data, before
    // publishing the new pointer and key.
    signal?.throwIfAborted()
    await LocalBundleService.save(bundle, {
      importId: localImportId,
      sourceMetadata,
      originalFhir,
      ...(signal ? { signal, beforeCommit } : {}),
      ...(patientProfile ? { patientProfile } : {}),
    })
    // Publish progressive ownership before query refresh can yield to another
    // browser task, so a terminal safety notice is visible immediately.
    onCommitted?.(localImportId)
    // Importing NEW data must not leave the PREVIOUS bundle's derived results
    // around, or the render goes inconsistent (old AI summary / safety scan /
    // report interpretation shown against new clinical data — worst when the two
    // bundles share a patient id). Drop the persisted AI caches here; the
    // in-memory AI stores reset off the notifyBundleChanged() event below. This
    // is the same cleanup clear() does — import = clear-then-load.
    purgeExpiredAiResultCaches()
    purgeAiResultCaches()
    setHasBundle(true)
    setBundleIsActive(shouldUseLocalBundle())
    notifyBundleChanged(preserveMedicalSummary)
    // Transfer retained reading history into the committed bundle's encryption
    // namespace before query refresh can wait on a slow clinical-data fetch.
    if (preserveMedicalSummary) await persistSummaryVersions()
    try {
      await queryClient.invalidateQueries()
    } finally {
      notifyBundleChangeSettled()
    }
    return localImportId
  }, [queryClient])

  const importFile = useCallback(async (file: File, options?: ImportBundleOptions) => {
    setLoading(true)
    setError(null)
    try {
      await serializeLocalBundleMutation(async () => {
        const assertExpectedImport = () => {
          options?.signal?.throwIfAborted()
          if (options?.requireEmpty && LocalBundleService.hasData()) throw new ProgressiveImportError('IMPORT_STALE', '目前已載入其他資料，已停止自動匯入。')
          if (options?.expectedImportId && LocalBundleService.getActiveImportId() !== options.expectedImportId) {
            throw new ProgressiveImportError('IMPORT_STALE', '目前資料已變更，已停止院內門診補載。')
          }
        }
        assertExpectedImport()
        const prepared = await prepareLocalImportFile(file)
        assertExpectedImport()
        if (options?.expectedImportId) {
          const previous = await LocalBundleService.load()
          const patientId = (bundle: any) => bundle?.entry?.filter((entry: any) => entry?.resource?.resourceType === 'Patient').map((entry: any) => entry.resource.id)
          const previousIds = patientId(previous), nextIds = patientId(prepared.bundle)
          if (previousIds?.length !== 1 || nextIds?.length !== 1 || !previousIds[0] || previousIds[0] !== nextIds[0]) {
            throw new ProgressiveImportError('PATIENT_HIS_MISMATCH', '病人資料不符，已停止院內門診補載。')
          }
        }
        const patientProfile = options?.expectedImportId ? LocalBundleService.getUserEnteredPatientProfile() : undefined
        assertExpectedImport()
        await persistBundle(prepared.bundle, prepared.originalFhir, prepared.sourceMetadata, patientProfile,
          options?.signal, assertExpectedImport, options?.onCommitted,
          Boolean(options?.progressiveRunId && options.expectedImportId))
        reportHospitalCapture(prepared.bundle, options?.progressiveStage, options?.progressiveReason)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to parse bundle'
      setError(options?.signal?.aborted ? null : msg)
      throw err instanceof Error ? err : new Error(msg)
    } finally {
      setLoading(false)
    }
  }, [persistBundle])

  const clear = useCallback(async () => {
    await serializeLocalBundleMutation(async () => {
      const importId = LocalBundleService.getActiveImportId()
      await LocalBundleService.clear()
      // Clearing the bundle must also drop cached AI results (safety scan,
      // insights) so re-importing the same patient starts fresh, not stale.
      purgeAiResultCaches(importId)
      setHasBundle(false)
      setBundleIsActive(false)
      setError(null)
      notifyBundleChanged()
      try {
        await queryClient.invalidateQueries()
      } finally {
        notifyBundleChangeSettled()
      }
    })
  }, [queryClient])

  return { importFile, clear, loading, error, hasBundle, bundleIsActive }
}
