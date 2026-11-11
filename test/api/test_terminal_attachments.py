"""Private attachment lifecycle and gateway tests: no real tmux or user files."""
import io
import os
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from cli_agent_orchestrator.api import terminal_workspace as routes
from cli_agent_orchestrator.services import terminal_workspace_service as service
from cli_agent_orchestrator.services import terminal_attachment_service as images

TARGET = {"session":"cao-test","terminal":"abcdef12","window_id":"@1","pane_id":"%2","mode":"pane","socket":"/tmp/test-socket"}


def png():
    stream=io.BytesIO();Image.new('RGB',(3,4),(10,20,30)).save(stream,format='PNG');return stream.getvalue()


@pytest.fixture
def setup(tmp_path,monkeypatch):
    for key in ('AUTH0_DOMAIN','CAO_AUTH_JWKS_URI','CAO_AUTH_LOCAL_TOKEN'):monkeypatch.delenv(key,raising=False)
    monkeypatch.setattr(routes,'WS_ALLOWED_CLIENTS',['127.0.0.1'])
    monkeypatch.setattr(service,'_viewers',{})
    monkeypatch.setattr(service,'health',AsyncMock())
    monkeypatch.setattr(service,'resolve_target',lambda _:TARGET.copy())
    # Keep the real /proc + private-directory proof; only the tmux PID query
    # maps this synthetic viewer to the current test process.
    monkeypatch.setattr(images,'_pid_output',lambda _:str(os.getpid()))
    store=images.AttachmentStore(tmp_path/'images');monkeypatch.setattr(images,'_store',store)
    app=FastAPI();app.include_router(routes.router)
    client=TestClient(app,base_url='http://localhost',client=('127.0.0.1',42))
    data=client.post('/terminal/viewers',json={'terminal_id':'abcdef12'},headers={'Origin':'http://localhost'}).json()
    return client,data,store


def upload(client,data,body=None,origin='http://localhost',ctype='image/png'):
    headers={'Content-Type':ctype}
    if origin:headers['Origin']=origin
    return client.post(data['url']+'attachments',content=png() if body is None else body,headers=headers)


@pytest.mark.parametrize('scope', ['cao:read', '', 'expired'])
def test_every_attachment_mutation_rechecks_original_write_authority(setup, monkeypatch, scope):
    client, data, store = setup
    ident = upload(client, data).json()['id']
    viewer = service._viewers[data['viewer_id']]
    monkeypatch.setenv('CAO_AUTH_LOCAL_TOKEN', 'fixture-only')
    viewer.auth_enabled = True
    viewer.bearer = 'fixture-only'
    def scopes(_):
        if scope == 'expired':
            raise ValueError('expired fixture')
        return scope.split()
    monkeypatch.setattr(service, 'extract_scopes_from_token', scopes)
    suffix = 'attachments/' + ident
    assert upload(client, data).status_code == 401
    assert client.post(data['url'] + suffix + '/confirm', headers={'Origin':'http://localhost'}).status_code == 401
    assert client.delete(data['url'] + suffix, headers={'Origin':'http://localhost'}).status_code == 401
    assert not store.items[ident].confirmed
    assert len(store.items) == 1


@pytest.mark.parametrize('scope', ['cao:write', 'cao:admin'])
def test_attachment_capability_accepts_valid_write_or_admin(setup, monkeypatch, scope):
    client, data, store = setup
    viewer = service._viewers[data['viewer_id']]
    monkeypatch.setenv('CAO_AUTH_LOCAL_TOKEN', 'fixture-only')
    viewer.auth_enabled = True
    viewer.bearer = 'fixture-only'
    monkeypatch.setattr(service, 'extract_scopes_from_token', lambda _: [scope])
    assert upload(client, data).status_code == 200


def test_upload_confirm_private_no_public_download(setup):
    client,data,store=setup;r=upload(client,data);assert r.status_code==200
    ident=r.json()['id'];assert 'path' not in r.json()
    item=store.items[ident];path=store.root/(ident+'.png')
    assert path.read_bytes()==png();assert path.stat().st_mode&0o777==0o600
    assert client.get(data['url']+'attachments/'+ident).status_code==404
    confirmed=client.post(data['url']+'attachments/'+ident+'/confirm',headers={'Origin':'http://localhost'})
    assert confirmed.status_code==200 and confirmed.json()['path']==str(path)
    assert item.expires>time.time()+86000
    client.delete(data['url']+'attachments/'+ident,headers={'Origin':'http://localhost'})
    assert path.exists() # confirmed consumers can read after viewer close


@pytest.mark.parametrize('origin',[None,'https://evil.example'])
def test_upload_requires_origin(setup,origin):
    client,data,store=setup;assert upload(client,data,origin=origin).status_code==403;assert not store.items


@pytest.mark.parametrize('body,ctype',[(b'<svg/>','image/png'),(b'not an image','image/jpeg'),(b'<html/>','image/svg+xml')])
def test_reject_invalid_images_and_cleanup(setup,body,ctype):
    client,data,store=setup;assert upload(client,data,body,ctype=ctype).status_code in (400,415)
    assert not store.items and not list(store.root.iterdir())


def test_mime_spoof_pixel_limit_and_stream_cap(setup,monkeypatch):
    client,data,store=setup
    assert upload(client,data,ctype='image/jpeg').status_code==400
    monkeypatch.setattr(images,'MAX_PIXELS',2);assert upload(client,data).status_code==400
    monkeypatch.setattr(images,'MAX_IMAGE',8);assert upload(client,data).status_code==413
    assert not store.items and not list(store.root.iterdir())


