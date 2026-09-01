import type { SVGProps } from 'react';

export type IconName =
  | 'activity'
  | 'add'
  | 'arrow-up'
  | 'branch'
  | 'check'
  | 'chevron'
  | 'close'
  | 'code'
  | 'copy'
  | 'diagnostics'
  | 'edit'
  | 'goal'
  | 'info'
  | 'menu'
  | 'more'
  | 'pause'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'sidebar'
  | 'spark'
  | 'stop'
  | 'terminal'
  | 'trash'
  | 'warning'
  | 'workspace';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  readonly name: IconName;
  readonly size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

const paths: Record<IconName, JSX.Element> = {
  activity: <path d="M3 12h4l2.2-6 4.2 12 2.2-6H21" />,
  add: <path d="M12 5v14M5 12h14" />,
  'arrow-up': <path d="m6 11 6-6 6 6M12 5v14" />,
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="7" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10M8 12h4a6 6 0 0 0 6-3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 7 5 5-5 5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  code: <path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />,
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  diagnostics: (
    <>
      <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
      <path d="M2 19h21" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </>
  ),
  goal: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="m15 9 5-5M17 4h3v3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  pause: <path d="M9 5v14M15 5v14" />,
  refresh: <path d="M20 7v5h-5M4 17v-5h5M6.1 9A7 7 0 0 1 18 6l2 6M17.9 15A7 7 0 0 1 6 18l-2-6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  spark: (
    <path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7Z" />
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  terminal: <path d="m5 7 4 4-4 4M11 16h8" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2.5 20h19Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  workspace: (
    <>
      <path d="M3 7h7l2 2h9v10H3Z" />
      <path d="M3 7V5h7l2 2" />
    </>
  ),
};
