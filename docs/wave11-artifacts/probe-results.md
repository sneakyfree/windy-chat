# Wave 11 Probe Results
Run at 2026-04-18T23:16:52Z

## 1. Health
=== port 8101 /health ===
```
{"service":"windy-chat-onboarding","status":"ok","version":"1.0.0","uptime":"1m 57s","uptimeMs":117181,"timestamp":"2026-04-18T23:16:52.898Z","dependencies":{"synapse":false,"redis":"in-memory fallback","twilio":false,"sendgrid":false}}
HTTP 200
```

=== port 8102 /health ===
```
{"service":"windy-chat-directory","status":"ok","version":"1.0.0","uptime":"1m 59s","uptimeMs":119086,"timestamp":"2026-04-18T23:16:52.923Z","dependencies":{"twilio":false,"sendgrid":false,"trust_client":{"local_hits":0,"local_misses":0,"upstream_hits":0,"upstream_misses":0,"fetch_errors":0,"not_found":0,"rate_limited":0,"local_hit_rate":null,"upstream_hit_rate":null,"total_requests":0}}}
HTTP 200
```

=== port 8103 /health ===
```
{"service":"windy-chat-push-gateway","status":"ok","version":"1.0.0","uptime":"2m 0s","uptimeMs":120014,"timestamp":"2026-04-18T23:16:52.967Z","dependencies":{"fcm":"stubbed","apns":"stubbed","webPush":"stubbed","registeredTokens":0,"activeMutes":0}}
HTTP 200
```

=== port 8104 /health ===
```
{"service":"windy-chat-backup","status":"ok","version":"1.0.0","uptime":"1m 59s","uptimeMs":119019,"timestamp":"2026-04-18T23:16:52.991Z","dependencies":{"storage":"stub","registeredUsers":0}}
HTTP 200
```

## 2. /api/v1/onboarding/unified-login
=== unified-login (no jwt) ===
```
{"error":"Missing Authorization header"}
HTTP 401
```

=== unified-login (valid jwt) ===
```
{"matrix_user_id":"@windy_owner:chat.windywave11.local","access_token":"dev_token_142b2534-a377-4d27-9596-948bb4de9321","home_server":"chat.windywave11.local","display_name":"Owner","already_existed":false,"windy_identity_id":"wave11-owner","chat_user_id":"windy_owner","room_id":null,"seeded_agent_rooms":[]}
HTTP 201
```

=== unified-login (replay — should say already_existed) ===
```
{"matrix_user_id":"@windy_owner:chat.windywave11.local","access_token":null,"home_server":"chat.windywave11.local","display_name":"Owner","already_existed":true,"windy_identity_id":"wave11-owner","chat_user_id":"windy_owner"}
HTTP 200
```

## 3. /api/v1/push/notify
=== push missing bus token ===
```
{"error":"Invalid push bus token"}
HTTP 401
```

=== push wrong bus token ===
```
{"error":"Invalid push bus token"}
HTTP 401
```

=== register android device ===
```
{"success":true}
HTTP 201
```

=== register ios device ===
```
{"success":true}
HTTP 201
```

=== register web device ===
```
{"success":true}
HTTP 201
```

=== push agent.hatched (valid) ===
```
{"delivered":3,"rejected":[],"event_type":"agent.hatched"}
HTTP 200
```

=== push chat.new_message (valid) ===
```
{"delivered":3,"rejected":[],"event_type":"chat.new_message"}
HTTP 200
```

=== push mail.inbound (cross-service) ===
```
{"delivered":3,"rejected":[],"event_type":"mail.inbound"}
HTTP 200
```

=== push cloud.quota_warn (cross-service) ===
```
{"delivered":3,"rejected":[],"event_type":"cloud.quota_warn"}
HTTP 200
```

=== push passport.trust_changed (cross-service) ===
```
{"delivered":3,"rejected":[],"event_type":"passport.trust_changed"}
HTTP 200
```

=== push unknown event (future-proof) ===
```
{"delivered":3,"rejected":[],"event_type":"fly.task_completed"}
HTTP 200
```

=== push agent.hatched without title (default-fill) ===
```
{"delivered":3,"rejected":[],"event_type":"agent.hatched"}
HTTP 200
```

=== push chat.* without title (strict) ===
```
{"error":"title is required"}
HTTP 400
```

## 4. /api/v1/webhooks/identity/created
=== identity webhook missing sig ===
```
{"error":"Missing signature header"}
HTTP 401
```

=== identity webhook wrong sig ===
```
{"error":"Invalid webhook signature"}
HTTP 401
```

=== agent hatches BEFORE owner first-login ===
```
{"matrix_user_id":"@agent_et26-defer-11:chat.windywave11.local","access_token":"dev_token_826e1b1b-3940-43","dm_room_id":null,"agent_name":"DeferredFly","passport_number":"ET26-DEFER-11","welcome_pending":true}
HTTP 201
```

=== identity webhook correct sig → should seed agent DM ===
```
{"matrix_user_id":"@defer.owner:chat.windywave11.local","status":"provisioned","display_name":"Defer Owner","seeded_agent_rooms":[{"agent_matrix_id":"@agent_et26-defer-11:chat.windywave11.local","room_id":"!dev_dm_44cc0f8f:chat.windywave11.local","agent_name":"DeferredFly","message":"Hi Defer Owner, I'm your agent. I just hatched at 07:16 PM. My passport is ET26-DEFER-11. What do you want me to help with first?"}]}
HTTP 200
```

=== identity webhook replay → already_existed ===
```
{"matrix_user_id":"@defer.owner:chat.windywave11.local","status":"already_existed","display_name":"Defer Owner"}
HTTP 200
```

## 5. Directory trust gates
=== gate dm (human, no passport → bypass) ===
```
{"allowed":true,"caller":"human","gate":"dm"}
HTTP 200
```

=== gate dm (bot, Eternitas unreachable) ===
```
{"error":"recipient_passport is required"}
HTTP 400
```

=== gate broadcast (bot) ===
```
{"allowed":false,"gate":"broadcast","sender":"ET-EVIL-001","ok":false,"reason":"trust_api_unreachable"}
HTTP 403
```

=== gate mention (bot → stranger) ===
```
{"error":"is_connected (boolean) is required"}
HTTP 400
```

## 6. /api/v1/chat/agent-room lookup
=== agent-room lookup after identity/created seeded ===
```
{"agent_user_id":"@agent_et26-defer-11:chat.windywave11.local","owner_user_id":"wave11-deferred","room_id":"!dev_dm_44cc0f8f:chat.windywave11.local","agent_name":"DeferredFly","created_at":"2026-04-18T23:16:54.066Z"}
HTTP 200
```


