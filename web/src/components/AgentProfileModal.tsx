/** Agent profile modal — shows Eternitas passport details, trust score, operator info */
import TrustBadge from './TrustBadge';
import { env } from '../env';

interface AgentProfile {
  userId: string;
  displayName: string;
  passportId?: string;
  trustScore?: number;
  clearanceLevel?: string;
  operatorInfo?: string;
  registeredAt?: string;
}

interface AgentProfileModalProps {
  agent: AgentProfile;
  onClose: () => void;
  onMessage: () => void;
}

function TrustScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, (score / 1000) * 100);
  const color = score >= 800 ? '#34d399' : score >= 600 ? '#fbbf24' : '#fb923c';
  return (
    <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export default function AgentProfileModal({ agent, onClose, onMessage }: AgentProfileModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-md rounded-2xl p-6 shadow-2xl"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--bg-tertiary)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        >
          &times;
        </button>

        {/* Agent Avatar */}
        <div className="text-center mb-6">
          <div
            className="w-20 h-20 rounded-full mx-auto mb-3 flex items-center justify-center text-3xl"
            style={{ background: 'var(--agent-bg)', border: '2px solid var(--accent)' }}
          >
            🪰
          </div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {agent.displayName}
          </h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            AI Agent — Powered by Windy Fly
          </p>
        </div>

        {/* Eternitas Passport */}
        {agent.passportId && (
          <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Eternitas Passport
              </span>
              <TrustBadge score={agent.trustScore} passportId={agent.passportId} size="md" />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Passport ID</span>
                <span className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{agent.passportId}</span>
              </div>

              {agent.trustScore != null && (
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Trust Score</span>
                    <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{agent.trustScore}/1000</span>
                  </div>
                  <TrustScoreBar score={agent.trustScore} />
                </div>
              )}

              {agent.clearanceLevel && (
                <div className="flex justify-between">
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Clearance Level</span>
                  <span className="text-xs" style={{ color: 'var(--accent)' }}>{agent.clearanceLevel}</span>
                </div>
              )}

              {agent.operatorInfo && (
                <div className="flex justify-between">
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Operator</span>
                  <span className="text-xs" style={{ color: 'var(--text-primary)' }}>{agent.operatorInfo}</span>
                </div>
              )}

              {agent.registeredAt && (
                <div className="flex justify-between">
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Registered</span>
                  <span className="text-xs" style={{ color: 'var(--text-primary)' }}>
                    {new Date(agent.registeredAt).toLocaleDateString()}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onMessage}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            💬 Message
          </button>
          {agent.passportId && (
            <a
              href={`${env.eternitasUrl}/registry/${agent.passportId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-center"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            >
              View on Eternitas
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
