// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLocaleChoice, resolveLocale, writeLocaleChoice, type LocaleChoice } from './locale'

const STORAGE_KEY = 'gadgets:locale'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('resolveLocale', () => {
  const cases: [LocaleChoice, string | undefined, string][] = [
    ['system', 'ja-JP', 'ja'],
    ['system', 'en-GB', 'en'],
    ['system', undefined, 'en'],
    ['en', 'ja-JP', 'en'],
    ['ja', 'en', 'ja'],
  ]

  for (const [choice, navigatorLanguage, expected] of cases) {
    it(`resolves ${choice} under ${navigatorLanguage ?? 'no browser language'} to ${expected}`, () => {
      expect(resolveLocale(choice, navigatorLanguage)).toBe(expected)
    })
  }
})

describe('locale choice storage', () => {
  it('defaults to system and round-trips a written choice', () => {
    expect(readLocaleChoice()).toBe('system')

    writeLocaleChoice('ja')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ja')
    expect(readLocaleChoice()).toBe('ja')

    writeLocaleChoice('system')
    expect(readLocaleChoice()).toBe('system')
  })

  it('falls back to system for a value it does not recognise', () => {
    window.localStorage.setItem(STORAGE_KEY, 'fr')
    expect(readLocaleChoice()).toBe('system')
  })

  it('survives storage that throws', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })

    expect(readLocaleChoice()).toBe('system')
    expect(() => writeLocaleChoice('ja')).not.toThrow()
  })
})
