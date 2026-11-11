#!/usr/bin/env python3
"""Fleet attachment nginx policy only. Never manages DNS or worker services.

Install root-owned at /usr/local/sbin/cao-fleet-ingress. The existing routing
helper remains independent; new nodes inherit this shared proxy policy.
"""
import argparse
import fcntl
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time

REGISTRY = Path('/home/ubuntu/workspace/cao/cli-agent-orchestrator/examples/fleet/fleet.json')
VHOST = Path('/etc/nginx/sites-available/cao-fleet-nodes')
ENABLED = Path('/etc/nginx/sites-enabled/cao-fleet-nodes')
SNIPPET = Path('/etc/nginx/snippets/cao-fleet-attachments.conf')
LOCK = Path('/run/lock/cao-fleet-ingress.lock')
NAME = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
TAILNET = ipaddress.ip_network('100.64.0.0/10')
READY = 'CAO_FLEET_INGRESS_READY_V1'
CHECKED = 'CAO_FLEET_POLICY_OK_V1'
VERIFIED = 'CAO_FLEET_INGRESS_VERIFIED_V1'
POLICY = '''# Managed Fleet attachment ingress v1; include inside location / only.
# The backend still validates capability, Origin, target, raster and storage.
location ~ "^/terminal/v/[A-Za-z0-9_-]{24}/attachments$" {
    client_max_body_size 10m;
    client_body_timeout 30s;
    proxy_pass $cao_fleet_backend;
}
'''
INCLUDE = '        include /etc/nginx/snippets/cao-fleet-attachments.conf;'