def test_cross_viewer_wrong_target_and_expiry(setup,monkeypatch):
    client,data,store=setup;ident=upload(client,data).json()['id']
    other=client.post('/terminal/viewers',json={'terminal_id':'abcdef12'},headers={'Origin':'http://localhost'}).json()
    assert client.post(other['url']+'attachments/'+ident+'/confirm',headers={'Origin':'http://localhost'}).status_code==404
    monkeypatch.setattr(service,'resolve_target',lambda _:{**TARGET,'pane_id':'%99'})
    assert client.post(data['url']+'attachments/'+ident+'/confirm',headers={'Origin':'http://localhost'}).status_code==401
    monkeypatch.setattr(service,'resolve_target',lambda _:TARGET.copy())
    store.items[ident].expires=0;store.cleanup();assert ident not in store.items


def test_pending_quota_and_cancel(setup,monkeypatch):
    client,data,store=setup;monkeypatch.setattr(images,'MAX_PENDING',1)
    ident=upload(client,data).json()['id'];assert upload(client,data).status_code==429
    assert client.delete(data['url']+'attachments/'+ident,headers={'Origin':'http://localhost'}).status_code==204
    assert not store.items


def test_root_symlink_and_unsafe_path_rejected(tmp_path):
    root=tmp_path/'actual';root.mkdir();link=tmp_path/'link';link.symlink_to(root,target_is_directory=True)
    with pytest.raises(images.AttachmentError):images.AttachmentStore(link)
    with pytest.raises(images.AttachmentError):images.AttachmentStore(tmp_path/'space path')


def test_store_reloads_confirmed_and_reclaims_pending(setup):
    client,data,store=setup;ident=upload(client,data).json()['id'];store.confirm(ident,service._viewers[data['viewer_id']])
    reloaded=images.AttachmentStore(store.root);assert reloaded.items[ident].confirmed
    reloaded.items[ident].expires=0;reloaded.cleanup();assert not (store.root/(ident+'.png')).exists()


@pytest.mark.parametrize('mutation', ['missing', 'symlink', 'size', 'permissions'])
def test_confirm_rechecks_actual_file(setup, tmp_path, mutation):
    client, data, store = setup
    ident = upload(client, data).json()['id']
    path = store.root / (ident + '.png')
    if mutation == 'missing':
        path.unlink()
    elif mutation == 'symlink':
        other = tmp_path / 'unrelated'
        other.write_bytes(png())
        path.unlink()
        path.symlink_to(other)
    elif mutation == 'size':
        path.write_bytes(b'changed')
    else:
        path.chmod(0o644)
    response = client.post(data['url'] + 'attachments/' + ident + '/confirm', headers={'Origin': 'http://localhost'})
    assert response.status_code == 410
    assert not store.items[ident].confirmed
    if mutation == 'symlink':
        assert other.read_bytes() == png()


def test_reload_removes_only_recognized_owned_orphans(tmp_path):
    root = tmp_path / 'images'
    root.mkdir(mode=0o700)
    for index, ext in enumerate(('part', 'png', 'jpg', 'webp', 'tmp', 'json')):
        path = root / (f'{index:040x}.' + ext)
        path.write_bytes(b'interrupted upload')
        path.chmod(0o600)
    unrelated = root / 'personal.png'
    unrelated.write_bytes(b'keep')
    outside = tmp_path / 'outside'
    outside.write_bytes(b'keep outside')
    link = root / ('f' * 40 + '.png')
    link.symlink_to(outside)
    images.AttachmentStore(root)
    assert set(root.iterdir()) == {unrelated, link}
    assert outside.read_bytes() == b'keep outside'


def test_chunked_stream_limit_ignores_content_length(setup, monkeypatch):
    client, data, store = setup
    monkeypatch.setattr(images, 'MAX_IMAGE', 12)
    def chunks():
        yield b'12345678'
        yield b'abcdefgh'
    response = client.post(data['url'] + 'attachments', content=chunks(), headers={'Origin': 'http://localhost', 'Content-Type': 'image/png'})
    assert response.status_code == 413
    assert not store.items and not list(store.root.iterdir())


def test_decompression_bomb_rejected_and_partial_removed(setup, monkeypatch):
    client, data, store = setup
    monkeypatch.setattr(Image, 'MAX_IMAGE_PIXELS', 1)
    assert upload(client, data).status_code == 400
    assert not store.items and not list(store.root.iterdir())


def test_inflight_uploads_bounded_and_failed_upload_releases_slot(setup):
    client, data, store = setup
    viewer = service._viewers[data['viewer_id']]
    first, fd1 = store.reserve(viewer)
    second, fd2 = store.reserve(viewer)
    try:
        with pytest.raises(images.AttachmentError) as exc:
            store.reserve(viewer)
        assert exc.value.status == 429
        store.discard(first)
        third, fd3 = store.reserve(viewer)
        os.close(fd3)
        store.discard(third)
    finally:
        os.close(fd1)
        os.close(fd2)
        store.discard(first)
        store.discard(second)
    assert not store.items and not store.inflight and not list(store.root.iterdir())


def test_revocation_during_decode_removes_partial(setup, monkeypatch):
    client, data, store = setup
    verify = images.verify_image
    def revoke(*args):
        result = verify(*args)
        service._viewers.pop(data['viewer_id'])
        return result
    monkeypatch.setattr(images, 'verify_image', revoke)
    assert upload(client, data).status_code == 401
    assert not store.items and not list(store.root.iterdir())


def test_target_changes_after_decode_removes_partial(setup,monkeypatch):
    client,data,store=setup;verify=images.verify_image
    def change(*args):
        result=verify(*args);monkeypatch.setattr(service,'resolve_target',lambda _:{**TARGET,'pane_id':'%99'});return result
    monkeypatch.setattr(images,'verify_image',change)
    assert upload(client,data).status_code==401;assert not store.items and not list(store.root.iterdir())
