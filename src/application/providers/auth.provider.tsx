// Authentication provider backed by the self-hosted session API
'use client'

import { createContext, useContext, useRef, useState, useEffect, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { db, doc, getDoc, setDoc, onSnapshot, type DocumentSnapshot, type QuerySnapshot } from '@/src/infrastructure/firebase/firestore-client'
import { useConnectivityStore } from '@/src/application/stores/connectivity.store'
import { QUOTA_CONFIG } from '@/src/shared/config/quota.config'
import { useAiConfigStore } from '@/src/application/stores/ai-config.store'
import { clearSessionKey } from '@/src/shared/utils/crypto.utils'
import { LocalBundleService } from '@/src/infrastructure/fhir/services/local-bundle.service'
import { clearSmartSession } from '@/src/infrastructure/fhir/client/fhir-client.service'
import { purgeAiResultCaches } from '@/src/infrastructure/cache/encrypted-session-cache'
import { notifyBundleChanged } from '@/src/shared/utils/reset-on-bundle-change'
import { serializeLocalBundleMutation } from '@/src/infrastructure/fhir/services/local-bundle-mutation-queue'

import { setUserProps, trackEvent } from '@/src/application/telemetry/usage-analytics'
import {
  detectLaunchSource,
  detectSite,
  detectWorkstation,
} from '@/src/application/telemetry/launch-context'
import { useAppVersion } from '@/src/shared/hooks/use-app-version.hook'
import { syncBetaFeaturesForAccount } from '@/src/application/services/beta-features-sync'
import { syncOutpatientPrefsForAccount } from '@/src/application/services/outpatient-prefs-sync'
export interface User {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
  emailVerified: boolean
}

export interface AuthContextType {
  user: User | null
  /** Compatibility state for consumers; self-hosted sign-in has no guest sessions. */
  isAnonymous: boolean
  anonymousUid: null
  loading: boolean
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  dailyUsage: number
  /** Daily chat limit for the active tier (smaller for anonymous visitors) */
  dailyLimit: number
  /** Per-service usage read from the same daily doc the Functions meter */
  perplexityUsage: number
  whisperUsage: number
  /** Per-service limits for the active tier (smaller for anonymous visitors) */
  perplexityLimit: number
  whisperLimit: number
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// Helper: Get today's date string (YYYY-MM-DD)
const getTodayString = () => new Date().toISOString().split('T')[0]

// Usage analytics: one `app_launch` per page load after an account is available.
let launchReported = false

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<User | null>(null)
  const [activeUid, setActiveUid] = useState<string | null>(null)
  const isAnonymous = false
  // Keep the same pending state on the server and first client render so auth-dependent text can hydrate.
  const [loading, setLoading] = useState(true)
  const [dailyUsage, setDailyUsage] = useState(0)
  const [perplexityUsage, setPerplexityUsage] = useState(0)
  const [whisperUsage, setWhisperUsage] = useState(0)

  const dailyLimit = QUOTA_CONFIG.DAILY_LIMIT
  // Usage analytics are keyed by the account id locally; the id is never sent.
  const reportedUidRef = useRef<string | null>(null)
  const appVersion = useAppVersion()
  const perplexityLimit = QUOTA_CONFIG.PERPLEXITY_DAILY_LIMIT
  const whisperLimit = QUOTA_CONFIG.WHISPER_DAILY_LIMIT

  useEffect(() => {
    let active = true
    const hydrateSession = async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error('Session lookup failed')
        const payload = await response.json() as { user: User | null }
        if (!active) return
        const nextUser = payload.user ?? null
        setUser(nextUser)
        setActiveUid(nextUser?.uid ?? null)
        if (nextUser && reportedUidRef.current !== nextUser.uid) {
          reportedUidRef.current = nextUser.uid
          void detectLaunchSource().then((launchSource) => {
            const site = detectSite()
            const workstation = detectWorkstation()
            if (!launchReported) {
              launchReported = true
              trackEvent('app_launch', { launch_source: launchSource, site, workstation })
            }
            setUserProps({ auth_kind: 'google', launch_source: launchSource, site, workstation })
          })
        }
        if (nextUser) {
          try {
            const userRef = doc(db, 'users', nextUser.uid)
            const userDoc = await getDoc(userRef)
            if (!userDoc.exists()) {
              await setDoc(userRef, {
                email: nextUser.email,
                displayName: nextUser.displayName,
                photoURL: nextUser.photoURL,
                createdAt: new Date().toISOString(),
              }, { merge: true })
            }
          } catch {
            // Profile creation can be retried by the next authenticated session.
          }
        }
      } catch {
        if (active) {
          setUser(null)
          setActiveUid(null)
          setDailyUsage(0)
          setPerplexityUsage(0)
          setWhisperUsage(0)
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void hydrateSession()
    return () => { active = false }
  }, [])

  // Keep preference sync independent of how many surfaces read the Beta hook.
  const signedInUid = user?.uid
  useEffect(() => {
    if (!signedInUid) return
    return syncBetaFeaturesForAccount(signedInUid)
  }, [signedInUid])

  // 門診偏好 (自訂 labs, copy formats) follow the account the same way.
  // Anonymous and guest settings are never synced: they stay in this browser.
  useEffect(() => {
    if (!signedInUid) return
    return syncOutpatientPrefsForAccount(signedInUid)
  }, [signedInUid])

  // Reported separately from the sign-in properties: the version is fetched
  // from /version.json at runtime (same source as the version chip) and can
  // resolve before or after the auth listener fires.
  useEffect(() => {
    if (appVersion) setUserProps({ app_version: appVersion })
  }, [appVersion])

  // Usage listener uses the app's document API and only runs for signed-in accounts.
  useEffect(() => {
    if (!activeUid || !db) return

    const today = getTodayString()
    const usageRef = doc(db, 'users', activeUid, 'usage', today)

    const unsubscribe = onSnapshot(
      usageRef,
      { includeMetadataChanges: true },
      (snapshot: DocumentSnapshot | QuerySnapshot | Error) => {
        if (snapshot instanceof Error) {
          useConnectivityStore.getState().setFirestoreConnection('unavailable')
          return
        }
        if (!('exists' in snapshot)) return
        useConnectivityStore.getState().setFirestoreConnection(
          snapshot.metadata.fromCache ? 'cache' : 'server',
        )
        const data = snapshot.exists() ? snapshot.data() : undefined
        setDailyUsage(data?.count || 0)
        setPerplexityUsage(data?.perplexityCount || 0)
        setWhisperUsage(data?.whisperCount || 0)
      },
      () => {
        useConnectivityStore.getState().setFirestoreConnection('unavailable')
      }
    )

    return () => unsubscribe()
  }, [activeUid])

  const signInWithGoogle = async () => {
    setLoading(true)
    window.location.assign(new URL('/api/auth/google', window.location.origin).toString())
  }

  const signOut = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('Unable to sign out')
      setUser(null)
      setActiveUid(null)
      setDailyUsage(0)
      setPerplexityUsage(0)
      setWhisperUsage(0)
      reportedUidRef.current = null

      useAiConfigStore.getState().clearAllKeys()
      clearSessionKey()
      clearSmartSession()

      await serializeLocalBundleMutation(async () => {
        const importId = LocalBundleService.getActiveImportId()
        await LocalBundleService.clear()
        purgeAiResultCaches(importId)
        notifyBundleChanged()
        await queryClient.invalidateQueries()
      })
    } finally {
      setLoading(false)
    }
  }

  const value: AuthContextType = {
    user,
    isAnonymous,
    anonymousUid: null,
    loading,
    signInWithGoogle,
    signOut,
    dailyUsage,
    dailyLimit,
    perplexityUsage,
    whisperUsage,
    perplexityLimit,
    whisperLimit,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
