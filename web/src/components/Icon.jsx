import React from 'react';

// Minimal inline icon set. No icon library is installed and the console is
// offline-first (no CDN fonts/assets), so a tiny hand-curated set is the
// pragmatic choice. All glyphs share a 24px box and 1.75 stroke for a
// consistent weight across the UI.

const P = {
  bridge: ['M3 16h18', 'M3 16c3-7 15-7 18 0', 'M7 16v4', 'M12 13v7', 'M17 16v4'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.3-4.3'],
  personLost: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M5 20a7 7 0 0 1 14 0', 'M19 4l2 2m0-2-2 2'],
  personFound: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4 20a7 7 0 0 1 12.5-4.3', 'm16 19 2 2 4-4'],
  map: ['M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z', 'M9 4v14', 'M15 6v14'],
  mic: ['M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v4'],
  back: ['m15 5-7 7 7 7'],
  arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'],
  spark: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'm6 6 2.5 2.5', 'm15.5 15.5 2.5 2.5', 'm18 6-2.5 2.5', 'm8.5 15.5-2.5 2.5'],
  inbox: ['M3 12h5l2 3h4l2-3h5', 'M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2-7Z'],
};

export default function Icon({ name, size = 24, className }) {
  const paths = P[name];
  if (!paths) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
