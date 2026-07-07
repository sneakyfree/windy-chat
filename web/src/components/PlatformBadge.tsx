/**
 * Small colored chip identifying which connected platform a conversation
 * comes from. Native Windy Chat rooms and agent rooms keep their current
 * look (no chip) — this renders nothing for them.
 */
import { PLATFORM_META, type Provenance } from '../lib/provenance';

export default function PlatformBadge({ platform }: { platform: Provenance | string }) {
  const meta = PLATFORM_META[platform];
  if (!meta) return null;
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-medium"
      style={{ background: meta.color, color: 'white' }}
    >
      {meta.label}
    </span>
  );
}
