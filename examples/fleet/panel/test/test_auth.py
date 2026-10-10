from fastapi.testclient import TestClient

from app import auth, config, main


def _configure(monkeypatch):
    monkeypatch.setattr(config, "PANEL_USER", "panel")
    monkeypatch.setattr(config, "PANEL_PASSWORD", "test-password")
    monkeypatch.setattr(config, "PANEL_SESSION_SECRET", "s" * 64)
    monkeypatch.setattr(config, "PANEL_SESSION_TTL", 43200)
    monkeypatch.setattr(config, "PANEL_TOKEN", "automation-token")
    main._login_throttler = auth.LoginThrottler()


def _login(client):
    return client.post(
        "/api/auth/login",
        json={"username": "panel", "password": "test-password"},
    )


def test_login_sets_secure_session_cookie(monkeypatch):
    _configure(monkeypatch)
    client = TestClient(main.app, base_url="https://testserver")
    response = _login(client)
    assert response.status_code == 200
    assert response.json()["authenticated"] is True
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie
    assert "Secure" in cookie
    assert "SameSite=strict" in cookie
    assert "Max-Age=43200" in cookie
    assert "test-password" not in cookie
    assert response.headers["cache-control"] == "no-store, no-cache"


def test_http_login_uses_non_secure_cookie_and_round_trips(monkeypatch):
    _configure(monkeypatch)
    client = TestClient(main.app, base_url="http://testserver")
    response = _login(client)
    assert response.status_code == 200
    assert "Secure" not in response.headers["set-cookie"]
    assert client.get("/api/auth/status").status_code == 200


def test_open_mode_status_allows_frontend_boot(monkeypatch):
    monkeypatch.setattr(config, "PANEL_PASSWORD", None)
    monkeypatch.setattr(config, "PANEL_TOKEN", None)
    client = TestClient(main.app)
    response = client.get("/api/auth/status")
    assert response.status_code == 200
    assert response.json() == {"authenticated": True, "user": "local", "csrf_token": None}


def test_invalid_credentials_are_generic_and_have_no_basic_challenge(monkeypatch):
    _configure(monkeypatch)
    client = TestClient(main.app, base_url="https://testserver")
    wrong_user = client.post(
        "/api/auth/login",
        json={"username": "wrong", "password": "test-password"},
    )
    wrong_password = client.post(
        "/api/auth/login",
        json={"username": "panel", "password": "wrong"},
    )
    assert wrong_user.status_code == wrong_password.status_code == 401
    assert wrong_user.json() == wrong_password.json() == {"detail": "invalid username or password"}
    assert "set-cookie" not in wrong_user.headers
    assert "www-authenticate" not in wrong_user.headers


def test_status_rejects_tampered_and_expired_cookies(monkeypatch):
    _configure(monkeypatch)
    client = TestClient(main.app, base_url="https://testserver")
    raw, _ = auth.create_session(config.PANEL_SESSION_SECRET, "panel", 60)
    client.cookies.set(auth.COOKIE_NAME, raw[:-1] + ("0" if raw[-1] != "0" else "1"))
    assert client.get("/api/auth/status").status_code == 401

    expired, _ = auth.create_session(config.PANEL_SESSION_SECRET, "panel", -1)
    client.cookies.set(auth.COOKIE_NAME, expired)
    assert client.get("/api/auth/status").status_code == 401


def test_cookie_mutation_requires_csrf_and_bearer_does_not(monkeypatch):
    _configure(monkeypatch)
    client = TestClient(main.app, base_url="https://testserver")
    login = _login(client)
    csrf = login.json()["csrf_token"]
    assert client.post("/api/machines/nope/launch", json={}).status_code == 403
    assert client.post(
        "/api/machines/nope/launch",
        json={},
        headers={"X-CSRF-Token": csrf},
    ).status_code == 404

    bearer = TestClient(main.app)
    assert bearer.post(
        "/api/machines/nope/launch",
        json={},
        headers={"Authorization": "Bearer automation-token"},
    ).status_code == 404


def test_logout_expires_cookie(monkeypatch):
    _configure(monkeypatch)
    client = TestClient(main.app, base_url="https://testserver")
    csrf = _login(client).json()["csrf_token"]
    response = client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf})
    assert response.status_code == 200
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert client.get("/api/auth/status").status_code == 401


def test_login_rate_limit(monkeypatch):
    _configure(monkeypatch)
    main._login_throttler = auth.LoginThrottler(max_failures=2, window_seconds=300)
    client = TestClient(main.app, base_url="https://testserver")
    payload = {"username": "panel", "password": "wrong"}
    headers = {"X-Forwarded-For": "100.64.0.9"}
    assert client.post("/api/auth/login", json=payload, headers=headers).status_code == 401
    assert client.post("/api/auth/login", json=payload, headers=headers).status_code == 401
    blocked = client.post("/api/auth/login", json=payload, headers=headers)
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == "300"


def test_session_decoder_rejects_malformed_expiry():
    assert auth.decode_session("secret", "v1.panel.nope.csrf.signature") is None
