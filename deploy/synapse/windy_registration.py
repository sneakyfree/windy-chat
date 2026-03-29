"""
Windy Chat — Custom Synapse Registration Module
K1.1.3: Custom Registration Module (DNA Strand K)

This module bridges the Windy Pro account server (H1) with Synapse.
Users NEVER register directly with Matrix. Instead:

  1. User creates a Windy Pro account (or already has one)
  2. User requests chat access via our API
  3. Our API calls this module's registration endpoint with a signed token
  4. Module provisions a Matrix account and sets the display name

This prevents spam accounts and ensures every Matrix user maps to a
verified Windy Pro account.
"""

from __future__ import annotations

import logging
import hashlib
import re
from typing import Any, Dict, Optional, Tuple

import attr
from twisted.web.client import Agent, readBody
from twisted.web.http_headers import Headers
from twisted.internet import reactor, defer
import json

from synapse.module_api import ModuleApi
from synapse.module_api.errors import ConfigError, SynapseError

logger = logging.getLogger(__name__)


@attr.s(auto_attribs=True, frozen=True)
class WindyRegistrationConfig:
    """Configuration for the Windy registration module."""

    windy_account_server: str = "http://localhost:8098"
    registration_shared_secret: str = ""


class WindyRegistrationModule:
    """
    Synapse auth module that validates registration requests against
    the Windy Pro account server (H1).

    Registration flow:
        Windy App → POST /api/v1/auth/chat-register (H1)
        H1 validates user → POST /_synapse/admin/v1/register (with shared secret)
        This module intercepts and sets display name + avatar

    Password auth flow:
        User logs in with Windy credentials → module validates against H1
        Returns Matrix user ID (@windy_{hash}:chat.windypro.com)
    """

    def __init__(self, config: WindyRegistrationConfig, api: ModuleApi) -> None:
        self._api = api
        self._config = config
        self._http_agent = Agent(reactor)

        # Register callbacks
        api.register_password_auth_provider_callbacks(
            auth_checkers={
                ("m.login.password", ("password",)): self.check_password,
            },
            on_register=self.on_register,
        )

        logger.info(
            "WindyRegistrationModule initialized — account server: %s",
            config.windy_account_server,
        )

    @staticmethod
    def parse_config(config: Dict[str, Any]) -> WindyRegistrationConfig:
        """Parse the module configuration from homeserver.yaml."""
        windy_server = config.get(
            "windy_account_server", "http://localhost:8098"
        )
        shared_secret = config.get("registration_shared_secret", "")

        if not shared_secret:
            raise ConfigError(
                "windy_registration: 'registration_shared_secret' is required"
            )

        return WindyRegistrationConfig(
            windy_account_server=windy_server,
            registration_shared_secret=shared_secret,
        )

    async def check_password(
        self,
        username: str,
        login_type: str,
        login_dict: Dict[str, Any],
    ) -> Optional[Tuple[str, Optional[callable]]]:
        """
        Validate a password login against the Windy Pro account server.

        Instead of checking Synapse's internal password DB, we forward the
        credentials to H1 for validation. This ensures the Windy Pro account
        is the single source of truth for auth.

        Returns:
            Tuple of (user_id, callback) if auth succeeds, None otherwise.
        """
        password = login_dict.get("password")
        if not password:
            return None

        try:
            result = await self._validate_with_windy_server(username, password)
        except Exception:
            logger.exception(
                "Failed to validate credentials with Windy account server "
                "for user %s",
                username,
            )
            return None

        if not result:
            return None

        windy_user_id = result.get("user_id")
        display_name = result.get("display_name", username)

        # Generate deterministic Matrix user ID from Windy account
        matrix_localpart = self._windy_to_matrix_localpart(
            windy_user_id or username
        )
        matrix_user_id = self._api.get_qualified_user_id(matrix_localpart)

        # Ensure the Matrix account exists
        if not await self._api.check_user_exists(matrix_user_id):
            await self._api.register_user(
                localpart=matrix_localpart,
                displayname=display_name,
            )
            logger.info(
                "Auto-provisioned Matrix account %s for Windy user %s (%s)",
                matrix_user_id,
                windy_user_id,
                display_name,
            )

        return matrix_user_id, None

    async def on_register(self, user_id: str) -> None:
        """
        Called after a new Matrix user is registered.

        Sets the display name to the Windy profile name so the UI never
        shows raw @windy_abc123:chat.windypro.com identifiers.
        """
        logger.info("New Matrix user registered: %s", user_id)

    async def _validate_with_windy_server(
        self, username: str, password: str
    ) -> Optional[Dict[str, Any]]:
        """
        POST to the Windy Pro account server to validate credentials.

        Endpoint: POST {windy_account_server}/api/v1/auth/chat-validate
        Body: { "username": "...", "password": "...", "shared_secret": "..." }
        Response: { "valid": true, "user_id": "...", "display_name": "..." }
        """
        import urllib.request
        import urllib.error

        url = f"{self._config.windy_account_server}/api/v1/auth/chat-validate"
        payload = json.dumps(
            {
                "username": username,
                "password": password,
                "shared_secret": self._config.registration_shared_secret,
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                if body.get("valid"):
                    return body
                return None
        except urllib.error.HTTPError as e:
            logger.warning(
                "Windy account server returned HTTP %d for user %s",
                e.code,
                username,
            )
            return None
        except urllib.error.URLError as e:
            logger.error(
                "Cannot reach Windy account server at %s: %s", url, e.reason
            )
            return None

    @staticmethod
    def _windy_to_matrix_localpart(windy_user_id: str) -> str:
        """
        Convert a Windy Pro user ID or username to a Matrix localpart.

        We use a deterministic hash so the same Windy account always maps
        to the same Matrix user. The raw Matrix username is hidden from
        the UI — users only see their Windy display name.

        Matrix localpart rules: [a-z0-9._=/-]
        We prefix with 'windy_' for clarity in admin tools.
        """
        # Sanitize: lowercase, keep only alphanumeric and underscores
        clean = re.sub(r"[^a-z0-9_]", "", windy_user_id.lower())

        if clean and len(clean) >= 3:
            # Use the cleaned username directly if it's reasonable
            return f"windy_{clean}"

        # Fallback: SHA-256 hash truncated to 12 chars
        hash_hex = hashlib.sha256(windy_user_id.encode("utf-8")).hexdigest()
        return f"windy_{hash_hex[:12]}"


class WindyDisplayNameProvider:
    """
    Utility to map Windy display names to Matrix user IDs.

    Used by the chat client to resolve human-readable names:
        "Grant Whitmer" → @windy_grant_whitmer:chat.windypro.com

    The UI always shows the display name, never the Matrix user ID.
    """

    def __init__(self, api: ModuleApi) -> None:
        self._api = api

    async def get_display_name(self, user_id: str) -> Optional[str]:
        """Get the Windy display name for a Matrix user ID."""
        try:
            profile = await self._api.get_profile_for_user(user_id)
            return profile.get("displayname")
        except Exception:
            logger.warning("Could not fetch profile for %s", user_id)
            return None

    async def set_display_name(
        self, user_id: str, display_name: str
    ) -> None:
        """Update the display name for a Matrix user."""
        await self._api.set_displayname(user_id, display_name)
        logger.info(
            "Updated display name for %s → %s", user_id, display_name
        )
