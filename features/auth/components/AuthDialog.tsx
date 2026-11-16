// Authentication Dialog Component - Refactored
'use client'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLanguage } from '@/src/application/providers/language.provider'
import { useAuthDialog } from '../hooks/useAuthDialog'
import { GoogleSignInButton } from './GoogleSignInButton'

interface AuthDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AuthDialog({ open, onOpenChange }: AuthDialogProps) {
  const { t } = useLanguage()
  const { error, loading, resetState, handleGoogleSignIn } = useAuthDialog(() => onOpenChange(false))

  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen)
    if (!newOpen) resetState()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.auth.signInTitle}</DialogTitle>
          <DialogDescription>{t.auth.freeQuotaDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <GoogleSignInButton
            onClick={handleGoogleSignIn}
            loading={loading}
            label={t.auth.signInWithGoogle}
          />
          <p className="text-xs text-center text-muted-foreground">{t.auth.termsNotice}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
