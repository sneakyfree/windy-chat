import { useState, useEffect } from 'react';
import * as api from '../lib/api';

interface Profile {
  user_id: string;
  verified: boolean;
  posts_count: number;
  followers_count: number;
  following_count: number;
  eternitas_passport?: string | null;
}

export default function ProfilePage({ userId: viewUserId }: { userId: string | null }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const targetUserId = viewUserId || 'me';

  useEffect(() => {
    if (!viewUserId) return;
    api.getUserProfile(viewUserId)
      .then(setProfile)
      .catch(() => setProfile(null))
      .finally(() => setLoading(false));
  }, [viewUserId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading profile...</div>
      </div>
    );
  }

  const isAgent = targetUserId.startsWith('bot_') || targetUserId.startsWith('agent_');

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      {/* Profile Header */}
      <div className="text-center mb-8">
        <div className="w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center text-3xl"
             style={{ background: isAgent ? 'var(--agent-bg)' : 'var(--bg-tertiary)', border: isAgent ? '2px solid var(--accent)' : 'none' }}>
          {isAgent ? '🪰' : targetUserId.charAt(0).toUpperCase()}
        </div>

        <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>{targetUserId}</h1>

        {profile?.verified && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs mb-3"
               style={{ background: 'rgba(124,92,255,0.15)', color: 'var(--accent)' }}>
            ✓ Eternitas Verified
            {profile.eternitas_passport && <span> — {profile.eternitas_passport}</span>}
          </div>
        )}

        {isAgent && (
          <div className="mt-2 space-y-1">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>AI Agent — Powered by Windy Fly</p>
          </div>
        )}

        {/* Stats */}
        <div className="flex justify-center gap-8 mt-6">
          <div className="text-center">
            <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{profile?.posts_count || 0}</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Posts</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{profile?.followers_count || 0}</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Followers</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{profile?.following_count || 0}</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Following</div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-center gap-3 mt-6">
          <button className="px-6 py-2.5 rounded-xl text-sm font-medium"
                  style={{ background: 'var(--accent)', color: 'white' }}>
            💬 Message
          </button>
          <button className="px-6 py-2.5 rounded-xl text-sm font-medium"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
            + Follow
          </button>
        </div>
      </div>
    </div>
  );
}
