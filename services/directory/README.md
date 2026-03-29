# Windy Chat — Contact Discovery Service

**DNA Strand K3**: Contact Discovery

Privacy-first contact discovery for Windy Chat. Signal-style hash matching ensures raw phone numbers never leave the user's device.

## How It Works

```
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│  User's Phone  │     │  This Service  │     │  Hash Table    │
│                │     │  (port 8102)   │     │  (directory)   │
│  Contacts:     │     │                │     │                │
│  +15551234567  │──▶  │  Receives      │──▶  │  Compare hash  │
│  +15559876543  │  ①  │  SHA256 hashes │  ②  │  against known │
│                │     │  ONLY          │     │  user hashes   │
└────────────────┘     └────────┬───────┘     └────────────────┘
                                │ ③
                                ▼
                       Return matches:
                       hash → display name + avatar
                       (NO phone numbers returned)
```

## API Reference

### Hash Lookup (K3.1)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/chat/directory/salt` | Get current hashing salt |
| POST | `/api/v1/chat/directory/lookup` | Batch hash lookup (max 1000) |
| POST | `/api/v1/chat/directory/register-hash` | Register user's hashed identifiers |
| GET | `/api/v1/chat/directory/stats` | Directory statistics |

### Search & Invite (K3.2)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/chat/directory/register` | Register user in searchable directory |
| GET | `/api/v1/chat/directory/search?q=name` | Fuzzy name / exact email / phone search |
| POST | `/api/v1/chat/directory/invite` | Send SMS/email invite to non-users |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8102 | Service port |
| `TWILIO_ACCOUNT_SID` | — | For SMS invites |
| `TWILIO_AUTH_TOKEN` | — | For SMS invites |
| `TWILIO_PHONE_NUMBER` | — | SMS sender number |
| `SENDGRID_API_KEY` | — | For email invites |

## Running

```bash
cd services/chat-directory
npm install
npm start
```

## Dependencies

- **K1** (Synapse homeserver) — user identity
- **K2** (Onboarding) — verified accounts
