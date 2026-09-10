// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children?: React.ReactNode }) => <a {...props}>{children}</a>,
  useRouterState: () => '/',
}))

vi.mock('../UserMenu', () => ({ default: () => null }))

import { ThemeProvider } from '../../ThemeContext'
import { LocaleProvider } from '../../LocaleContext'
import SidebarUtilityStrip from './SidebarUtilityStrip'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function setNavigatorLanguage(value: string) {
  Object.defineProperty(window.navigator, 'language', { configurable: true, value })
}

describe('SidebarUtilityStrip language button', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  function render() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(
      <ThemeProvider>
        <LocaleProvider>
          <SidebarUtilityStrip />
        </LocaleProvider>
      </ThemeProvider>,
    ))
  }

  function localeButton(): HTMLButtonElement {
    const button = container?.querySelector<HTMLButtonElement>('button[aria-label^="Language:"]')
    if (!button) throw new Error('Missing language button')
    return button
  }

  beforeEach(() => {
    window.localStorage.clear()
    setNavigatorLanguage('en-US')
    window.matchMedia ??= (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.localStorage.clear()
  })

  it('cycles system to English to 日本語, naming each language in its own script', () => {
    render()

    const button = localeButton()
    expect(button.type).toBe('button')
    expect(button.getAttribute('aria-label'))
      .toBe('Language: system (English). Switch to English.')

    act(() => button.click())
    expect(localeButton().getAttribute('aria-label'))
      .toBe('Language: English. Switch to 日本語.')
    expect(window.localStorage.getItem('gadgets:locale')).toBe('en')

    act(() => localeButton().click())
    expect(localeButton().getAttribute('aria-label'))
      .toBe('Language: 日本語. Switch to system.')
    expect(window.localStorage.getItem('gadgets:locale')).toBe('ja')

    act(() => localeButton().click())
    expect(localeButton().getAttribute('aria-label'))
      .toBe('Language: system (English). Switch to English.')
    expect(window.localStorage.getItem('gadgets:locale')).toBe('system')
  })

  // The theme button beside it changes glyph per state, and its click repaints the whole shell. A
  // language click changes nothing the shell renders, so the button has to carry the value itself.
  it('wears the generic icon on system and the language\'s own mark once one is chosen', () => {
    render()

    expect(localeButton().querySelector('svg')).not.toBeNull()
    expect(localeButton().textContent).toBe('')

    act(() => localeButton().click())
    expect(localeButton().textContent).toBe('EN')
    expect(localeButton().querySelector('svg')).toBeNull()

    act(() => localeButton().click())
    expect(localeButton().textContent).toBe('日本')
    expect(localeButton().querySelector('svg')).toBeNull()

    act(() => localeButton().click())
    expect(localeButton().querySelector('svg')).not.toBeNull()
    expect(localeButton().textContent).toBe('')
  })

  it('names the resolved language on system from the browser', () => {
    setNavigatorLanguage('ja-JP')
    render()

    expect(localeButton().getAttribute('aria-label'))
      .toBe('Language: system (日本語). Switch to English.')
  })

  it('sits immediately before the theme button', () => {
    render()

    const labels = [...container!.querySelectorAll('button[aria-label]')]
      .map(button => button.getAttribute('aria-label') ?? '')
    const language = labels.findIndex(label => label.startsWith('Language:'))
    const theme = labels.findIndex(label => label.startsWith('Theme:'))
    expect(language).toBeGreaterThanOrEqual(0)
    expect(theme).toBe(language + 1)
  })
})
