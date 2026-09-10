import { Link, useRouterState } from '@tanstack/react-router'
import { Desktop, Moon, Plug, Sun, Translate } from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo'
import UserMenu from '../UserMenu'
import { useTheme } from '../../ThemeContext'
import { useLocale } from '../../LocaleContext'
import { APP_LOCALES, type AppLocale } from '@gadgets/workshop-shared/theme'
import type { ThemeMode } from '../../theme'
import type { LocaleChoice } from '../../locale'

const THEME_SEQUENCE: ThemeMode[] = ['system', 'light', 'dark']

// Built from the shared list rather than retyped, so a third language reaches the button by adding
// one entry to `APP_LOCALES`. `LOCALE_NAMES` below is the compiler's check that somebody named it.
const LOCALE_SEQUENCE: LocaleChoice[] = ['system', ...APP_LOCALES]

// Each language is named in its own script, so someone who can't read the current one can still
// recognise where the next click lands. The shell's own text stays English.
const LOCALE_NAMES: Record<LocaleChoice, string> = {
  system: 'system',
  en: 'English',
  ja: '日本語',
}

// The glyph the button wears once a language is chosen. The theme button changes icon per state and
// its click visibly repaints the shell; a language click changes nothing the shell renders, so the
// current value has to be legible on the control itself. No icon says "English" or "Japanese", so
// an explicit choice shows the language's own short mark instead of the generic Translate icon.
const LOCALE_MARKS: Record<AppLocale, string> = {
  en: 'EN',
  ja: '日本',
}

function nextLocaleChoice(choice: LocaleChoice): LocaleChoice {
  return LOCALE_SEQUENCE[(LOCALE_SEQUENCE.indexOf(choice) + 1) % LOCALE_SEQUENCE.length]
}

function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_SEQUENCE[(THEME_SEQUENCE.indexOf(mode) + 1) % THEME_SEQUENCE.length]
}

function LocaleButton() {
  const { localeChoice, resolvedLocale, setLocaleChoice } = useLocale()
  const label = localeChoice === 'system'
    ? `Language: system (${LOCALE_NAMES[resolvedLocale]})`
    : `Language: ${LOCALE_NAMES[localeChoice]}`
  const nextChoice = nextLocaleChoice(localeChoice)

  return (
    <Tooltip
      content={`${label}. Switch to ${LOCALE_NAMES[nextChoice]}.`}
      render={(
        <button
          type="button"
          aria-label={`${label}. Switch to ${LOCALE_NAMES[nextChoice]}.`}
          onClick={() => setLocaleChoice(nextChoice)}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated"
        >
          {localeChoice === 'system' ? (
            <Translate size={15} />
          ) : (
            <span className="text-[11px] font-semibold leading-none">
              {LOCALE_MARKS[localeChoice]}
            </span>
          )}
        </button>
      )}
    />
  )
}

function ThemeModeButton() {
  const { themeMode, resolvedThemeMode, setThemeMode } = useTheme()
  const label = themeMode === 'system'
    ? `Theme: system (${resolvedThemeMode})`
    : `Theme: ${themeMode}`
  const nextMode = nextThemeMode(themeMode)

  return (
    <Tooltip
      content={`${label}. Switch to ${nextMode}.`}
      render={(
        <button
          type="button"
          aria-label={`${label}. Switch to ${nextMode}.`}
          onClick={() => setThemeMode(nextMode)}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated"
        >
          {themeMode === 'system' ? (
            <Desktop size={15} />
          ) : themeMode === 'dark' ? (
            <Moon size={15} />
          ) : (
            <Sun size={15} />
          )}
        </button>
      )}
    />
  )
}

// Bottom strip on the sidebar: tiny iconography for connections, language, theme, and the user
// menu. Mirrors the very low-chrome bottom row in the reference design and surfaces Profile /
// Providers / Admin from the user-menu dropdown rather than duplicating them as separate icons.
function StripLink({
  to,
  label,
  children,
}: {
  to: '/gatekeepers'
  label: string
  children: React.ReactNode
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = pathname === to
  return (
    <Tooltip content={label}>
      <Link
        to={to}
        aria-label={label}
        className={[
          'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-kumo-fill text-kumo-brand'
            : 'text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default',
        ].join(' ')}
      >
        {children}
      </Link>
    </Tooltip>
  )
}

export default function SidebarUtilityStrip({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div
      className={[
        // shrink-0 + solid base so the strip is visually pinned above the scrolling rail body
        // and content can't bleed through it. Flat treatment — no top shadow.
        'shrink-0 flex items-center gap-1 border-t border-kumo-line bg-kumo-elevated px-3 py-2',
        collapsed ? 'flex-col justify-center gap-2 px-1.5' : '',
      ].join(' ')}
    >
      <StripLink to="/gatekeepers" label="Gatekeepers">
        <Plug size={15} />
      </StripLink>
      <div className={collapsed ? 'flex flex-col items-center gap-2' : 'ml-auto flex items-center gap-1'}>
        <LocaleButton />
        <ThemeModeButton />
        <UserMenu />
      </div>
    </div>
  )
}
