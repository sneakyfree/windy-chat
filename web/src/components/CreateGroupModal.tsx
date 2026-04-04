/** Task 4: Group chat creation modal */
import { useState, useEffect } from 'react';
import * as matrix from '../lib/matrix';

interface CreateGroupModalProps {
  onClose: () => void;
  onCreated: (roomId: string) => void;
}

interface Contact {
  userId: string;
  displayName: string;
  isAgent: boolean;
}

export default function CreateGroupModal({ onClose, onCreated }: CreateGroupModalProps) {
  const [step, setStep] = useState<'select' | 'name'>('select');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Build contact list from existing DM rooms
  useEffect(() => {
    const client = matrix.getClient();
    if (!client) return;
    const myId = client.getUserId();
    const rooms = matrix.getRooms();
    const contactMap = new Map<string, Contact>();

    for (const room of rooms) {
      const members = room.getJoinedMembers();
      for (const m of members) {
        if (m.userId !== myId && !contactMap.has(m.userId)) {
          contactMap.set(m.userId, {
            userId: m.userId,
            displayName: m.name || m.userId.split(':')[0].replace('@', ''),
            isAgent: m.userId.startsWith('@agent_'),
          });
        }
      }
    }

    // Sort: agents first, then alphabetical
    const sorted = [...contactMap.values()].sort((a, b) => {
      if (a.isAgent && !b.isAgent) return -1;
      if (!a.isAgent && b.isAgent) return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    setContacts(sorted);
  }, []);

  const toggleContact = (userId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const filteredContacts = search
    ? contacts.filter(c => c.displayName.toLowerCase().includes(search.toLowerCase()) || c.userId.includes(search))
    : contacts;

  async function createGroup() {
    if (!groupName.trim() || selected.size === 0) return;
    setCreating(true);
    setError('');

    const client = matrix.getClient();
    if (!client) { setError('Not connected to Matrix'); setCreating(false); return; }

    try {
      const result = await client.createRoom({
        name: groupName.trim(),
        invite: [...selected],
        is_direct: false,
        preset: 'private_chat' as any,
        initial_state: [{
          type: 'm.room.guest_access',
          state_key: '',
          content: { guest_access: 'forbidden' },
        }],
      });
      onCreated(result.room_id);
    } catch (err: any) {
      console.error('Group creation failed:', err);
      setError(err.message || 'Failed to create group');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-md rounded-2xl shadow-2xl flex flex-col"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--bg-tertiary)', maxHeight: '80vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b flex items-center justify-between shrink-0"
             style={{ borderColor: 'var(--bg-tertiary)' }}>
          <div>
            <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
              {step === 'select' ? 'New Group' : 'Name Your Group'}
            </h2>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {step === 'select' ? `${selected.size} selected` : `${selected.size} members`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            &times;
          </button>
        </div>

        {step === 'select' && (
          <>
            {/* Search */}
            <div className="px-4 py-3 shrink-0">
              <input
                type="text"
                placeholder="Search contacts..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl text-sm outline-none"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              />
            </div>

            {/* Selected chips */}
            {selected.size > 0 && (
              <div className="px-4 pb-2 flex flex-wrap gap-1.5 shrink-0">
                {[...selected].map(id => {
                  const c = contacts.find(x => x.userId === id);
                  return (
                    <span
                      key={id}
                      onClick={() => toggleContact(id)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs cursor-pointer"
                      style={{ background: 'var(--accent)', color: 'white' }}
                    >
                      {c?.isAgent && '🪰 '}{c?.displayName || id.split(':')[0]}
                      <span className="opacity-70">&times;</span>
                    </span>
                  );
                })}
              </div>
            )}

            {/* Contact list */}
            <div className="flex-1 overflow-y-auto px-2">
              {filteredContacts.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    {contacts.length === 0 ? 'No contacts found. Start some conversations first!' : 'No matches'}
                  </p>
                </div>
              ) : (
                filteredContacts.map(contact => (
                  <div
                    key={contact.userId}
                    onClick={() => toggleContact(contact.userId)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors"
                    style={{ background: selected.has(contact.userId) ? 'rgba(124,92,255,0.1)' : 'transparent' }}
                  >
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center text-sm shrink-0"
                      style={{
                        background: contact.isAgent ? 'var(--agent-bg)' : 'var(--bg-tertiary)',
                        border: contact.isAgent ? '1px solid var(--accent)' : 'none',
                      }}
                    >
                      {contact.isAgent ? '🪰' : contact.displayName.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium truncate block" style={{ color: 'var(--text-primary)' }}>
                        {contact.displayName}
                      </span>
                      {contact.isAgent && (
                        <span className="text-[10px]" style={{ color: 'var(--accent)' }}>AI Agent</span>
                      )}
                    </div>
                    <div
                      className="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0"
                      style={{
                        borderColor: selected.has(contact.userId) ? 'var(--accent)' : 'var(--text-muted)',
                        background: selected.has(contact.userId) ? 'var(--accent)' : 'transparent',
                      }}
                    >
                      {selected.has(contact.userId) && (
                        <span className="text-white text-[10px]">✓</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Next button */}
            <div className="px-4 py-3 border-t shrink-0" style={{ borderColor: 'var(--bg-tertiary)' }}>
              <button
                onClick={() => setStep('name')}
                disabled={selected.size === 0}
                className="w-full py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-40"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                Next — Name the Group
              </button>
            </div>
          </>
        )}

        {step === 'name' && (
          <div className="p-6">
            {/* Group name input */}
            <div className="mb-6">
              <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
                Group Name
              </label>
              <input
                type="text"
                placeholder="e.g., Family Chat, Project Team, Agent Squad..."
                value={groupName}
                onChange={e => setGroupName(e.target.value)}
                autoFocus
                maxLength={100}
                className="w-full px-4 py-3 rounded-xl text-sm outline-none"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              />
            </div>

            {/* Members preview */}
            <div className="mb-6">
              <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                Members ({selected.size})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[...selected].map(id => {
                  const c = contacts.find(x => x.userId === id);
                  return (
                    <span key={id} className="text-xs px-2 py-1 rounded-full"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
                      {c?.isAgent && '🪰 '}{c?.displayName || id.split(':')[0]}
                    </span>
                  );
                })}
              </div>
            </div>

            {error && (
              <div className="text-sm px-3 py-2 rounded-lg mb-4" style={{ color: 'var(--danger)', background: 'rgba(248,113,113,0.1)' }}>
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setStep('select')}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              >
                Back
              </button>
              <button
                onClick={createGroup}
                disabled={!groupName.trim() || creating}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-40"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {creating ? 'Creating...' : 'Create Group'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
