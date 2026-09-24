import type { SVGProps } from "react";

/* The product's one icon set: 24px grid, 1.75 stroke, drawn at 18px in controls
   and 16px beside text (size-4). Controls never use text glyphs as icons. */
type IconProps = SVGProps<SVGSVGElement>;

const defaults = { "aria-hidden": true, width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function icon(paths: string[]) {
  return function Icon(props: IconProps) {
    return <svg {...defaults} {...props}>{paths.map((d) => <path d={d} key={d}/>)}</svg>;
  };
}

export const ArrowLeftIcon = icon(["M19 12H5", "m11 6-6 6 6 6"]);
export const ChevronLeftIcon = icon(["m15 18-6-6 6-6"]);
export const ChevronRightIcon = icon(["m9 18 6-6-6-6"]);
export const ChevronDownIcon = icon(["m6 9 6 6 6-6"]);
export const CloseIcon = icon(["m6 6 12 12", "M18 6 6 18"]);
export const PlusIcon = icon(["M12 5v14", "M5 12h14"]);
export const SearchIcon = icon(["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "m16 16 4 4"]);
export const MoonIcon = icon(["M20 15.3A8.5 8.5 0 1 1 8.7 4 7 7 0 0 0 20 15.3Z"]);

export function MoreIcon(props: IconProps) {
  return <svg {...defaults} {...props}><circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/></svg>;
}

/* Content icons: what a request row or layer holds. */
export const BookIcon = icon(["M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6"]);
export const ChatIcon = icon(["M4 5h12v9H9l-5 4zM16 9h4v9l-3-2.5h-6V14"]);
export const HistoryIcon = icon(["M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5M12 8v4l2.5 2"]);
export const PinIcon = icon(["M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"]);
export const QuestionIcon = icon(["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"]);
export const SlidersIcon = icon(["M6 4v16M12 4v16M18 4v16M4 9h4M10 15h4M16 7h4"]);
export const SparkleIcon = icon(["M12 4l1.8 4.7L18.5 10.5 13.8 12.3 12 17l-1.8-4.7L5.5 10.5l4.7-1.8zM18 16l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"]);
export const TerminalIcon = icon(["M4 5h16v14H4zM8 10l2.5 2L8 14M13 14h3"]);
export const ToolIcon = icon(["M14.5 5.5a4 4 0 0 0 4.9 4.9L12 17.8 9.2 20.6a2 2 0 0 1-2.8-2.8L9.2 15 16.6 7.6a4 4 0 0 0-2.1-2.1z"]);
export const UserIcon = icon(["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0"]);
