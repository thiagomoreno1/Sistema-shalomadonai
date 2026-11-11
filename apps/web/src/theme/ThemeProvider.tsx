import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark'
export type AccentColor = 'lime' | 'blue' | 'violet' | 'teal' | 'green' | 'rose' | 'amber'

export const ACCENT_COLORS: { id: AccentColor; label: string; light: string; dark: string }[] = [
  { id: 'lime', label: 'Verde-lima Arvelo', light: '#405B00', dark: '#A8E000' },
  { id: 'blue', label: 'Azul', light: '#0A84FF', dark: '#64A9FF' },
  { id: 'violet', label: 'Violeta', light: '#7047C8', dark: '#B49AFF' },
  { id: 'teal', label: 'Turquesa', light: '#087E8B', dark: '#62D5DD' },
  { id: 'green', label: 'Verde', light: '#287A4B', dark: '#71D39A' },
  { id: 'rose', label: 'Rosa', light: '#B43D69', dark: '#FF8FB4' },
  { id: 'amber', label: 'Dourado', light: '#966300', dark: '#F0C36A' },
]

const STORAGE_KEY = 'arvelo-theme'
const ACCENT_STORAGE_KEY = 'arvelo-accent'
const LEGACY_THEME_STORAGE_KEY = 'shalom-adonai-theme'
const LEGACY_ACCENT_STORAGE_KEY = 'shalom-adonai-accent'
const THEME_COLORS: Record<Theme, string> = { light: '#F5F7F0', dark: '#101312' }

function readStoredAccent(): AccentColor {
  try {
    const saved = window.localStorage.getItem(ACCENT_STORAGE_KEY)
    if (ACCENT_COLORS.some((color) => color.id === saved)) return saved as AccentColor
    const legacySaved = window.localStorage.getItem(LEGACY_ACCENT_STORAGE_KEY)
    return ACCENT_COLORS.some((color) => color.id === legacySaved) && legacySaved !== 'blue'
      ? legacySaved as AccentColor
      : 'lime'
  } catch {
    return 'lime'
  }
}

function readStoredTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
    return saved === 'dark' || saved === 'light' ? saved : 'light'
  } catch {
    return 'light'
  }
}

function applyTheme(theme: Theme, accent: AccentColor) {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme])
  const color = ACCENT_COLORS.find((item) => item.id === accent) ?? ACCENT_COLORS[0]
  const value = theme === 'dark' ? color.dark : color.light
  const root = document.documentElement.style
  root.setProperty('--accent', value)
  root.setProperty('--accent-hover', theme === 'dark' ? `color-mix(in srgb, ${value} 78%, white)` : `color-mix(in srgb, ${value} 82%, black)`)
  root.setProperty('--accent-soft', `color-mix(in srgb, ${value} ${theme === 'dark' ? '22%' : '12%'}, ${theme === 'dark' ? '#1A1D1B' : 'white'})`)
  root.setProperty('--accent-wash', `color-mix(in srgb, ${value} ${theme === 'dark' ? '16%' : '7%'}, ${theme === 'dark' ? '#101312' : '#F5F7F0'})`)
  const arveloAccent = accent === 'lime'
  root.setProperty('--action', arveloAccent ? '#A8E000' : theme === 'dark' ? `color-mix(in srgb, ${value} 48%, #141915)` : value)
  root.setProperty('--action-hover', arveloAccent ? '#97C900' : theme === 'dark' ? `color-mix(in srgb, ${value} 62%, #141915)` : `color-mix(in srgb, ${value} 82%, black)`)
  root.setProperty('--action-ink', arveloAccent ? '#101312' : '#FFFFFF')
  root.setProperty('--focus', value)
}

type ThemeContextValue = { theme: Theme; toggleTheme: () => void; accent: AccentColor; setAccent: (accent: AccentColor) => void }
const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)
  const [accent, setAccent] = useState<AccentColor>(readStoredAccent)

  useEffect(() => {
    applyTheme(theme, accent)
    try {
      window.localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // The active theme still works when storage is unavailable.
    }
  }, [theme, accent])

  useEffect(() => {
    try {
      window.localStorage.setItem(ACCENT_STORAGE_KEY, accent)
    } catch {
      // The active accent still works when storage is unavailable.
    }
  }, [accent])

  const toggleTheme = useCallback(() => {
    setTheme((current) => current === 'light' ? 'dark' : 'light')
  }, [])

  const value = useMemo(() => ({ theme, toggleTheme, accent, setAccent }), [theme, toggleTheme, accent])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
