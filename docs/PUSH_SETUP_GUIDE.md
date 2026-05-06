# Push Notification Setup Guide

Step-by-step instructions for configuring FCM (Android), APNs (iOS), and Web Push (VAPID) for Windy Chat.

---

## 1. Firebase Cloud Messaging (FCM) — Android

### Get Firebase Service Account JSON

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project (or create one: "Windy Chat")
3. Go to **Project Settings** (gear icon) → **Service accounts**
4. Click **Generate new private key** → download the JSON file
5. Save it to your server, e.g., `/opt/windy-chat/credentials/firebase-sa.json`

### Configure

```bash
# In .env
FIREBASE_SERVICE_ACCOUNT=/opt/windy-chat/credentials/firebase-sa.json
```

### Verify

```bash
# Health check shows FCM as active
curl -s http://localhost:8103/health | jq '.dependencies.fcm'
# Expected: "active"

# Send a test push
curl -X POST http://localhost:8103/api/v1/chat/push/test \
  -H "Authorization: Bearer $CHAT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pushkey": "FCM_DEVICE_TOKEN", "platform": "android", "title": "Test", "body": "Hello from Windy Chat"}'
```

---

## 2. Apple Push Notification Service (APNs) — iOS

### Get APNs .p8 Key

1. Go to [Apple Developer](https://developer.apple.com/account/)
2. Navigate to **Certificates, Identifiers & Profiles** → **Keys**
3. Click **+** to create a new key
4. Check **Apple Push Notifications service (APNs)**
5. Download the `.p8` key file
6. Note the **Key ID** (10-character string)
7. Note your **Team ID** (from Account → Membership)

### Configure

```bash
# In .env
APNS_KEY_PATH=/opt/windy-chat/credentials/AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=XXXXXXXXXX       # 10-char key ID from step 6
APNS_TEAM_ID=YYYYYYYYYY      # Team ID from step 7
APNS_BUNDLE_ID=com.windypro.chat
```

### Verify

```bash
curl -s http://localhost:8103/health | jq '.dependencies.apns'
# Expected: "active"

curl -X POST http://localhost:8103/api/v1/chat/push/test \
  -H "Authorization: Bearer $CHAT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pushkey": "APNS_DEVICE_TOKEN", "platform": "ios", "title": "Test", "body": "Hello from Windy Chat"}'
```

---

## 3. Web Push (VAPID) — Browser

### Generate VAPID Keys

```bash
npx web-push generate-vapid-keys
```

This outputs a public key and private key (Base64-encoded).

### Configure

```bash
# In .env
VAPID_PUBLIC_KEY=BEl62i...    # The public key from above
VAPID_PRIVATE_KEY=UGko8p...   # The private key from above
VAPID_SUBJECT=mailto:admin@windychat.ai
```

### Client-Side Subscription

The web app subscribes using the public key:

```javascript
// Get VAPID public key from server
const res = await fetch('/api/v1/chat/push/vapid-key');
const { publicKey } = await res.json();

// Subscribe to push
const registration = await navigator.serviceWorker.ready;
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: publicKey,
});

// Register subscription with push gateway
await fetch('/api/v1/chat/push/register', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pushkey: JSON.stringify(subscription),
    userId: userId,
    platform: 'web',
    appId: 'com.windypro.chat.web',
    deviceName: navigator.userAgent.slice(0, 50),
  }),
});
```

### Verify

```bash
curl -s http://localhost:8103/health | jq '.dependencies.webPush'
# Expected: "active"

curl -s http://localhost:8103/api/v1/chat/push/vapid-key
# Expected: { "publicKey": "BEl62i..." }
```

---

## 4. Test Push Endpoint

The push gateway exposes an admin-only test endpoint:

```bash
POST /api/v1/chat/push/test
Authorization: Bearer $CHAT_API_TOKEN

{
  "pushkey": "<device token or subscription JSON>",
  "platform": "android" | "ios" | "web",
  "title": "Test Notification",
  "body": "Hello from Windy Chat!"
}
```

Response: `{ "success": true, "platform": "android" }`

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| FCM: "FIREBASE_SERVICE_ACCOUNT not set" | Check file path exists and is readable |
| APNs: "APNs not configured" | Verify all 3 env vars: KEY_PATH, KEY_ID, TEAM_ID |
| Web Push: 410 Gone | Subscription expired — client needs to re-subscribe |
| Health shows "stubbed" | Credentials not loaded — check env vars |
| Push sent but not received | Check device token is current, app has notification permission |
