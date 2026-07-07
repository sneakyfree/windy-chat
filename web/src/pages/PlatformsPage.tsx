/**
 * Connected Platforms — settings surface for linking outside chat apps
 * (Telegram today; Slack/WhatsApp/Discord as they come online) into
 * Windy Chat. Lists each available platform with its connection state
 * and opens the link wizard.
 */
import { useCallback, useEffect, useState } from 'react';
import * as hub from '../lib/hub';
import { PLATFORM_META } from '../lib/provenance';
import ConnectPlatformWizard from '../components/ConnectPlatformWizard';

interface PlatformsPageProps {
  onBack?: () => void;
}

function StatePill({ conn }: { conn: hub.HubConnection }) {
  if (hub.connectionNeedsRelink(conn)) {
    return (
      <span
        className="text-xs px-2 py-1 rounded"
        style={{ background: 'rgba(248,113,113,0.15)', color: 'var(--danger)' }}
      >
        Needs re-linking
      </span>
    );
  }
  const state = hub.connectionStateEvent(conn);
  if (state === 'CONNECTING' || state === 'TRANSIENT_DISCONNECT') {
    return (
      <span
        className="text-xs px-2 py-1 rounded"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
      >
        Reconnecting…
      </span>
    );
  }
  return (
    <span
      className="text-xs px-2 py-1 rounded"
      style={{ background: 'rgba(52,211,153,0.15)', color: 'var(--success)' }}
    >
      ✓ Connected
    </span>
  );
}

export default function PlatformsPage({ onBack }: PlatformsPageProps) {
  const [platforms, setPlatforms] = useState<hub.HubPlatform[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [noChatAccount, setNoChatAccount] = useState(false);
  const [wizardPlatform, setWizardPlatform] = useState<hub.HubPlatform | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await hub.getPlatforms();
      setPlatforms(list);
      setError('');
      setNoChatAccount(false);
    } catch (err) {
      if (hub.isNoChatAccount(err)) {
        setNoChatAccount(true);
      } else {
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Couldn't load your connected platforms. Please try again.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 h-full overflow-y-auto">
      <div className="flex items-center gap-3 mb-2">
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back to Settings"
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            ←
          </button>
        )}
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Connected Platforms
        </h1>
      </div>
      <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
        Link your other chat apps and see all your conversations here in Windy Chat.
      </p>

      {loading && (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          Loading…
        </p>
      )}

      {!loading && noChatAccount && (
        <div
          className="rounded-xl px-5 py-6 text-center"
          style={{ background: 'var(--bg-secondary)' }}
        >
          <div className="text-3xl mb-3">💬</div>
          <p className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
            Your Windy Chat account isn't finished setting up yet.
          </p>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Send a message in Windy Chat first, then come back here to link your other apps.
          </p>
        </div>
      )}

      {!loading && !noChatAccount && error && (
        <div
          className="rounded-xl px-4 py-3 text-sm mb-6 flex items-center justify-between gap-3"
          style={{ background: 'rgba(248,113,113,0.1)', color: 'var(--danger)' }}
        >
          <span>{error}</span>
          <button
            onClick={() => {
              setLoading(true);
              refresh();
            }}
            className="text-xs px-3 py-1.5 rounded-lg font-medium shrink-0"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !noChatAccount && !error && platforms.length === 0 && (
        <div
          className="rounded-xl px-5 py-6 text-center"
          style={{ background: 'var(--bg-secondary)' }}
        >
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            No platforms are available to link yet — check back soon.
          </p>
        </div>
      )}

      {!loading &&
        platforms.map((platform) => {
          const meta = PLATFORM_META[platform.key];
          const color = meta?.color || 'var(--accent)';
          const name = platform.displayName || meta?.label || platform.key;
          const connections = platform.connections || [];
          const needsRelink = connections.some(hub.connectionNeedsRelink);
          return (
            <div
              key={platform.key}
              className="rounded-xl mb-4 overflow-hidden"
              style={{ background: 'var(--bg-secondary)' }}
            >
              <div className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
                    style={{ background: color }}
                  >
                    {name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <span
                      className="text-sm font-medium block truncate"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {name}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {connections.length === 0
                        ? 'Not linked'
                        : needsRelink
                          ? 'Signed out — link again to keep receiving messages'
                          : `${connections.length} account${connections.length > 1 ? 's' : ''} linked`}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setWizardPlatform(platform)}
                  className="text-xs px-3 py-1.5 rounded-lg font-medium transition-opacity hover:opacity-90 shrink-0"
                  style={{
                    background: connections.length === 0 || needsRelink ? 'var(--accent)' : 'var(--bg-tertiary)',
                    color: connections.length === 0 || needsRelink ? 'white' : 'var(--text-primary)',
                  }}
                >
                  {connections.length === 0 ? `Link ${name}` : needsRelink ? 'Re-link' : 'Add account'}
                </button>
              </div>

              {/* Per-account rows */}
              {connections.map((conn) => (
                <div
                  key={conn.login_id}
                  className="flex items-center justify-between px-4 py-3 border-t"
                  style={{ borderColor: 'var(--bg-tertiary)' }}
                >
                  <span className="text-sm truncate" style={{ color: 'var(--text-secondary)' }}>
                    {conn.remote_name || conn.remote_id || 'Linked account'}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatePill conn={conn} />
                    {hub.connectionNeedsRelink(conn) && (
                      <button
                        onClick={() => setWizardPlatform(platform)}
                        className="text-xs px-3 py-1.5 rounded-lg font-medium"
                        style={{ background: 'var(--accent)', color: 'white' }}
                      >
                        Re-link
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })}

      {wizardPlatform && (
        <ConnectPlatformWizard
          platform={wizardPlatform}
          onClose={() => setWizardPlatform(null)}
          onConnected={refresh}
        />
      )}
    </div>
  );
}
