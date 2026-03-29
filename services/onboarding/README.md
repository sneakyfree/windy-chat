# Windy Chat — Onboarding Service

**DNA Strand K2**: WhatsApp-Style Onboarding

This service handles the complete chat onboarding pipeline — from identity verification to Matrix account provisioning.

## Onboarding Flow

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  K2.1       │    │  K2.2        │    │  K2.3        │    │  K2.4        │
│  Verify     │───▶│  Profile     │───▶│  QR Pair     │───▶│  Provision   │
│  Phone/     │    │  Display     │    │  Desktop ↔   │    │  Matrix      │
│  Email OTP  │    │  Name + Lang │    │  Mobile      │    │  Account     │
└─────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

## API Reference

### Verification (K2.1)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/chat/verify/send` | Send 6-digit OTP (SMS or email) |
| POST | `/api/v1/chat/verify/check` | Validate OTP, get verification token |
| GET | `/api/v1/chat/verify/status` | Check verification status |

### Profile Setup (K2.2)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/chat/profile/check-name` | Check display name availability |
| POST | `/api/v1/chat/profile/setup` | Create profile (name, languages, avatar) |
| GET | `/api/v1/chat/profile/:userId` | Get user profile |

### QR Pairing (K2.3)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/chat/pair/generate` | Generate QR session (desktop) |
| POST | `/api/v1/chat/pair/confirm` | Confirm pairing (mobile) |
| GET | `/api/v1/chat/pair/status/:id` | Poll pairing status (desktop) |
| DELETE | `/api/v1/chat/pair/session/:id` | Cancel pairing session |

### Provisioning (K2.4)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/chat/provision` | Provision Matrix account |
| GET | `/api/v1/chat/onboarding/status` | Check onboarding completion |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 8101 | Service port |
| `TWILIO_ACCOUNT_SID` | No* | — | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | No* | — | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | No* | — | Twilio sender number |
| `SENDGRID_API_KEY` | No* | — | SendGrid API key |
| `SENDGRID_FROM_EMAIL` | No | noreply@windypro.com | Sender email |
| `SYNAPSE_URL` | No | http://localhost:8008 | Synapse homeserver URL |
| `SYNAPSE_REGISTRATION_SECRET` | No* | — | Synapse admin shared secret |
| `SYNAPSE_SERVER_NAME` | No | chat.windypro.com | Matrix server name |

\* When not configured, the service runs in **dev mode** — OTPs are logged to console and Matrix credentials are stubbed.

## Running

```bash
cd services/chat-onboarding
npm install
npm start              # Production
npm run dev            # Development (auto-restart)
```

## Dependencies

- **K1** (Synapse homeserver) — for Matrix account provisioning
- **H1** (Account server) — for Windy Pro account validation
