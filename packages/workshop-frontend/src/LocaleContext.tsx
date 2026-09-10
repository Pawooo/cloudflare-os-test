import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppLocale } from '@gadgets/workshop-shared/theme'
import { readLocaleChoice, resolveLocale, writeLocaleChoice, type LocaleChoice } from './locale'

interface LocaleContextValue {
  localeChoice: LocaleChoice
  resolvedLocale: AppLocale
  setLocaleChoice: (choice: LocaleChoice) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

function getInitialLocaleState() {
  const localeChoice = readLocaleChoice()
  return { localeChoice, resolvedLocale: resolveLocale(localeChoice, navigator.language) }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [localeState, setLocaleState] = useState(getInitialLocaleState)
  const { localeChoice, resolvedLocale } = localeState

  // No effect subscribing to the system value, unlike ThemeContext: "system" resolves through
  // `navigator.language`, which fires no change event, so there is nothing to listen to. The
  // resolved language is recomputed in the setter below instead.
  const value = useMemo<LocaleContextValue>(() => ({
    localeChoice,
    resolvedLocale,
    setLocaleChoice: (choice) => {
      writeLocaleChoice(choice)
      setLocaleState({
        localeChoice: choice,
        resolvedLocale: resolveLocale(choice, navigator.language),
      })
    },
  }), [localeChoice, resolvedLocale])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() {
  const context = useContext(LocaleContext)
  if (!context) throw new Error('useLocale must be used within LocaleProvider')
  return context
}
