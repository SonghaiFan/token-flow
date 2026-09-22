import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const defaults = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function ClockIcon(props: IconProps) {
  return <svg {...defaults} {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>;
}

export function ArrowLeftIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="m15 18-6-6 6-6"/></svg>;
}

export function MoonIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M20 15.3A8.5 8.5 0 1 1 8.7 4 7 7 0 0 0 20 15.3Z"/></svg>;
}

export function DownloadIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14"/></svg>;
}

export function RefreshIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.5-2L20 11M4 13l2.4 4a7 7 0 0 0 11.5-2"/></svg>;
}

export function SearchIcon(props: IconProps) {
  return <svg {...defaults} {...props}><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>;
}

export function ChevronRightIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="m9 18 6-6-6-6"/></svg>;
}
