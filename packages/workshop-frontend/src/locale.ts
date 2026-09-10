// The shell's language choice.
//
// Mirrors `theme.ts`: a stored choice of "system" or one concrete value, resolved to a concrete
// value for display. "system" resolves from the browser's `navigator.language` rather than a media
// query, so there is nothing to subscribe to and nothing to apply to the document — the shell's own
// text is English either way. The resolved value only names the language in the picker; what the
// choice is *for* is the sandboxed apps, which receive it with the theme.

import { APP_LOCALES, type AppLocale } from '@gadgets/workshop-shared/theme'

export type LocaleChoice = 'system' | AppLocale

const LOCALE_STORAGE_KEY = 'gadgets:locale'

const DEFAULT_LOCALE: AppLocale = 'en'

function isLocaleChoice(value: string | null): value is LocaleChoice {
  return value === 'system' || (APP_LOCALES as readonly (string | null)[]).includes(value)
}

export function readLocaleChoice(): LocaleChoice {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return isLocaleChoice(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function writeLocaleChoice(choice: LocaleChoice): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, choice)
  } catch {
    // Ignore storage failures; the selected language still applies for this session.
  }
}

export function resolveLocale(
  choice: LocaleChoice,
  navigatorLanguage: string | undefined,
): AppLocale {
  if (choice !== 'system') return choice
  return navigatorLanguage?.toLowerCase().startsWith('ja') ? 'ja' : DEFAULT_LOCALE
}
