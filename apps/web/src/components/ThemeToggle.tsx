import { useTheme } from '../theme/ThemeProvider'
import { Icon } from './Icon'

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggleTheme } = useTheme()
  const nextTheme = theme === 'light' ? 'dark' : 'light'

  return (
    <button
      aria-label={`Ativar tema ${nextTheme === 'dark' ? 'escuro' : 'claro'}`}
      className={`theme-toggle${className ? ` ${className}` : ''}`}
      onClick={toggleTheme}
      type="button"
    >
      <Icon name={theme === 'light' ? 'moon' : 'sun'} />
    </button>
  )
}
