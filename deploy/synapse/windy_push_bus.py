"""
Windy Chat — Synapse Push-Bus Subscriber

Hooks into Synapse's third-party-rules callbacks and publishes every new
room message to the Windy shared notification bus at
`http://push-gateway:8103/api/v1/push/notify`.

This is an ADDITIONAL subscriber — it does NOT reroute or interfere with
Synapse's native Matrix push gateway (`/_matrix/push/v1/notify`), which
continues to deliver device-level FCM/APNs push as normal. The bus call is
made with `subscribers_only: true` so the push-gateway skips its own device
fan-out and only dispatches to cross-service consumers (Mail, Clone, Fly,
Code — currently a no-op until they subscribe).

Why a second path exists at all:
    - Native Matrix push is device-scoped and protocol-locked.
    - The Windy bus is event-scoped and cross-product — it lets Mail show a
      "you have unread chat" badge, Clone learn conversation context, Fly
      surface activity, etc.

Config (homeserver.yaml):

    modules:
      - module: windy_push_bus.WindyPushBusModule
        config:
          push_gateway_url: "http://host.docker.internal:8103"
          push_bus_token: "${PUSH_BUS_TOKEN}"
          include_event_types:
            - m.room.message
            - m.room.encrypted
"""

from __future__ import annotations

import json
import logging
import urllib.request
import urllib.error
from typing import Any, Dict, Iterable, List, Optional, Tuple

import attr

from synapse.module_api import ModuleApi
from synapse.module_api.errors import ConfigError

logger = logging.getLogger(__name__)


@attr.s(auto_attribs=True, frozen=True)
class WindyPushBusConfig:
    push_gateway_url: str = "http://host.docker.internal:8103"
    push_bus_token: str = ""
    include_event_types: Tuple[str, ...] = ("m.room.message", "m.room.encrypted")
    request_timeout_seconds: float = 3.0


class WindyPushBusModule:
    """Additional new-event subscriber that forwards room messages to the
    Windy push bus. Registers via `register_third_party_rules_callbacks`
    with `on_new_event` — Synapse calls this *after* the event has been
    persisted and pushed natively, so we never block the send path."""

    def __init__(self, config: WindyPushBusConfig, api: ModuleApi) -> None:
        self._api = api
        self._config = config

        api.register_third_party_rules_callbacks(
            on_new_event=self.on_new_event,
        )

        logger.info(
            "WindyPushBusModule initialized — gateway=%s include=%s",
            config.push_gateway_url,
            list(config.include_event_types),
        )

    @staticmethod
    def parse_config(config: Dict[str, Any]) -> WindyPushBusConfig:
        token = config.get("push_bus_token", "")
        if not token:
            raise ConfigError("windy_push_bus: 'push_bus_token' is required")
        include = config.get(
            "include_event_types", ["m.room.message", "m.room.encrypted"]
        )
        if not isinstance(include, list) or not all(isinstance(t, str) for t in include):
            raise ConfigError("windy_push_bus: 'include_event_types' must be a list of strings")
        return WindyPushBusConfig(
            push_gateway_url=config.get(
                "push_gateway_url", "http://host.docker.internal:8103"
            ),
            push_bus_token=token,
            include_event_types=tuple(include),
            request_timeout_seconds=float(
                config.get("request_timeout_seconds", 3.0)
            ),
        )

    async def on_new_event(self, event, state_events) -> None:
        """
        Called after Synapse persists a new event. We fire-and-forget a POST
        per recipient to the Windy bus; any error is logged and swallowed so
        we never impact the caller-visible send path.
        """
        try:
            event_type = event.type
            if event_type not in self._config.include_event_types:
                return
            room_id = event.room_id
            sender = event.sender

            recipients = await self._resolve_recipients(room_id, exclude=sender)
            if not recipients:
                return

            title = await self._display_name(sender) or sender
            # Per K6.1.3 privacy invariant (see homeserver.yaml `push.include_content: false`)
            # we never forward message bodies over push. The bus gets only the
            # canned "New message" string; consumers that need content must
            # fetch via an authorized Matrix call.
            body = "New message"
            deep_link = f"windy://chat/{room_id}"

            for recipient_mxid in recipients:
                self._publish(
                    recipient_mxid=recipient_mxid,
                    event_type="chat.new_message",
                    title=title,
                    body=body,
                    deep_link=deep_link,
                )
        except Exception:
            # Never raise — this path is additive and must not break Synapse.
            logger.exception("WindyPushBusModule.on_new_event failed")

    async def _resolve_recipients(
        self, room_id: str, exclude: str
    ) -> List[str]:
        try:
            members = await self._api.get_users_in_room(room_id)
        except Exception:
            logger.exception("Failed to list members for room %s", room_id)
            return []
        return [m for m in members if m != exclude]

    async def _display_name(self, user_id: str) -> Optional[str]:
        try:
            profile = await self._api.get_profile_for_user(user_id)
            return profile.get("displayname")
        except Exception:
            return None

    def _publish(
        self,
        recipient_mxid: str,
        event_type: str,
        title: str,
        body: str,
        deep_link: str,
    ) -> None:
        # Push-gateway accepts the Matrix user id via either the
        # `windy_identity_id` or `user_id` field — whichever was registered on
        # the push token. We send the localpart (between '@' and ':') because
        # Chat registers tokens by localpart.
        localpart = _extract_localpart(recipient_mxid)
        payload = json.dumps(
            {
                "windy_identity_id": localpart,
                "user_id": recipient_mxid,
                "event_type": event_type,
                "title": title,
                "body": body,
                "deep_link": deep_link,
                # Native Matrix push already fanned devices — the bus only
                # needs to notify cross-service subscribers (Mail, Clone, …).
                "subscribers_only": True,
            }
        ).encode("utf-8")

        url = (
            f"{self._config.push_gateway_url.rstrip('/')}"
            f"/api/v1/push/notify"
        )
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Push-Bus-Token": self._config.push_bus_token,
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(
                req, timeout=self._config.request_timeout_seconds
            ) as resp:
                if resp.status >= 400:
                    logger.warning(
                        "Push bus returned %d for recipient %s",
                        resp.status,
                        recipient_mxid,
                    )
        except urllib.error.HTTPError as e:
            logger.warning(
                "Push bus HTTP %d for %s: %s",
                e.code,
                recipient_mxid,
                e.reason,
            )
        except urllib.error.URLError as e:
            logger.warning(
                "Push bus unreachable for %s: %s",
                recipient_mxid,
                e.reason,
            )
        except Exception:
            logger.exception(
                "Push bus publish failed for %s", recipient_mxid
            )


def _extract_localpart(matrix_user_id: str) -> str:
    """Given '@grant.whitmer:chat.windychat.ai' return 'grant.whitmer'."""
    if not matrix_user_id.startswith("@"):
        return matrix_user_id
    rest = matrix_user_id[1:]
    colon = rest.find(":")
    return rest if colon == -1 else rest[:colon]
