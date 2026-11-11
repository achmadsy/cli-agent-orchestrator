import importlib.util
import json
from pathlib import Path

import pytest

PATH = Path(__file__).parents[2] / 'deploy/cao-fleet-ingress.py'
spec = importlib.util.spec_from_file_location('fleet_ingress', PATH)
ingress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingress)


def test_snippet_matches_helper_and_narrow_scope():
    assert PATH.with_name('cao-fleet-attachments.conf').read_text() == ingress.POLICY
    assert '[A-Za-z0-9_-]{24}/attachments$' in ingress.POLICY
    assert ingress.POLICY.count('client_max_body_size 10m;') == 1
    assert 'proxy_pass $cao_fleet_backend;' in ingress.POLICY
    assert 'client_body_timeout 30s;' in ingress.POLICY
    assert 'server_name' not in ingress.POLICY
    assert 'cloudflare' not in PATH.read_text().lower()


def test_registry_validation_and_future_host(monkeypatch, tmp_path):
    path = tmp_path / 'registry.json'
    monkeypatch.setattr(ingress, 'REGISTRY', path)
    path.write_text(json.dumps({'machines': [{'name': 'future-node', 'host': '100.65.0.2'}]}))
    assert ingress.load_machines() == [('future-node', '100.65.0.2', 9889)]
    path.write_text(json.dumps({'machines': [{'name': 'bad;inject', 'host': '100.65.0.2'}]}))
    with pytest.raises(ValueError): ingress.load_machines()
    path.write_text(json.dumps({'machines': [{'name': 'a', 'host': '100.65.0.2'}, {'name': 'b', 'host': '100.65.0.2'}]}))
    with pytest.raises(ValueError, match='unique'): ingress.load_machines()


@pytest.mark.parametrize('old', [None, b'prior policy\n'])
@pytest.mark.parametrize('phase', ['syntax', 'reload', 'postreload'])
def test_transaction_restores_prior_snippet(monkeypatch, tmp_path, old, phase):
    path = tmp_path / 'snippet.conf'
    if old is not None: path.write_bytes(old)
    monkeypatch.setattr(ingress, 'SNIPPET', path)
    monkeypatch.setattr(ingress, 'trusted', lambda p: None)
    monkeypatch.setattr(ingress, 'check_wiring', lambda: None)
    calls = []
    def check():
        calls.append('test')
        if phase == 'syntax' and calls.count('test') == 1: raise RuntimeError('syntax')
    def reload():
        calls.append('reload')
        if phase == 'reload' and calls.count('reload') == 1: raise RuntimeError('reload')
    def policy():
        if phase == 'postreload': raise RuntimeError('postreload')
    monkeypatch.setattr(ingress, 'nginx_test', check)
    monkeypatch.setattr(ingress, 'reload_nginx', reload)
    monkeypatch.setattr(ingress, 'check_policy', policy)
    with pytest.raises(RuntimeError, match='prior snippet restored'): ingress.apply_policy()
    assert (path.read_bytes() if path.exists() else None) == old
    if phase != 'syntax': assert calls.count('reload') == 2


def test_apply_success(monkeypatch, tmp_path):
    path = tmp_path / 'snippet.conf'
    monkeypatch.setattr(ingress, 'SNIPPET', path)
    monkeypatch.setattr(ingress, 'trusted', lambda p: None)
    monkeypatch.setattr(ingress, 'check_wiring', lambda: None)
    calls = []
    monkeypatch.setattr(ingress, 'nginx_test', lambda: calls.append('test'))
    monkeypatch.setattr(ingress, 'reload_nginx', lambda: calls.append('reload'))
    monkeypatch.setattr(ingress, 'check_policy', lambda: calls.append('policy'))
    ingress.apply_policy()
    assert path.read_text() == ingress.POLICY
    assert calls == ['test', 'reload', 'policy']


def test_live_probe_only_registered_hosts_and_exact_checks(monkeypatch):
    calls = []
    monkeypatch.setattr(ingress, 'check_policy', lambda: None)
    def probe(host, path, size, body):
        calls.append((host, path, size, body))
        return (401, 'application/json') if len(calls) == 1 else (413, 'text/html')
    monkeypatch.setattr(ingress, 'ingress_request', probe)
    ingress.verify_ingress('future-node', [('future-node','100.65.0.2',9889)])
    assert len(calls) == 3
    assert all(c[0] == 'cao-future-node.zlink.my.id' for c in calls)
    assert calls[0][1] == '/terminal/v/' + 'x' * 24 + '/attachments'
    assert calls[0][2:] == (2*1024*1024, False)
    assert calls[1][2:] == (10*1024*1024+1, False)
    assert calls[2][1:] == ('/terminal/viewers', 2*1024*1024, False)
    with pytest.raises(ValueError): ingress.verify_ingress('unknown', [])


@pytest.mark.parametrize('responses', [[(413,'text/html')],[(401,'application/json'),(200,'application/json')],[(401,'application/json'),(413,'text/html'),(401,'application/json')]])
def test_probe_requires_every_boundary(monkeypatch, responses):
    monkeypatch.setattr(ingress, 'check_policy', lambda: None)
    values = iter(responses)
    clock = iter([0, 9])
    monkeypatch.setattr(ingress.time, 'monotonic', lambda: next(clock))
    monkeypatch.setattr(ingress, 'ingress_request', lambda *a: next(values))
    with pytest.raises(RuntimeError): ingress.verify_ingress('worker',[('worker','100.65.0.2',9889)])


def test_reload_transition_retries_only_old413(monkeypatch):
    monkeypatch.setattr(ingress, 'check_policy', lambda: None)
    monkeypatch.setattr(ingress.time, 'sleep', lambda *a: None)
    responses = iter([(413,'text/html'), (401,'application/json'), (413,'text/html'), (413,'text/html')])
    calls = []
    def probe(*args):
        calls.append(args)
        return next(responses)
    monkeypatch.setattr(ingress, 'ingress_request', probe)
    ingress.verify_ingress('worker',[('worker','100.65.0.2',9889)])
    assert len(calls) == 4 and all(not call[3] for call in calls)


def test_companion_cli_cannot_request_dns():
    with pytest.raises(SystemExit) as error: ingress.main(['--sync-dns'])
    assert error.value.code == 2
