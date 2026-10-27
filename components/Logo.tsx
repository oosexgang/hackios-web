// The emblem and the wordmark: HAKI in paper, OS in red (the same as the UEFI's boot logo and the press kit).
export function Emblem({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="23" r="13" fill="#e8170f" />
      <rect x="13.5" y="19" width="5" height="7" rx="2.5" fill="#0a0909" />
      <rect x="21.5" y="19" width="5" height="7" rx="2.5" fill="#0a0909" />
      <path d="M10.5 13.5 7 4.5l8 6.2M29.5 13.5 33 4.5l-8 6.2" fill="#e8170f" />
      <circle cx="7" cy="4.5" r="2.4" fill="#e8170f" />
      <circle cx="33" cy="4.5" r="2.4" fill="#e8170f" />
    </svg>
  );
}

export function Wordmark() {
  return <span className="wordmark">HAKI<em>OS</em></span>;
}
