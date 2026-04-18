import { useEffect, useState } from 'react';
import type { Room } from 'matrix-js-sdk';
import * as matrix from '../lib/matrix';
import { env } from '../env';
import TrustBadge from './TrustBadge';

interface RoomHeaderProps {
  room: Room;
  onBack: () => void;
}

interface AgentTrust {
  passport_number: string;
  trust_score?: number | null;
  clearance_level?: string | null;
  agent_name?: string | null;
  avatar_url?: string | null;
}

function clearanceStyle(level: string | null | undefined): { bg: string; color: string; label: string } {
  switch ((level || '').toLowerCase()) {
    case 'top_secret':
      return { bg: 'rgba(220,38,38,0.15)', color: '#dc2626', label: 'Top Secret' };
    case 'secret':
      return { bg: 'rgba(234,88,12,0.15)', color: '#ea580c', label: 'Secret' };
    case 'confidential':
      return { bg: 'rgba(217,119,6,0.15)', color: '#d97706', label: 'Confidential' };
    case 'restricted':
      return { bg: 'rgba(124,92,255,0.15)', color: 'var(--accent)', label: 'Restricted' };
    case 'public':
      return { bg: 'rgba(52,211,153,0.15)', color: '#34d399', label: 'Public' };
    default:
      return { bg: 'var(--bg-tertiary)', color: 'var(--text-muted)', label: level || 'Unclassified' };
  }
}

/**
 * Extract an Eternitas passport number from an agent Matrix ID like
 * `@agent_et-abc123:chat.windyword.ai`. Uppercased because the agent
 * directory stores passports in the canonical uppercase form.
 */
function passportFromAgentId(matrixId: string | undefined): string | null {
  if (!matrixId || !matrixId.startsWith('@agent_')) return null;
  const localpart = matrixId.slice(1).split(':')[0];
  const rest = localpart.replace(/^agent_/, '');
  return rest ? rest.toUpperCase() : null;
}

export default function RoomHeader({ room, onBack }: RoomHeaderProps) {
  const isAgent = matrix.isAgentRoom(room);
  const agentMember = isAgent
    ? room.getJoinedMembers().find(m => m.userId.startsWith('@agent_'))
    : null;
  const passport = agentMember ? passportFromAgentId(agentMember.userId) : null;

  const [trust, setTrust] = useState<AgentTrust | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!passport) {
      setTrust(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`${env.directoryUrl}/agents/${encodeURIComponent(passport)}`, {
      credentials: 'include',
    })
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (!cancelled) setTrust(data); })
      .catch(() => { if (!cancelled) setTrust(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [passport]);

  const clearance = clearanceStyle(trust?.clearance_level);

  return (
    <div
      data-testid="room-header"
      className="px-4 md:px-6 py-4 border-b flex items-center gap-3"
      style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}
    >
      <button
        onClick={onBack}
        className="md:hidden w-8 h-8 rounded-full flex items-center justify-center shrink-0"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        aria-label="Back to room list"
      >
        ←
      </button>
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center text-sm shrink-0"
        style={{
          background: isAgent ? 'var(--agent-bg)' : 'var(--bg-tertiary)',
          border: isAgent ? '1px solid var(--agent-border)' : 'none',
        }}
      >
        {isAgent ? '🪰' : room.name?.charAt(0)?.toUpperCase() || '?'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h2
            className="font-medium text-sm truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {room.name || 'Unnamed Room'}
          </h2>
          {isAgent && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              AI Agent
            </span>
          )}
          {isAgent && (passport || trust?.passport_number) && (
            <TrustBadge
              score={trust?.trust_score ?? null}
              passportId={passport || trust?.passport_number || null}
              size="sm"
            />
          )}
          {isAgent && trust?.clearance_level && (
            <span
              data-testid="clearance-pill"
              className="text-[10px] px-1.5 py-0.5 rounded font-medium"
              style={{ background: clearance.bg, color: clearance.color }}
              title={`Eternitas clearance: ${clearance.label}`}
            >
              {clearance.label}
            </span>
          )}
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
          {isAgent && passport
            ? `Passport ${passport}${loading ? ' · verifying…' : ''}`
            : `${room.getJoinedMemberCount()} members`}
        </p>
      </div>
    </div>
  );
}
