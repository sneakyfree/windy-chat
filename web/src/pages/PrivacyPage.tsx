export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto py-8 px-6" style={{ color: 'var(--text-primary)' }}>
      <h1 className="text-2xl font-bold mb-6">Privacy Policy</h1>
      <p className="text-xs mb-8" style={{ color: 'var(--text-muted)' }}>Last updated: April 2026</p>

      <div className="space-y-6 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>1. Message Privacy</h2>
          <p>Windy Chat uses the Matrix protocol with end-to-end encryption (E2E). When E2E is enabled for a room, message content is encrypted on your device before transmission. The server cannot read encrypted message content.</p>
          <p className="mt-2">Unencrypted rooms (group chats where E2E is not enabled) store message content on the server. We do not sell or share message content with third parties.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>2. Metadata</h2>
          <p>We store metadata necessary for message delivery: sender, recipient, timestamp, room membership, and read receipts. This metadata is required for the service to function and is not shared with third parties except as required by law.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>3. Social Posts</h2>
          <p>Posts on the social feed are <strong>public by default</strong>. You can set post visibility to "followers only" or "private" when creating a post. Public posts may be indexed and are visible to all users.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>4. AI Agent Interactions</h2>
          <p>When you chat with an AI agent (Windy Fly), your messages may be processed by large language model (LLM) providers to generate responses. Agent operators are bound by the Eternitas platform terms, which require responsible data handling.</p>
          <p className="mt-2">Agent interactions are logged for quality and safety purposes. You can request deletion of your agent conversation history.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>5. Encrypted Backups</h2>
          <p>Chat backups are encrypted on your device using a password you set. The server stores only the encrypted blob and cannot decrypt it. This is zero-knowledge encryption (AES-256-GCM with PBKDF2 key derivation).</p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>6. Push Notifications</h2>
          <p>Push notifications contain only the sender name and "New message" — never the message content. This protects your privacy even if your lock screen is visible.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>7. Contact Discovery</h2>
          <p>Contact discovery uses privacy-preserving SHA-256 hashing. Your phone contacts are hashed on your device before being sent to the server. Raw phone numbers never leave your device.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>8. Data Deletion</h2>
          <p>You can delete your account at any time via Settings. This deactivates your Matrix account, removes your profile, and fires a deletion webhook to connected services. Encrypted backups are retained for 30 days then permanently deleted.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>9. Contact</h2>
          <p>For privacy inquiries: <a href="mailto:privacy@windychat.ai" style={{ color: 'var(--accent)' }}>privacy@windychat.ai</a></p>
        </section>
      </div>
    </div>
  );
}
