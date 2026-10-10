"""Session signing, password validation, CSRF tokens, and rate limiting."""
import hmac
import secrets
import time
from dataclasses import dataclass
from hashlib import sha256

COOKIE_NAME = "cao_panel_session"
DEFAULT_USER = "panel"
DEFAULT_TTL = 43200


@dataclass
class Session:
    user: str
    expires_at: int
    csrf: str


class LoginThrottler:
    """Sliding-window rate limiter for failed login attempts."""

    def __init__(self, max_failures=5, window_seconds=300):
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self.failures = {}

    def is_blocked(self, client_ip):
        now = time.time()
        records = [ts for ts in self.failures.get(client_ip, []) if now - ts < self.window_seconds]
        if records:
            self.failures[client_ip] = records
        else:
            self.failures.pop(client_ip, None)
        return len(records) >= self.max_failures

    def record_failure(self, client_ip):
        now = time.time()
        records = [ts for ts in self.failures.get(client_ip, []) if now - ts < self.window_seconds]
        records.append(now)
        self.failures[client_ip] = records

    def reset(self, client_ip):
        self.failures.pop(client_ip, None)


def _signature(secret, user, expires_at, csrf):
    message = f"v1|{user}|{expires_at}|{csrf}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, sha256).hexdigest()


def create_session(secret, user, ttl_seconds=DEFAULT_TTL):
    expires_at = int(time.time()) + int(ttl_seconds)
    csrf = secrets.token_hex(16)
    sig = _signature(secret, user, expires_at, csrf)
    raw = f"v1.{user}.{expires_at}.{csrf}.{sig}"
    return raw, Session(user=user, expires_at=expires_at, csrf=csrf)


def decode_session(secret, raw):
    if not raw or not secret:
        return None
    parts = raw.split(".")
    if len(parts) != 5 or parts[0] != "v1":
        return None
    _, user, exp_str, csrf, presented_sig = parts
    try:
        expires_at = int(exp_str)
    except ValueError:
        return None
    if time.time() >= expires_at:
        return None
    expected_sig = _signature(secret, user, expires_at, csrf)
    if not hmac.compare_digest(presented_sig, expected_sig):
        return None
    return Session(user=user, expires_at=expires_at, csrf=csrf)


def verify_password(configured_password, presented_password):
    if not configured_password or presented_password is None:
        return False
    return hmac.compare_digest(configured_password, presented_password)


def verify_username(configured_user, presented_user):
    target = configured_user or DEFAULT_USER
    if presented_user is None:
        return False
    return hmac.compare_digest(target, presented_user)
