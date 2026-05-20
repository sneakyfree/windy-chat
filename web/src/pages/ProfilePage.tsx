import { useState, useEffect } from 'react';
import * as api from '../lib/api';

interface Profile {
  user_id: string;
  display_name?: string | null;
  chat_user_id?: string | null;
  verified: boolean;
  posts_count: number;
  followers_count: number;
  following_count: number;
  eternitas_passport?: string | null;
}

export default function ProfilePage({
  userId: viewUserId,
  onBack,
}: {
  userId: string | null;
  onBack?: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const targetUserId = viewUserId || 'me';

  useEffect(() => {
    if (!viewUserId) { setLoading(false); return; }
    setError(null);
    api.getUserProfile(viewUserId)
      .then(setProfile)
      .catch(() => setError('Could not load profile'))
      .finally(() => setLoading(false));
  }, [viewUserId]);

  const handleFollow = async () => {
    if (!viewUserId) return;
    try {
      if (following) {
        await api.unfollowUser(viewUserId);
        setFollowing(false);
      } else {
        await api.followUser(viewUserId);
        setFollowing(true);
      }
    } catch { /* ignore */ }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading profile...</div>
      </div>
    );
  }

  if (error || (!profile && !loading)) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-3xl mb-3">👤</div>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{error || 'Profile not available'}</p>
          {viewUserId && (
            <button
              onClick={() => { setLoading(true); setError(null); api.getUserProfile(viewUserId).then(setProfile).catch(() => setError('Could not load profile')).finally(() => setLoading(false)); }}
              className="px-4 py-2 rounded-xl text-sm"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  const isAgent = targetUserId.startsWith('bot_') || targetUserId.startsWith('agent_');
  // Display name precedence: server snapshot > chat handle > raw userId.
  // The raw-UUID fallback is the grandma-demo failure we're trying to bury.
  const displayName =
    (profile?.display_name && profile.display_name.trim()) ||
    (profile?.chat_user_id && profile.chat_user_id.trim()) ||
    targetUserId;
  const handle = profile?.chat_user_id || null;
  const avatarChar = isAgent ? '🪰' : displayName.charAt(0).toUpperCase();

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-4 text-sm hover:underline"
          style={{ color: 'var(--text-secondary)' }}
        >
          ← Back
        </button>
      )}
      <div className="text-center mb-8">
        <div className="w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center text-3xl"
             style={{ background: isAgent ? 'var(--agent-bg)' : 'var(--bg-tertiary)', border: isAgent ? '2px solid var(--accent)' : 'none' }}>
          {avatarChar}
        </div>

        <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>{displayName}</h1>
        {handle && (
          <p className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>@{handle}</p>
        )}

        {profile?.verified && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs mb-3"
               style={{ background: 'rgba(124,92,255,0.15)', color: 'var(--accent)' }}>
            ✓ Eternitas Verified
            {profile.eternitas_passport && <span> — {profile.eternitas_passport}</span>}
          </div>
        )}

        {isAgent && (
          <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>AI Agent — Powered by Windy Fly</p>
        )}

        <div className="flex justify-center gap-8 mt-6">
          <div className="text-center">
            <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{profile?.posts_count ?? '—'}</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Posts</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{profile?.followers_count ?? '—'}</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Followers</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{profile?.following_count ?? '—'}</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Following</div>
          </div>
        </div>

        <div className="flex justify-center gap-3 mt-6">
          <button
            aria-label="Send message"
            className="px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-90"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            💬 Message
          </button>
          <button
            onClick={handleFollow}
            aria-label={following ? 'Unfollow' : 'Follow'}
            className="px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-90"
            style={{ background: following ? 'var(--accent)' : 'var(--bg-tertiary)', color: following ? 'white' : 'var(--text-primary)' }}
          >
            {following ? '✓ Following' : '+ Follow'}
          </button>
        </div>
      </div>
    </div>
  );
}
