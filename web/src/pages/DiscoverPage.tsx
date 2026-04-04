/** Task 1: Bot Discovery Page — "App Store for AI Agents" */
import { useState, useEffect, useCallback } from 'react';
import TrustBadge from '../components/TrustBadge';
import AgentProfileModal from '../components/AgentProfileModal';
import { env } from '../env';

interface Agent {
  userId: string;
  displayName: string;
  description?: string;
  category?: string;
  trustScore?: number;
  passportId?: string;
  clearanceLevel?: string;
  operatorInfo?: string;
  registeredAt?: string;
  verified: boolean;
}

const CATEGORIES = [
  { id: 'all', label: 'All Agents' },
  { id: 'assistant', label: 'Assistants' },
  { id: 'translator', label: 'Translators' },
  { id: 'customer-service', label: 'Customer Service' },
  { id: 'creative', label: 'Creative' },
  { id: 'education', label: 'Education' },
  { id: 'productivity', label: 'Productivity' },
];

const TRUST_FILTERS = [
  { id: 'any', label: 'Any Trust Level' },
  { id: '800', label: 'High (800+)' },
  { id: '600', label: 'Medium+ (600+)' },
];

// Demo agents for when backend isn't connected
const DEMO_AGENTS: Agent[] = [
  { userId: 'bot_translator-001', displayName: 'Windy Translator', description: 'I speak 199 languages. Send me text and I\'ll translate it instantly.', category: 'translator', trustScore: 920, passportId: 'ET-TRANS-001', clearanceLevel: 'Verified', verified: true },
  { userId: 'bot_travel-planner', displayName: 'TravelBot', description: 'I can help with travel planning! Ask me anything about flights, hotels, and itineraries.', category: 'assistant', trustScore: 847, passportId: 'ET-TRAV-001', clearanceLevel: 'Verified', verified: true },
  { userId: 'bot_code-helper', displayName: 'CodeFly', description: 'Your pair programming buddy. I help with code reviews, debugging, and explaining complex concepts.', category: 'productivity', trustScore: 780, passportId: 'ET-CODE-001', clearanceLevel: 'Standard', verified: true },
  { userId: 'bot_writing-coach', displayName: 'WriteWise', description: 'Creative writing assistant. I help with essays, stories, emails, and more.', category: 'creative', trustScore: 715, passportId: 'ET-WRITE-001', clearanceLevel: 'Standard', verified: true },
  { userId: 'bot_study-buddy', displayName: 'StudyBuddy', description: 'Your personal tutor. I explain math, science, history, and help with homework.', category: 'education', trustScore: 890, passportId: 'ET-STUDY-001', clearanceLevel: 'Verified', verified: true },
  { userId: 'bot_support-ai', displayName: 'SupportAgent', description: 'Customer service AI. I help resolve issues, track orders, and answer FAQs.', category: 'customer-service', trustScore: 650, passportId: 'ET-SUPP-001', clearanceLevel: 'Standard', verified: true },
];

export default function DiscoverPage({ onNavigateToChat }: { onNavigateToChat: (roomId?: string) => void }) {
  const [agents, setAgents] = useState<Agent[]>(DEMO_AGENTS);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [trustFilter, setTrustFilter] = useState('any');
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(false);

  // Try to load real agents from the directory/presence API
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const token = localStorage.getItem('windy_jwt');
        const res = await fetch(`${env.directoryUrl}/search?q=bot_&limit=50`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const data = await res.json();
          if (data.results?.length > 0) {
            setAgents(data.results.map((r: any) => ({
              userId: r.userId,
              displayName: r.displayName,
              description: r.bio || '',
              category: r.category || 'assistant',
              trustScore: r.trustScore,
              passportId: r.passportId,
              clearanceLevel: r.clearanceLevel,
              verified: r.verified || false,
            })));
          }
        }
      } catch { /* use demo agents */ }
      setLoading(false);
    })();
  }, []);

  const filtered = agents.filter(a => {
    if (search && !a.displayName.toLowerCase().includes(search.toLowerCase()) &&
        !a.description?.toLowerCase().includes(search.toLowerCase())) return false;
    if (category !== 'all' && a.category !== category) return false;
    if (trustFilter === '800' && (a.trustScore || 0) < 800) return false;
    if (trustFilter === '600' && (a.trustScore || 0) < 600) return false;
    return true;
  });

  const handleMessage = useCallback((_agent: Agent) => {
    setSelectedAgent(null);
    // In a real app, this would create/find a DM room and navigate to it
    onNavigateToChat();
  }, [onNavigateToChat]);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-6 py-5 border-b" style={{ borderColor: 'var(--bg-tertiary)' }}>
        <div className="flex items-center gap-3 mb-4">
          <span className="text-2xl">🪰</span>
          <div>
            <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Discover Agents</h1>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Eternitas-verified AI agents you can chat with
            </p>
          </div>
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search agents..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full px-4 py-2.5 rounded-xl text-sm outline-none mb-3"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
        />

        {/* Filters */}
        <div className="flex gap-2 flex-wrap">
          {/* Category pills */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all"
                style={{
                  background: category === c.id ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: category === c.id ? 'white' : 'var(--text-secondary)',
                }}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* Trust filter */}
          <select
            value={trustFilter}
            onChange={e => setTrustFilter(e.target.value)}
            className="px-3 py-1.5 rounded-full text-xs outline-none"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
          >
            {TRUST_FILTERS.map(f => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Agent Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>Loading agents...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-3xl mb-3">🔍</div>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No agents match your filters</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(agent => (
              <div
                key={agent.userId}
                className="rounded-xl p-5 transition-all cursor-pointer"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--bg-tertiary)' }}
                onClick={() => setSelectedAgent(agent)}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--bg-tertiary)')}
              >
                {/* Agent header */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-12 h-12 rounded-full flex items-center justify-center text-xl shrink-0"
                       style={{ background: 'var(--agent-bg)', border: '1px solid var(--accent)' }}>
                    🪰
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                      {agent.displayName}
                    </h3>
                    <TrustBadge score={agent.trustScore} passportId={agent.passportId} />
                  </div>
                </div>

                {/* Description */}
                <p className="text-xs leading-relaxed mb-4 line-clamp-3" style={{ color: 'var(--text-secondary)' }}>
                  {agent.description || 'No description available'}
                </p>

                {/* Category + action */}
                <div className="flex items-center justify-between">
                  {agent.category && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                      {agent.category}
                    </span>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); handleMessage(agent); }}
                    className="px-4 py-1.5 rounded-lg text-xs font-medium"
                    style={{ background: 'var(--accent)', color: 'white' }}
                  >
                    💬 Chat
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent Profile Modal */}
      {selectedAgent && (
        <AgentProfileModal
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          onMessage={() => handleMessage(selectedAgent)}
        />
      )}
    </div>
  );
}
