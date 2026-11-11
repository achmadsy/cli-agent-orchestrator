/* Lease-scoped browser image upload. Preview -> explicit path insertion, no Enter. */
(() => {
  const toolbar = document.querySelector('.quick-actions');
  const chooser = document.createElement('input'); chooser.id = 'cao-image-picker'; chooser.type = 'file'; chooser.accept = 'image/png,image/jpeg,image/webp'; chooser.multiple = true; chooser.hidden = true;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'ek cao-clipboard-button'; button.textContent = 'Attach'; button.setAttribute('aria-label', 'Attach image');
  button.onclick = () => chooser.click(); toolbar.append(button, chooser);
  const base = location.pathname.replace(/\/+$/, '');
  const active = new Set();
  const message = text => window.caoClipboardStatus?.(text);
  const current = () => ({pane: window.tmuxState?.focusedPane, generation: window.tmuxWs?.connectionId?.(), direct:document.getElementById('app').classList.contains('cao-direct-active')});
  const valid = c => c.pane && c.pane === window.tmuxState?.focusedPane && c.generation === window.tmuxWs?.connectionId?.() && c.direct === document.getElementById('app').classList.contains('cao-direct-active') && window.tmuxWs?.isConnected();
  async function request(path, opts) {
    const r = await fetch(base + '/attachments' + path, {...opts,credentials:'same-origin'});
    if (!r.ok) {
      let detail;
      if ((r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'application/json') {
        try {
          const value = (await r.json()).detail;
          if (typeof value === 'string' && value.length <= 512) detail = value;
        } catch {}
      }
      // Never display proxy HTML. A proxy can reject even a valid <=10 MiB
      // image before CAO sees it, so do not mislabel that as a client-size error.
      const fallback = r.status === 413
        ? 'Upload blocked by the server request limit. Images may be up to 10 MiB; the server upload limit needs checking.'
        : `Image request failed (${r.status}). Retry or reopen the terminal.`;
      throw Error(detail || fallback);
    }
    return r.status === 204 ? null : r.json();
  }
  async function attach(file) {
    if (active.size >= 4) { message('Attach up to four pending images.'); return; }
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 10*1024*1024) { message('Use PNG, JPEG or WebP up to 10 MiB.'); return; }
    const c = current(); if (!valid(c)) { message('Connect to the terminal before attaching an image.'); return; }
    const abort = new AbortController(); let ident, closed = false, confirmed = false;
    const dialog = document.createElement('dialog'); dialog.className = 'cao-paste-dialog cao-image-dialog';
    const title = document.createElement('h2'); title.textContent = 'Attach image';
    const preview = document.createElement('img'); const url = URL.createObjectURL(file); preview.src = url; preview.alt = 'Selected image preview';
    const note = document.createElement('p'); note.textContent = 'Uploading…';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
    const insert = document.createElement('button'); insert.textContent = 'Insert path'; insert.disabled = true;
    const retry = document.createElement('button'); retry.textContent = 'Retry upload'; retry.hidden = true;
    const token = {close: () => dialog.close()}; active.add(token);
    dialog.append(title, preview, note, cancel, insert, retry); document.body.append(dialog);
    dialog.addEventListener('close', () => {
      closed = true; abort.abort(); URL.revokeObjectURL(url); active.delete(token); dialog.remove();
      if (ident && !confirmed) request('/'+ident, {method:'DELETE'}).catch(()=>{});
    });
    dialog.showModal();
    insert.onclick = async () => {
      if (!ident || !valid(c)) { note.textContent = 'Target changed. Nothing was inserted.'; insert.disabled = true; return; }
      insert.disabled = true;
      try {
        const info = await request('/'+ident+'/confirm', {method:'POST',signal:abort.signal});
        if (closed || !valid(c)) { note.textContent = 'Target changed. Nothing was inserted.'; return; }
        confirmed = true;
        if (document.getElementById('app').classList.contains('cao-direct-active')) {
          if (!window.caoPasteText(info.path+' ', {pane:c.pane,socket:c.generation})) {
            note.textContent = 'Image retained for 24 hours, but its path was not sent. Check the terminal connection before attaching again.';
            return;
          }
        } else {
          const input = document.getElementById('input'); input.setRangeText(info.path+' ',input.selectionStart,input.selectionEnd,'end'); input.dispatchEvent(new Event('input',{bubbles:true}));
        }
        message('Image path inserted; retained for 24 hours. The active app must support local images. Press Enter only when ready.');
        dialog.close();
      } catch (e) { if (!closed) {note.textContent=e.message;insert.disabled=false;} }
    };
    async function upload() {
      if (closed || !valid(c)) { note.textContent = 'Target changed. Nothing was inserted.'; retry.hidden = true; return; }
      retry.hidden = true; note.textContent = 'Uploading…';
      try {
        const data = await request('', {method:'POST',headers:{'Content-Type':file.type},body:file,signal:abort.signal}); ident = data.id;
        if (closed) {request('/'+ident,{method:'DELETE'}).catch(()=>{});return;}
        if (!valid(c)) {note.textContent='Target changed. Nothing was inserted.';return;}
        note.textContent = 'Ready. Insert a local image path, not a command. File retained for 24 hours after confirmation.'; insert.disabled = false;
      } catch (e) { if (!closed) { note.textContent = e.message; retry.hidden = !valid(c); } }
    }
    retry.onclick = upload;
    await upload();
  }
  window.caoAttachImages = files => { for (const file of files) attach(file); };
  chooser.onchange = () => { window.caoAttachImages([...chooser.files]); chooser.value = ''; };
  document.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => { const files=[...(e.dataTransfer?.files || [])];if(files.length){e.preventDefault();e.stopPropagation();window.caoAttachImages(files);} },true);
  window.addEventListener('cao:terminal-reset', () => {for (const item of [...active]) item.close();});
  window.addEventListener('pagehide', () => {for (const item of [...active]) item.close();});
})();
