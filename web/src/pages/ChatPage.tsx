import { useState, useEffect, useRef, useCallback } from 'react';
import * as matrix from '../lib/matrix';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useNotifications } from '../hooks/useNotifications';
import CreateGroupModal from '../components/CreateGroupModal';
import type { Room, MatrixEvent } from 'matrix-js-sdk';

interface ChatPageProps {
  userId: string | null;
}

// ── Room List Item ──
function RoomItem({ room, selected, onClick }: { room: Room; selected: boolean; onClick: () => void }) {
  const isAgent = matrix.isAgentRoom(room);
  const unread = matrix.getUnreadCount(room);
  const lastEvent = room.getLastActiveTimestamp();
  const timeStr = lastEvent ? new Date(lastEvent).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div
      onClick={onClick}
      className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors"
      style={{
        background: selected ? 'var(--bg-tertiary)' : 'transparent',
        borderLeft: isAgent ? '3px solid var(--accent)' : '3px solid transparent',
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)'; }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    >
      {/* Avatar */}
      <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium shrink-0"
           style={{ background: isAgent ? 'var(--agent-bg)' : 'var(--bg-tertiary)', border: isAgent ? '1px solid var(--agent-border)' : 'none' }}>
        {isAgent ? '🪰' : room.name?.charAt(0)?.toUpperCase() || '?'}
      </div>

      {/* Name + last message */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>
            {room.name || 'Unnamed Room'}
          </span>
          {isAgent && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--accent)', color: 'white' }}>
              AI Agent
            </span>
          )}
        </div>
        <p className="text-xs truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>
          {room.timeline?.length ? (room.timeline[room.timeline.length - 1] as MatrixEvent)?.getContent()?.body || '' : ''}
        </p>
      </div>

      {/* Time + unread */}
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{timeStr}</span>
        {unread > 0 && (
          <span className="w-5 h-5 rounded-full text-[10px] flex items-center justify-center text-white"
                style={{ background: 'var(--accent)' }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Receipt Check Marks ──
function ReceiptStatus({ event }: { event: MatrixEvent }) {
  // ✓ = sent, ✓✓ = delivered, blue ✓✓ = read
  const status = event.getAssociatedStatus?.();
  const client = matrix.getClient();
  const room = client?.getRoom(event.getRoomId() || '');
  const receipts = room?.getReceiptsForEvent?.(event) || [];
  const hasReadReceipt = receipts.some((r: any) => r.type === 'm.read');

  if (hasReadReceipt) {
    return <span style={{ color: '#60a5fa' }}>✓✓</span>; // Blue — read
  }
  if (status === null || status === undefined) {
    return <span>✓✓</span>; // Delivered (reached server, no explicit delivery tracking in Matrix)
  }
  if (status === 'sending') {
    return <span style={{ opacity: 0.4 }}>✓</span>; // Sending
  }
  return <span>✓</span>; // Sent
}

// ── Message Bubble ──
function MessageBubble({ event, isOwn }: { event: MatrixEvent; isOwn: boolean }) {
  const sender = event.getSender();
  const content = event.getContent();
  const isAgent = sender?.startsWith('@agent_');
  const time = event.getDate()?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';

  if (event.getType() !== 'm.room.message') return null;

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[70%] px-4 py-2.5 rounded-2xl text-sm ${isAgent ? 'agent-message' : ''}`}
        style={{
          background: isOwn ? 'var(--accent)' : isAgent ? 'var(--agent-bg)' : 'var(--bg-tertiary)',
          color: isOwn ? 'white' : 'var(--text-primary)',
          borderBottomRightRadius: isOwn ? '6px' : undefined,
          borderBottomLeftRadius: !isOwn ? '6px' : undefined,
        }}
      >
        {!isOwn && (
          <div className="flex items-center gap-1.5 mb-1">
            {isAgent && <span className="text-xs">🪰</span>}
            <span className="text-xs font-medium" style={{ color: isAgent ? 'var(--accent)' : 'var(--text-secondary)' }}>
              {sender?.split(':')[0]?.replace('@', '') || 'Unknown'}
            </span>
          </div>
        )}
        <p className="whitespace-pre-wrap break-words">{content.body || ''}</p>
        <div className={`flex items-center gap-1 text-[10px] mt-1 ${isOwn ? 'justify-end' : ''}`}
             style={{ color: isOwn ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)' }}>
          <span>{time}</span>
          {isOwn && <ReceiptStatus event={event} />}
        </div>
      </div>
    </div>
  );
}

// ── Main Chat Page ──
export default function ChatPage({ userId }: ChatPageProps) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MatrixEvent[]>([]);
  const [input, setInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showGroupModal, setShowGroupModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const voice = useVoiceInput();
  const notifications = useNotifications();

  // Load rooms
  useEffect(() => {
    const refreshRooms = () => setRooms(matrix.getRooms());
    refreshRooms();
    const interval = setInterval(refreshRooms, 3000);

    const client = matrix.getClient();
    if (client) {
      client.on('Room.timeline' as any, refreshRooms);
      client.on('Room' as any, refreshRooms);
    }
    return () => {
      clearInterval(interval);
      if (client) {
        client.removeListener('Room.timeline' as any, refreshRooms);
        client.removeListener('Room' as any, refreshRooms);
      }
    };
  }, []);

  // Load messages for selected room
  useEffect(() => {
    if (!selectedRoomId) { setMessages([]); return; }
    const client = matrix.getClient();
    if (!client) return;

    const room = client.getRoom(selectedRoomId);
    if (room) {
      setMessages([...(room.getLiveTimeline()?.getEvents() || [])]);
    }

    const onTimeline = (event: MatrixEvent) => {
      if (event.getRoomId() === selectedRoomId) {
        const r = client.getRoom(selectedRoomId);
        if (r) {
          setMessages([...(r.getLiveTimeline()?.getEvents() || [])]);
          // Send read receipt for the latest event
          if (event.getSender() !== userId) {
            client.sendReadReceipt(event).catch(() => {});
            // Trigger notification if tab is hidden
            const sender = event.getSender()?.split(':')[0]?.replace('@', '') || 'Someone';
            notifications.notifyNewMessage(sender, r.name || 'Chat', event.getId() || '');
          }
        }
      }
    };

    client.on('Room.timeline' as any, onTimeline);
    return () => { client.removeListener('Room.timeline' as any, onTimeline); };
  }, [selectedRoomId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Append voice transcript to input
  useEffect(() => {
    if (voice.transcript) setInput(voice.transcript);
  }, [voice.transcript]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || !selectedRoomId) return;
    try {
      await matrix.sendMessage(selectedRoomId, input.trim());
      setInput('');
      voice.clear();
    } catch (err) {
      console.error('Send failed:', err);
    }
  }, [input, selectedRoomId, voice]);

  const filteredRooms = searchQuery
    ? rooms.filter(r => r.name?.toLowerCase().includes(searchQuery.toLowerCase()))
    : rooms;

  // Sort: agent rooms first, then by last activity
  const agentRooms = filteredRooms.filter(r => matrix.isAgentRoom(r));
  const humanRooms = filteredRooms.filter(r => !matrix.isAgentRoom(r));
  const sortedRooms = [...agentRooms, ...humanRooms];
  const hasAgentRooms = agentRooms.length > 0;

  const selectedRoom = selectedRoomId ? rooms.find(r => r.roomId === selectedRoomId) : null;

  return (
    <div className="flex h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* ── Left Sidebar (hidden on mobile when chat selected) ── */}
      <div className={`${selectedRoomId ? 'hidden md:flex' : 'flex'} w-full md:w-80 shrink-0 flex-col border-r`}
           style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
        {/* Search */}
        <div className="p-4">
          <input
            type="text"
            placeholder="Search chats..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl text-sm outline-none"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          />
        </div>

        {/* New Chat / New Group Buttons */}
        <div className="px-4 pb-3 flex gap-2">
          <button
            className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-90"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            + New Chat
          </button>
          <button
            onClick={() => setShowGroupModal(true)}
            className="py-2 px-3 rounded-xl text-sm font-medium transition-all hover:opacity-90"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            title="New Group"
          >
            👥
          </button>
        </div>

        {/* Room List */}
        <div className="flex-1 overflow-y-auto">
          {sortedRooms.length === 0 ? (
            <div className="text-center py-8 px-4">
              <div className="text-4xl mb-3">🌪️</div>
              <h3 className="text-base font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Welcome to Windy Chat!</h3>
              <p className="text-xs mb-6" style={{ color: 'var(--text-muted)' }}>Find friends or discover AI agents to get started</p>
              <div className="space-y-2">
                <button
                  className="w-full py-2.5 rounded-xl text-sm font-medium"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  🪰 Discover Agents
                </button>
                <button
                  className="w-full py-2.5 rounded-xl text-sm font-medium"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                >
                  📨 Invite Friends
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Hatch a Windy Fly CTA — shown when user has no agent rooms */}
              {!hasAgentRooms && sortedRooms.length > 0 && (
                <div className="mx-3 mb-3 p-3 rounded-xl"
                     style={{ background: 'var(--agent-bg)', border: '1px solid var(--agent-border)' }}>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">🪰</span>
                    <div className="flex-1">
                      <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Hatch a Windy Fly agent</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>Your personal AI assistant with an Eternitas passport</p>
                    </div>
                    <button className="px-3 py-1.5 rounded-lg text-[10px] font-medium shrink-0"
                            style={{ background: 'var(--accent)', color: 'white' }}>
                      Hatch
                    </button>
                  </div>
                </div>
              )}

              {/* Agent rooms section */}
              {agentRooms.length > 0 && (
                <div className="px-4 py-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    AI Agents ({agentRooms.length})
                  </span>
                </div>
              )}

              {agentRooms.map(room => (
                <RoomItem
                  key={room.roomId}
                  room={room}
                  selected={room.roomId === selectedRoomId}
                  onClick={() => setSelectedRoomId(room.roomId)}
                />
              ))}

              {/* Conversations section */}
              {humanRooms.length > 0 && agentRooms.length > 0 && (
                <div className="px-4 py-1.5 mt-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    Conversations ({humanRooms.length})
                  </span>
                </div>
              )}

              {humanRooms.map(room => (
                <RoomItem
                  key={room.roomId}
                  room={room}
                  selected={room.roomId === selectedRoomId}
                  onClick={() => setSelectedRoomId(room.roomId)}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {/* ── Right Panel — Messages (hidden on mobile when no chat selected) ── */}
      <div className={`${selectedRoomId ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0`}>
        {selectedRoom ? (
          <>
            {/* Room header */}
            <div className="px-4 md:px-6 py-4 border-b flex items-center gap-3" style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
              {/* Back button (mobile only) */}
              <button
                onClick={() => setSelectedRoomId(null)}
                className="md:hidden w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                ←
              </button>
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm"
                   style={{ background: 'var(--bg-tertiary)' }}>
                {matrix.isAgentRoom(selectedRoom) ? '🪰' : selectedRoom.name?.charAt(0) || '?'}
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>{selectedRoom.name}</h2>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {selectedRoom.getJoinedMemberCount()} members
                </p>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {messages.map((event, i) => (
                <MessageBubble
                  key={event.getId() || i}
                  event={event}
                  isOwn={event.getSender() === userId}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="px-6 py-4 border-t" style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
              <div className="flex items-center gap-3">
                {/* Voice input button */}
                {voice.isSupported && (
                  <button
                    onClick={voice.isRecording ? voice.stop : voice.start}
                    className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${voice.isRecording ? 'animate-pulse' : ''}`}
                    style={{
                      background: voice.isRecording ? 'var(--danger)' : 'var(--bg-tertiary)',
                      color: voice.isRecording ? 'white' : 'var(--text-secondary)',
                    }}
                    title={voice.isRecording ? 'Stop recording' : 'Voice input'}
                  >
                    🎙️
                  </button>
                )}

                <input
                  type="text"
                  placeholder={voice.isRecording ? 'Listening...' : 'Type a message...'}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  className="flex-1 px-4 py-3 rounded-xl text-sm outline-none"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                />
                <button
                  onClick={sendMessage}
                  disabled={!input.trim()}
                  className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all disabled:opacity-30"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  ↑
                </button>
              </div>
              {voice.error && (
                <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{voice.error}</p>
              )}
            </div>
          </>
        ) : (
          /* Empty state */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-5xl mb-4">🌪️</div>
              <h2 className="text-xl font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Windy Chat</h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Select a conversation to start messaging
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Group creation modal (Task 4) */}
      {showGroupModal && (
        <CreateGroupModal
          onClose={() => setShowGroupModal(false)}
          onCreated={(roomId) => { setShowGroupModal(false); setSelectedRoomId(roomId); }}
        />
      )}
    </div>
  );
}
