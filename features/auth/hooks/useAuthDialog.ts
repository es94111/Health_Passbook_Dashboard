// Google-only self-hosted authentication dialog state.
import { useState } from 'react'
import { useLanguage } from '@/src/application/providers/language.provider'
import { useAuth } from '@/src/application/providers/auth.provider'

export type AuthMode = 'signin' | 'signup' | 'reset'
export interface AuthError { title: string; message: string }

export function useAuthDialog(onClose: () => void) {
  const { t } = useLanguage()
  const { signInWithGoogle, loading } = useAuth()
  const [error, setError] = useState<string | null>(null)

  const resetState = () => setError(null)

  const handleGoogleSignIn = async () => {
    try {
      setError(null)
      await signInWithGoogle()
      onClose()
    } catch {
      setError(t.auth.signInError)
    }
  }

  return { error, loading, resetState, handleGoogleSignIn }
}
