// Small local stroke icons; no icon font, image requests or runtime dependency.
const paths = {
  book: 'M12 5v15M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Z',
  library: 'M4 4v16M8 4v16M12 4v16M16 4l4 16M3 20h18',
  panel: 'M9 4v16M4 4h16v16H4ZM14 9l-3 3 3 3',
  file: 'M14 3H5v18h14V8ZM14 3v5h5M8 12h8M8 16h6',
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  refresh: 'M20 8V3l-3 3M4 16v5l3-3M20 8a8 8 0 0 0-14-3M4 16a8 8 0 0 0 14 3',
  download: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  user: 'M20 21v-2a7 7 0 0 0-14 0v2M17 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
};
export function icon(React, name) {
  return React.createElement(
    'svg',
    {
      className: 'novel-ui-icon',
      viewBox: '0 0 24 24',
      width: 18,
      height: 18,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.65,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    },
    React.createElement('path', { d: paths[name] ?? paths.book }),
  );
}
