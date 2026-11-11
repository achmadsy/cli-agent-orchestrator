from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient
from app import client, config, main


def setup_target(monkeypatch, terminals=None):
    monkeypatch.setattr(config, 'NODE_TOKEN', 'dummy secret')
    seen = []

    async def detail(c, base, session):
        seen.append(session)
        return {'terminals': terminals if terminals is not None else [
            {'id': 'abcd1234', 'tmux_session': 'cao-demo'},
            {'id': 'ffffffff', 'tmux_session': 'cao-demo'},
        ]}

    monkeypatch.setattr(client, 'get_session', detail)
    return TestClient(main.app), seen


def test_exact_registered_target_redirect(monkeypatch):
    tc, seen = setup_target(monkeypatch)
    r = tc.get('/api/machines/node-a/open?session=cao-demo', follow_redirects=False)
    assert r.status_code == 303
    url = urlsplit(r.headers['location'])
    assert url.scheme == 'https' and url.netloc == 'cao-node-a.zlink.my.id'
    assert parse_qs(url.query) == {'terminal_session': ['cao-demo'], 'terminal_id': ['abcd1234']}
    assert parse_qs(url.fragment) == {'token': ['dummy secret']}
    assert 'token=' not in url.query
    assert r.headers['cache-control'] == 'no-store, no-cache'
    assert r.headers['pragma'] == 'no-cache'
    assert seen == ['cao-demo']


def test_machine_only_open_does_not_lookup_session(monkeypatch):
    tc, seen = setup_target(monkeypatch)
    r = tc.get('/api/machines/node-a/open', follow_redirects=False)
    assert r.headers['location'] == 'https://cao-node-a.zlink.my.id/#token=dummy%20secret'
    assert not seen


@pytest.mark.parametrize('query', ['', '../other', 'https://evil.test', 'cao-a/../../x'])
def test_reject_unsafe_session(monkeypatch, query):
    tc, seen = setup_target(monkeypatch)
    assert tc.get('/api/machines/node-a/open', params={'session': query}).status_code == 400
    assert not seen


@pytest.mark.parametrize('terminals, status', [([], 404), ([{'id': 'abcd1234', 'tmux_session': 'cao-other'}], 502), ([{'id': '../x', 'tmux_session': 'cao-demo'}], 502)])
def test_empty_or_wrong_target_fails_closed(monkeypatch, terminals, status):
    tc, _ = setup_target(monkeypatch, terminals)
    assert tc.get('/api/machines/node-a/open?session=cao-demo').status_code == status


@pytest.mark.parametrize('upstream_status, expected', [(404, 404), (401, 502), (500, 502)])
def test_upstream_failure_is_not_redirected(monkeypatch, upstream_status, expected):
    tc, _ = setup_target(monkeypatch)

    async def fail(*args):
        request = httpx.Request('GET', 'http://node/session')
        raise httpx.HTTPStatusError('failed', request=request, response=httpx.Response(upstream_status, request=request))

    monkeypatch.setattr(client, 'get_session', fail)
    assert tc.get('/api/machines/node-a/open?session=cao-demo').status_code == expected


def test_unknown_machine_or_no_node_token(monkeypatch):
    tc, seen = setup_target(monkeypatch)
    assert tc.get('/api/machines/evil/open?session=cao-demo').status_code == 404
    monkeypatch.setattr(config, 'NODE_TOKEN', None)
    assert tc.get('/api/machines/node-a/open?session=cao-demo').status_code == 503
    assert not seen
