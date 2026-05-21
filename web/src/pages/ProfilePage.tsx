import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/api';
import { createDMRoom } from '../lib/matrix';

interface Profile {
  user_id: string;
  display_name?: string | null;
  chat_user_id?: string | null;
  matrix_user_id?: string | null;
  verified: boolean;
  posts_count: number;
  followers_count: number;
  following_count: number;
  eternitas_passport?: string | null;
}

export default function ProfilePage({
  userId: viewUserId,
  onBack,
  selfUserId,
  onOpenChat,
}: {
  userId: string | null;
  onBack?: () => void;
  selfUserId?: string | null;
  onOpenChat?: (roomId: string) => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [myProfile, setMyProfile] = useState<api.MyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const targetUserId = viewUserId || 'me';
  const isSelf = !!(selfUserId && viewUserId && selfUserId === viewUserId);

  // Edit-mode state. Only relevant when viewing one's own profile.
  const [editing, setEditing] = useState(false);
  const [draftDisplayName, setDraftDisplayName] = useState('');
  const [draftBio, setDraftBio] = useState('');
  const [draftAvatarUrl, setDraftAvatarUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarFileRef = useRef<HTMLInputElement>(null);
  const [dmOpening, setDmOpening] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewUserId) { setLoading(false); return; }
    setError(null);
    setLoading(true);
    api.getUserProfile(viewUserId)
      .then(setProfile)
      .catch(() => setError('Could not load profile'))
      .finally(() => setLoading(false));
  }, [viewUserId]);

  // When viewing the signed-in user's own profile, also fetch the rich
  // user_profiles row from chat-onboarding (display_name + avatar + bio +
  // languages). The Social profile endpoint only carries the post-snapshot
  // subset; chat-onboarding is the source of truth for editable fields.
  useEffect(() => {
    if (!isSelf) { setMyProfile(null); return; }
    api.getMyProfile()
      .then(p => {
        setMyProfile(p);
        if (p) {
          setDraftDisplayName(p.displayName || '');
          setDraftBio(p.bio || '');
          setDraftAvatarUrl(p.avatarUrl || null);
        }
      })
      .catch(() => { /* non-fatal — view-mode still renders the public profile */ });
  }, [isSelf]);

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

  // Open (or reuse) a DM room with this profile's owner, then ask App.tsx
  // to switch to the Chat tab and auto-select that room. Requires the
  // profile to expose matrix_user_id — for users without a Matrix
  // localpart yet we surface a friendly error instead of silently failing.
  const handleMessage = async () => {
    setDmError(null);
    const target = profile?.matrix_user_id;
    if (!target) {
      setDmError('This user has no Windy Chat handle yet.');
      return;
    }
    setDmOpening(true);
    try {
      const roomId = await createDMRoom(target);
      onOpenChat?.(roomId);
    } catch (err: any) {
      console.warn('[profile] DM creation failed', err);
      setDmError(err?.message || 'Could not open chat.');
    } finally {
      setDmOpening(false);
    }
  };

  const handleAvatarPick = async (file: File | null) => {
    if (!file) return;
    setSaveError(null);
    if (!file.type.startsWith('image/')) {
      setSaveError('Avatar must be an image.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setSaveError('Avatar must be 5 MB or smaller.');
      return;
    }
    setAvatarUploading(true);
    try {
      const uploaded = await api.uploadMedia(file);
      setDraftAvatarUrl(uploaded.thumbnail_url || uploaded.url);
    } catch (err) {
      console.warn('[profile] avatar upload failed', err);
      setSaveError('Avatar upload failed — try a different image.');
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateMyProfile({
        displayName: draftDisplayName.trim() || undefined,
        bio: draftBio,
        avatarUrl: draftAvatarUrl,
      });
      setMyProfile(updated);
      setEditing(false);
      // Re-fetch the social profile so the visible header reflects the
      // new display info immediately (display name + handle hydrate from
      // the social.profile/:userId snapshot path).
      if (viewUserId) {
        api.getUserProfile(viewUserId).then(setProfile).catch(() => {});
      }
    } catch (err: any) {
      setSaveError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
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
  const displayName =
    (myProfile?.displayName && myProfile.displayName.trim()) ||
    (profile?.display_name && profile.display_name.trim()) ||
    (profile?.chat_user_id && profile.chat_user_id.trim()) ||
    targetUserId;
  const handle = myProfile?.chatUserId || profile?.chat_user_id || null;
  const avatarUrl = myProfile?.avatarUrl || draftAvatarUrl || null;
  const avatarChar = isAgent ? '🪰' : displayName.charAt(0).toUpperCase();

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 overflow-y-auto h-full">
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

      {!editing && (
        <div className="text-center mb-8">
          <div
            className="w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center text-3xl overflow-hidden"
            style={{
              background: isAgent ? 'var(--agent-bg)' : 'var(--bg-tertiary)',
              border: isAgent ? '2px solid var(--accent)' : 'none',
            }}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt={displayName} className="w-full h-full object-cover" />
            ) : (
              <span>{avatarChar}</span>
            )}
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

          {myProfile?.bio && (
            <p className="text-sm mt-4 whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{myProfile.bio}</p>
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
            {isSelf ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="px-6 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                ✏️ Edit Profile
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleMessage}
                  disabled={dmOpening || !profile?.matrix_user_id}
                  aria-label="Send message"
                  title={!profile?.matrix_user_id ? 'This user has no Windy Chat handle yet' : 'Open a direct message'}
                  className="px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  {dmOpening ? 'Opening…' : '💬 Message'}
                </button>
                <button
                  onClick={handleFollow}
                  aria-label={following ? 'Unfollow' : 'Follow'}
                  className="px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-90"
                  style={{ background: following ? 'var(--accent)' : 'var(--bg-tertiary)', color: following ? 'white' : 'var(--text-primary)' }}
                >
                  {following ? '✓ Following' : '+ Follow'}
                </button>
              </>
            )}
          </div>
          {dmError && (
            <p role="alert" className="text-xs mt-3" style={{ color: 'var(--danger)' }}>{dmError}</p>
          )}
        </div>
      )}

      {editing && isSelf && (
        <div className="max-w-md mx-auto">
          <h2 className="text-lg font-bold mb-6" style={{ color: 'var(--text-primary)' }}>Edit Profile</h2>

          {/* Avatar uploader */}
          <div className="flex items-center gap-4 mb-6">
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center text-2xl overflow-hidden shrink-0"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              {draftAvatarUrl ? (
                <img src={draftAvatarUrl} alt="avatar preview" className="w-full h-full object-cover" />
              ) : (
                <span>{(draftDisplayName || displayName).charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className="flex-1">
              <input
                ref={avatarFileRef}
                type="file"
                accept="image/*"
                onChange={e => handleAvatarPick(e.target.files?.[0] || null)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => avatarFileRef.current?.click()}
                disabled={avatarUploading}
                className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-40"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {avatarUploading ? 'Uploading…' : (draftAvatarUrl ? 'Replace avatar' : 'Upload avatar')}
              </button>
              {draftAvatarUrl && !avatarUploading && (
                <button
                  type="button"
                  onClick={() => setDraftAvatarUrl(null)}
                  className="text-xs px-3 py-1.5 rounded-lg ml-2"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {/* Display name */}
          <label className="block mb-4">
            <span className="text-xs font-medium block mb-1" style={{ color: 'var(--text-secondary)' }}>Display name</span>
            <input
              type="text"
              value={draftDisplayName}
              onChange={e => setDraftDisplayName(e.target.value)}
              maxLength={100}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
            />
          </label>

          {/* Bio */}
          <label className="block mb-4">
            <span className="text-xs font-medium block mb-1" style={{ color: 'var(--text-secondary)' }}>Bio</span>
            <textarea
              value={draftBio}
              onChange={e => setDraftBio(e.target.value)}
              maxLength={280}
              rows={3}
              placeholder="Tell people about yourself…"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
            />
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{draftBio.length}/280</span>
          </label>

          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            Handle <code style={{ color: 'var(--text-secondary)' }}>@{handle || 'unknown'}</code> and account email are fixed.
          </p>

          {saveError && (
            <p role="alert" className="text-xs mb-3" style={{ color: 'var(--danger)' }}>{saveError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || avatarUploading}
              className="flex-1 px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setSaveError(null);
                // Revert drafts to last-saved values.
                if (myProfile) {
                  setDraftDisplayName(myProfile.displayName || '');
                  setDraftBio(myProfile.bio || '');
                  setDraftAvatarUrl(myProfile.avatarUrl || null);
                }
              }}
              className="px-4 py-2 rounded-xl text-sm"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