def load_machines():
    if REGISTRY.stat().st_size > 1024 * 1024:
        raise ValueError('registry exceeds bound')
    data = json.loads(REGISTRY.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError('invalid registry')
    machines = data.get('machines')
    if not isinstance(machines, list) or len(machines) > 1000:
        raise ValueError('registry machines must be a bounded array')
    names, hosts, result = set(), set(), []
    for machine in machines:
        if not isinstance(machine, dict):
            raise ValueError('invalid registry machine')
        name = str(machine.get('name', ''))
        host = ipaddress.ip_address(str(machine.get('host', '')))
        port = int(machine.get('port', data.get('port', 9889)))
        if not NAME.fullmatch(name):
            raise ValueError('invalid fleet name')
        if host.version != 4 or host not in TAILNET or not 1 <= port <= 65535:
            raise ValueError('invalid fleet address/port')
        if name in names or host in hosts:
            raise ValueError('fleet names and hosts must be unique')
        names.add(name)
        hosts.add(host)
        result.append((name, str(host), port))
    return result


def trusted(path):
    for part in (path, *path.parents):
        if part.is_symlink():
            raise RuntimeError('symlink in managed routing path')
        if part.exists():
            info = part.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('untrusted managed routing path')
    if path.exists() and not stat.S_ISREG(path.stat().st_mode):
        raise RuntimeError('managed routing target is not a file')


def check_wiring():
    trusted(VHOST)
    # An enabled symlink itself is expected; its directory must be root-controlled.
    for part in (ENABLED.parent, *ENABLED.parent.parents):
        info = part.stat()
        if part.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('untrusted enabled vhost directory')
    if not ENABLED.is_symlink() or ENABLED.resolve() != VHOST:
        raise RuntimeError('unexpected enabled Fleet vhost wiring')
    text = VHOST.read_text()
    anchor = '    location / {\n' + INCLUDE + '\n'
    if text.count(anchor) != 1 or text.count(str(SNIPPET)) != 1:
        raise RuntimeError('managed attachment include missing or misplaced')
    return text


def check_policy():
    check_wiring()
    trusted(SNIPPET)
    if SNIPPET.read_text() != POLICY:
        raise RuntimeError('managed attachment policy is not current')


def atomic(path, data):
    trusted(path)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def nginx_test():
    result = subprocess.run(['/usr/sbin/nginx', '-t'], capture_output=True, timeout=20)
    if result.returncode:
        raise RuntimeError('nginx configuration validation failed')


def reload_nginx():
    subprocess.run(['/usr/bin/systemctl', 'reload', 'nginx'], capture_output=True, check=True, timeout=25)


def apply_policy():
    check_wiring()
    trusted(SNIPPET)
    old = SNIPPET.read_bytes() if SNIPPET.exists() else None
    attempted = False
    try:
        if old != POLICY.encode():
            atomic(SNIPPET, POLICY.encode())
        nginx_test()
        attempted = True
        reload_nginx()
        check_policy()
    except BaseException as failure:
        try:
            if old is None:
                SNIPPET.unlink(missing_ok=True)
            elif SNIPPET.read_bytes() != old:
                atomic(SNIPPET, old)
            if attempted:
                nginx_test()
                reload_nginx()
        except BaseException:
            raise RuntimeError('ingress update failed; configuration restoration incomplete') from None
        raise RuntimeError('ingress update failed; prior snippet restored') from failure


def ingress_request(host, path, size, body):
    class LocalTLS(http.client.HTTPSConnection):
        def connect(self):
            sock = socket.create_connection(('127.0.0.1', 443), self.timeout)
            self.sock = self._context.wrap_socket(sock, server_hostname=host)
    connection = LocalTLS(host, context=ssl.create_default_context(), timeout=12)
    try:
        connection.putrequest('POST', path, skip_host=True)
        for name, value in {'Host': host, 'Origin': 'https://' + host,
                            'Content-Type': 'image/png', 'Content-Length': str(size),
                            'Connection': 'close'}.items():
            connection.putheader(name, value)
        connection.endheaders()
        if body:
            try:
                connection.send(b'x' * size)
            except BrokenPipeError:
                pass  # Early invalid-capability response may stop body upload.
        response = connection.getresponse()
        # Deliberately don't read/log backend body, cookie, token or output.
        return response.status, response.getheader('Content-Type', '')
    finally:
        connection.close()


def verify_ingress(name, machines):
    if not NAME.fullmatch(name) or name not in {row[0] for row in machines}:
        raise ValueError('ingress verification requires a registered Fleet name')
    check_policy()
    host = 'cao-' + name + '.zlink.my.id'
    path = '/terminal/v/' + 'x' * 24 + '/attachments'
    # An invalid capability is rejected from headers before body consumption.
    # Sending megabytes after that early response can reset the TCP connection;
    # Content-Length alone exercises nginx's ingress limit, with no stored data.
    # A graceful reload returns before all workers necessarily adopt the config.
    deadline = time.monotonic() + 8
    while True:
        status, kind = ingress_request(host, path, 2 * 1024 * 1024, False)
        if status != 413 or time.monotonic() >= deadline:
            break
        time.sleep(.25)
    if status != 401 or not kind.startswith('application/json'):
        raise RuntimeError('attachment ingress capability gate status ' + str(status))
    status, _ = ingress_request(host, path, 10 * 1024 * 1024 + 1, False)
    if status != 413:
        raise RuntimeError('attachment ingress upper bound is not enforced')
    status, _ = ingress_request(host, '/terminal/viewers', 2 * 1024 * 1024, False)
    if status != 413:
        raise RuntimeError('ordinary request limit changed')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--apply', action='store_true')
    group.add_argument('--check-policy', action='store_true')
    group.add_argument('--verify-ingress', metavar='REGISTERED_NAME')
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        raise RuntimeError('ingress helper requires configured root invocation')
    if args.check_policy:
        check_policy()
        print(CHECKED)
        return
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('another ingress operation is active')
                time.sleep(.1)
        if args.verify_ingress:
            verify_ingress(args.verify_ingress, load_machines())
            print(VERIFIED)
        else:
            apply_policy()
            print(READY)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        safe = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
        print('Fleet ingress failed: ' + safe[:240], file=sys.stderr)
        sys.exit(1)
