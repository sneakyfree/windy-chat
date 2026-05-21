import { useEffect, useState, useCallback } from 'react';
import * as api from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onNavigateToProfile?: (userId: string) => void;
  onNavigateToSocial?: () => void;
}

/**
 * Slide-over notification center.
 *
 * Loads /api/v1/social/notifications on open, displays a unified list of
 * likes / comments / replies / follows / reposts / agent.hatched events,
 * and marks them read in bulk when the panel closes. Each row click
 * navigates to the relevant surface (post → Social feed, follow → Profile).
 *
 * Why a slide-over instead of a routed page: matches MailPanel's pattern,
 * keeps the feed in view while the user scans notifications, and is the
 * cheapest path to a working notification surface (a routed page would
 * need its own back button + scroll restoration).
 */
export default function NotificationsPanel({
  open,
  onClose,
  onNavigateToProfile,
  onNavigateToSocial,
}: Props) {
  const [items, setItems] = useState<api.Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getNotifications();
      setItems(data.notifications || []);
    } catch (err: any) {
      setError(err?.message || 'Could not load notifications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
  }, [open, load]);

  // Mark unread notifications as read when the panel closes — opening it
  // counts as "seeing" the notifications. We pass only unread IDs so the
  // server doesn't have to re-mark already-read rows.
  useEffect(() => {
    if (open) return;
    const unread = items.filter(n => !n.read).map(n => n.id);
    if (unread.length === 0) return;
    api.markNotificationsRead(unread).catch(() => { /* non-fatal */ });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleItemClick = (n: api.Notification) => {
    // Likes / comments / reposts → social tab. Follow → that user's profile.
    if (n.type === 'follow') {
      onNavigateToProfile?.(n.fromUserId);
    } else {
      onNavigateToSocial?.();
    }
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.4)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Slide-over */}
      <aside
        role="dialog"
        aria-label="Notifications"
        className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-sm flex flex-col shadow-2xl"
        style={{ background: 'var(--bg-primary)', borderLeft: '1px solid var(--bg-tertiary)' }}
      >
        <header className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--bg-tertiary)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Notifications</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close notifications"
            className="text-lg leading-none px-2"
            style={{ color: 'var(--text-secondary)' }}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <p className="px-5 py-6 text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>
          )}
          {error && !loading && (
            <div className="px-5 py-6 text-center">
              <p className="text-sm mb-3" style={{ color: 'var(--danger)' }}>{error}</p>
              <button
                type="button"
                onClick={load}
                className="text-xs underline"
                style={{ color: 'var(--accent)' }}
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="px-5 py-12 text-center">
              <div className="text-3xl mb-3">🔔</div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                You're all caught up — no notifications yet.
              </p>
            </div>
          )}
          {!loading && !error && items.map(n => (
            <button
              key={n.id}
              type="button"
              onClick={() => handleItemClick(n)}
              className="w-full flex items-start gap-3 px-5 py-3 border-b text-left transition-colors"
              style={{
                borderColor: 'var(--bg-tertiary)',
                background: n.read ? 'transparent' : 'rgba(124,92,255,0.08)',
              }}
            >
              <span className="text-lg shrink-0 leading-none mt-0.5">{notificationIcon(n.type)}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{shortenUserId(n.fromUserId)}</span>{' '}
                  {notificationVerb(n.type)}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {relativeTime(n.createdAt)}
                </p>
              </div>
              {!n.read && (
                <span
                  className="w-2 h-2 rounded-full shrink-0 mt-2"
                  style={{ background: 'var(--accent)' }}
                  aria-label="Unread"
                />
              )}
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}

function notificationIcon(type: string): string {
  switch (type) {
    case 'like': return '♥';
    case 'comment_like': return '♥';
    case 'comment': return '💬';
    case 'comment_reply': return '↩';
    case 'repost': return '🔁';
    case 'follow': return '👤';
    case 'agent.hatched': return '🪰';
    default: return '🔔';
  }
}

function notificationVerb(type: string): string {
  switch (type) {
    case 'like': return 'liked your post';
    case 'comment_like': return 'liked your comment';
    case 'comment': return 'commented on your post';
    case 'comment_reply': return 'replied to your comment';
    case 'repost': return 'reposted your post';
    case 'follow': return 'followed you';
    case 'agent.hatched': return 'agent hatched';
    default: return 'did something';
  }
}

function shortenUserId(id: string): string {
  if (!id) return 'Someone';
  if (id.length > 10) return id.slice(0, 8) + '…';
  return id;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
