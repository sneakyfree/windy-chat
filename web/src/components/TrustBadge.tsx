/** Eternitas trust score badge with color-coded levels */

interface TrustBadgeProps {
  score?: number | null;
  passportId?: string | null;
  size?: 'sm' | 'md';
  showTooltip?: boolean;
}

function getTrustLevel(score: number): { color: string; bg: string; label: string } {
  if (score >= 800) return { color: '#34d399', bg: 'rgba(52,211,153,0.15)', label: 'High Trust' };
  if (score >= 600) return { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)', label: 'Medium Trust' };
  return { color: '#fb923c', bg: 'rgba(251,146,60,0.15)', label: 'Low Trust' };
}

export default function TrustBadge({ score, passportId, size = 'sm', showTooltip = true }: TrustBadgeProps) {
  if (!score && !passportId) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
      >
        unverified
      </span>
    );
  }

  const trust = score ? getTrustLevel(score) : { color: 'var(--accent)', bg: 'rgba(124,92,255,0.15)', label: 'Verified' };
  const fontSize = size === 'md' ? 'text-xs' : 'text-[10px]';

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${fontSize} font-medium cursor-default`}
      style={{ background: trust.bg, color: trust.color }}
      title={showTooltip ? `Verified by Eternitas${score ? ` | Trust Score: ${score}` : ''}${passportId ? ` | Passport: ${passportId}` : ''}` : undefined}
    >
      ✓ {score || 'Verified'}
    </span>
  );
}
