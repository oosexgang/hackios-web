// The mark (a lowercase h and a red dot, the core) and the wordmark (hakios and the same dot). The mark's square follows the
// theme: dark on a light page, light on a dark one; the dot is always red.
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" className="mark-bg" />
      <path d="M22 14v36M22 33c0-6 4.5-9.5 9.5-9.5S41 27 41 33v17" fill="none" className="mark-h" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="45.5" cy="16.5" r="4.5" fill="#e8170f" />
    </svg>
  );
}

export function Wordmark() {
  return <span className="wordmark">hakios<span className="dot" aria-hidden="true" /></span>;
}
