import type { SVGProps } from 'react';

const paths: Record<string, React.ReactNode> = {
  project: <><path d="M3 6.5h6l1.6 2H21v10H3z"/><path d="M3 6.5V5h6l1.4 1.5"/></>,
  save: <><path d="M5 3h12l2 2v16H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></>,
  undo: <><path d="M9 7 4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6"/></>,
  redo: <><path d="m15 7 5 5-5 5"/><path d="M20 12h-9a6 6 0 0 0-6 6"/></>,
  play: <path d="m8 5 11 7-11 7z"/>,
  pause: <><path d="M8 5v14M16 5v14"/></>,
  step: <><path d="m7 5 9 7-9 7zM19 5v14"/></>,
  build: <><path d="m14 4 6 6-10 10H4v-6z"/><path d="m12 6 6 6M5 15l4 4"/></>,
  publish: <><path d="M12 16V3m0 0L7 8m5-5 5 5"/><path d="M5 14v7h14v-7"/></>,
  spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 3 .5 2L22 6l-2.5.5L19 9l-.5-2.5L16 6l2.5-1z"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>,
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12"/><circle cx="12" cy="12" r="2.5"/></>,
  eyeOff: <><path d="m3 3 18 18M10.5 6.2A11 11 0 0 1 12 6c6.5 0 10 6 10 6a16 16 0 0 1-2.1 2.8M6.2 6.2C3.5 8 2 12 2 12s3.5 6 10 6a10 10 0 0 0 4-.8"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  unlock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M16 10V7a4 4 0 0 0-7.6-1.7"/></>,
  cube: <><path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/></>,
  light: <><circle cx="12" cy="10" r="5"/><path d="M9 17h6M10 21h4M12 1v2M4 3l2 2M20 3l-2 2M1 10h2M21 10h2"/></>,
  camera: <><path d="M4 7h4l2-2h4l2 2h4v12H4z"/><circle cx="12" cy="13" r="4"/></>,
  blueprint: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6.5 7.5l4.5 8.7M17.5 7.5 13 16.2"/></>,
  code: <><path d="m9 5-6 7 6 7M15 5l6 7-6 7M13 3l-2 18"/></>,
  console: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
  test: <><path d="M9 3h6M10 3v5l-5 9a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 17l-5-9V3"/><path d="M7 16h10"/></>,
  content: <><path d="M4 4h16v16H4zM4 9h16M9 9v11"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
  add: <><path d="M12 5v14M5 12h14"/></>,
  close: <><path d="M6 6l12 12M18 6 6 18"/></>,
  dots: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  command: <><path d="M9 6V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/></>,
  translate: <><path d="M12 2v20M2 12h20M12 2l-3 3m3-3 3 3M22 12l-3-3m3 3-3 3"/></>,
  rotate: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/></>,
  scale: <><path d="M5 19 19 5M12 5h7v7M12 19H5v-7"/></>,
};

export function Icon({ name, size = 16, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
