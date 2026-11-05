import type { ReactNode } from 'react'

const shapes = {
  home: <><path d="m3.5 10 8.5-7 8.5 7" /><path d="M5.5 9v11h13V9M9 20v-6h6v6" /></>,
  phone: <><path d="M7.2 3.5h3l1.4 4.1-2 1.5a15 15 0 0 0 5.4 5.4l1.5-2 4.1 1.4v3c0 1.1-.9 2-2 2A15.5 15.5 0 0 1 5.2 5.5c0-1.1.9-2 2-2Z" /></>,
  message: <><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.6 8.6 0 0 1-3.3-.6L4 20l1.5-3.6A7.3 7.3 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z" /><path d="M8.5 11.5h.1m3.3 0h.1m3.3 0h.1" /></>,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20v-1.2A5.5 5.5 0 0 1 9 13.3a5.5 5.5 0 0 1 5.5 5.5V20Z" /><path d="M16 5.3a3 3 0 0 1 0 5.8M17.5 13.7a5.4 5.4 0 0 1 3 4.9V20" /></>,
  bag: <><path d="M4 8h16l-1 12H5L4 8Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2M9 12v1m6-1v1" /></>,
  tag: <><path d="M20.5 13 13 20.5 3.5 11V3.5H11l9.5 9.5Z" /><circle cx="7.5" cy="7.5" r="1.2" /></>,
  box: <><path d="m12 3 9 4.5v9L12 21l-9-4.5v-9L12 3Z" /><path d="m3.5 7.7 8.5 4.5 8.5-4.5M12 12.2V21M7.5 5.3l9 4.7" /></>,
  truck: <><path d="M3 5h11v12H3zM14 9h4l3 3v5h-7z" /><circle cx="7.5" cy="18" r="1.8" /><circle cx="17.5" cy="18" r="1.8" /></>,
  coin: <><circle cx="12" cy="12" r="8.5" /><path d="M15.5 8.5c-.6-.7-1.6-1.1-2.8-1.1-1.6 0-2.7.8-2.7 2 0 3 5.8 1.3 5.8 4.5 0 1.3-1.2 2.2-3 2.2-1.3 0-2.4-.4-3.2-1.3M12 5.7v12.6" /></>,
  chart: <><path d="M4 19.5V12m8 7.5V5m8 14.5v-10" /><path d="M2.5 20.5h19" /></>,
  file: <><path d="M6 3.5h8l4 4V20H6z" /><path d="M14 3.5v4h4M9 12h6m-6 4h6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 1 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 1 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 1 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 1 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z" /></>,
  check: <><path d="m5 12.5 4.4 4.2L19.5 6.8" /></>,
  arrow: <><path d="M4.5 12h15m-6-6 6 6-6 6" /></>,
  menu: <><path d="M4 6.5h16M4 12h16M4 17.5h16" /></>,
  shield: <><path d="M12 3 20 6v5.5c0 4.4-3.4 7.7-8 9.5-4.6-1.8-8-5.1-8-9.5V6l8-3Z" /><path d="m8.5 12 2.2 2.2 4.8-4.8" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>,
  moon: <><path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z" /></>,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof shapes

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      {shapes[name]}
    </svg>
  )
}
