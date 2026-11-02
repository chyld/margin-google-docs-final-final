/** A stack of pages and a pencil, for empty states. Decorative. */
export function EmptyIllustration() {
  return (
    <svg className="empty-illustration" viewBox="0 0 160 120" width="160" height="120" aria-hidden="true">
      <ellipse cx="80" cy="108" rx="54" ry="7" className="ill-shadow" />
      <rect x="40" y="26" width="70" height="80" rx="8" transform="rotate(-9 75 66)" className="ill-page-3" />
      <rect x="46" y="22" width="70" height="80" rx="8" transform="rotate(5 81 62)" className="ill-page-2" />
      <rect x="44" y="18" width="70" height="84" rx="8" className="ill-page-1" />
      <path d="M56 40h40M56 52h46M56 64h34M56 76h40" className="ill-lines" />
      <g transform="rotate(38 116 52)">
        <rect x="110" y="18" width="12" height="62" rx="3" className="ill-pencil" />
        <rect x="110" y="18" width="12" height="10" rx="3" className="ill-eraser" />
        <path d="M110 80h12l-6 12z" className="ill-tip" />
      </g>
      <circle cx="30" cy="30" r="5" className="ill-dot-1" />
      <circle cx="134" cy="96" r="4" className="ill-dot-2" />
      <circle cx="128" cy="20" r="3" className="ill-dot-3" />
    </svg>
  )
}
