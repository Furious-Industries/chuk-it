'use strict';
(() => {
  let clips = [], activeId = null, session = null, ws, ready = false, pending = null;
  let maxItems = 200, maxFrameBytes = 512 * 1024, retryMs = 600000, ackTimer, reconnectTimer, toastTimer;
  const $ = id => document.getElementById(id);
  const list = $('clip-list'), viewer = $('viewer'), paste = $('paste-box'), sendButton = $('send-btn');
  const delivery = $('delivery-status'), cancelPending = $('cancel-pending');
  const byteLength = text => new TextEncoder().encode(text).length;
  function notice(text) { delivery.textContent = text; }
  function toast(text) {
    $('toast').textContent = text; $('toast').classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2500);
  }
  function buttons() {
    sendButton.disabled = !ready || (pending ? pending.waiting : !paste.value.trim());
    sendButton.textContent = pending ? pending.waiting ? 'Sending…' : 'Retry delivery' : 'Add clip';
    cancelPending.hidden = !pending || pending.waiting;
    $('clear-btn').disabled = !ready || !clips.length;
  }
  function render() {
    const selected = clips.find(clip => clip.id === activeId);
    if (!selected) activeId = null;
    viewer.textContent = selected ? selected.text : 'Select a clip from the sidebar to view its full content.';
    viewer.hidden = false; $('manual-copy').hidden = true; $('manual-copy').value = '';
    viewer.className = selected ? 'viewer-box' : 'viewer-box placeholder';
    $('copy-btn').hidden = !selected;
    $('viewer-label').textContent = selected ? new Date(selected.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + selected.source : 'Nothing selected';
    $('char-count').textContent = selected ? `${selected.text.length.toLocaleString()} chars` : '';
    $('main-title').textContent = selected ? selected.preview : 'Chuk-it — select a clip or paste new content';
    const query = $('search').value.trim().toLowerCase();
    const matches = query ? clips.filter(clip => clip.text.toLowerCase().includes(query)) : clips;
    $('section-label').textContent = query ? `Results (${matches.length})` : 'Recents';
    list.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      empty.textContent = query ? 'No clips match this search.' : 'No clips yet. Paste something below to get started.';
      list.append(empty);
    }
    for (const clip of matches) {
      const row = document.createElement('div'); row.className = 'clip-item' + (clip.id === activeId ? ' active' : '');
      const select = document.createElement('button'); select.className = 'clip-select';
      select.textContent = clip.preview; select.dataset.id = clip.id;
      select.setAttribute('aria-pressed', String(clip.id === activeId));
      select.addEventListener('click', () => { activeId = clip.id; render(); });
      const remove = document.createElement('button'); remove.className = 'clip-delete'; remove.textContent = '✕';
      remove.setAttribute('aria-label', 'Delete clip'); remove.disabled = !ready;
      remove.addEventListener('click', () => command('delete', { id: clip.id }));
      row.append(select, remove); list.append(row);
    }
    buttons();
  }
  function connect() {
    const socket = new WebSocket(`wss://${location.host}/ws`);
    ws = socket;
    socket.addEventListener('message', event => {
      if (socket !== ws) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { socket.close(); return; }
      if (msg.type === 'init') {
        // Session IDs prevent old selections and retries from attaching to a restarted server.
        if (session !== msg.session) activeId = null;
        session = msg.session; clips = msg.clips; maxItems = msg.maxItems;
        maxFrameBytes = msg.maxFrameBytes; retryMs = msg.retryMs; ready = true;
        if (pending && pending.message.session !== session) {
          clearTimeout(ackTimer); pending = null;
          notice('The server restarted. Your draft is still here. Check it before you send it again.');
        } else if (pending) {
          pending.waiting = false;
          notice('Delivery is not confirmed. Retry delivery to check the same submission. Your draft is still here.');
        }
        $('status-dot').className = 'status-dot connected'; $('status-text').textContent = 'Connected'; render();
      } else if (msg.type === 'add') {
        const selected = clips.find(clip => clip.id === activeId);
        clips = clips.filter(clip => !msg.removed.includes(clip.id) && clip.id !== msg.clip.id);
        clips.unshift(msg.clip); clips.length = Math.min(clips.length, maxItems);
        if (selected && selected.text === msg.clip.text) activeId = msg.clip.id;
        render();
      } else if (msg.type === 'delete') {
        clips = clips.filter(clip => clip.id !== msg.id); render();
      } else if (msg.type === 'clear') {
        clips = []; activeId = null; render();
      } else if (msg.type === 'ack' && pending && msg.requestId === pending.message.requestId && msg.session === session) {
        clearTimeout(ackTimer);
        if (paste.value === pending.message.text) paste.value = '';
        pending = null; notice('Clip accepted by the server.'); toast('Clip added'); buttons();
      } else if (msg.type === 'error') {
        const descriptions = {
          invalid_message: 'The server rejected the message. Check the text and update the app if needed.',
          session_changed: 'The server restarted. Check your draft before you send it again.',
          request_expired: 'The retry time ended. Check the history before you send this draft again.',
          request_conflict: 'The request ID was already used. Check the history before you send this draft again.',
          busy: 'The server is busy. Wait, then retry delivery.',
          too_large: 'The clip is too large. Reduce its size.',
        };
        if (pending && msg.requestId === pending.message.requestId) {
          clearTimeout(ackTimer); pending.waiting = false;
          if (['session_changed', 'request_expired', 'request_conflict', 'invalid_message', 'too_large'].includes(msg.code)) pending = null;
        }
        notice(descriptions[msg.code] || 'The server rejected the request. Your draft is still here.'); buttons();
      }
    });
    socket.addEventListener('close', () => {
      if (socket !== ws) return;
      ready = false; clearTimeout(ackTimer);
      if (pending) { pending.waiting = false; notice('Connection lost. Delivery is not confirmed. Your draft is still here.'); }
      // Do not present an old snapshot as the current shared history.
      clips = []; activeId = null; render();
      $('status-dot').className = 'status-dot'; $('status-text').textContent = 'Reconnecting…';
      clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 2500);
    });
    socket.addEventListener('error', () => {});
  }
  function command(type, fields = {}) {
    if (!ready || ws.readyState !== WebSocket.OPEN) { notice('Not connected. Wait, then try again.'); return; }
    ws.send(JSON.stringify({ type, requestId: crypto.randomUUID(), session, createdAt: Date.now(), ...fields }));
  }
  function submit() {
    if (!ready || ws.readyState !== WebSocket.OPEN) { notice('Not connected. Your draft is still here.'); return; }
    if (pending?.waiting) return;
    if (!pending) {
      const text = paste.value;
      if (!text.trim()) return;
      const source = (navigator.userAgentData?.platform || navigator.platform || 'browser').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40);
      pending = { waiting: false, message: { type: 'add', requestId: crypto.randomUUID(), session, createdAt: Date.now(), text, source } };
    }
    if (Date.now() - pending.message.createdAt >= retryMs) {
      pending = null; notice('The retry time ended. Check the history before you send this draft again.'); buttons(); return;
    }
    const frame = JSON.stringify(pending.message);
    if (byteLength(frame) > maxFrameBytes) {
      pending = null; notice('Too large to sync. Reduce the clip below 512 KiB, including message data.'); buttons(); return;
    }
    try { ws.send(frame); } catch { notice('Delivery failed. Your draft is still here.'); buttons(); return; }
    pending.waiting = true; notice('Waiting for the server to confirm delivery.'); buttons();
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => {
      if (!pending) return;
      pending.waiting = false;
      notice('Delivery is not confirmed. Retry delivery to check the same submission. Your draft is still here.'); buttons();
    }, 5000);
  }
  cancelPending.addEventListener('click', () => {
    if (!pending) return;
    clearTimeout(ackTimer); pending = null;
    notice('Draft kept. The earlier submission might be in the history. Check before you send it again.'); buttons();
  });
  $('copy-btn').addEventListener('click', async () => {
    if (!clips.some(clip => clip.id === activeId)) return;
    const text = viewer.textContent;
    const selectedId = activeId;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text); toast('Copied to clipboard');
    } catch {
      if (activeId !== selectedId || !clips.some(clip => clip.id === selectedId && clip.text === text)) {
        notice('The selected clip changed. Select a clip again before you copy it.'); return;
      }
      const manual = $('manual-copy');
      manual.value = text; manual.hidden = false; viewer.hidden = true; manual.focus(); manual.select();
      notice('Clipboard access failed. Text is selected. Press Ctrl+C or Cmd+C, or use Copy in the selection menu.');
    }
  });
  $('clear-btn').addEventListener('click', () => {
    if (clips.length && confirm('Clear all clips? This affects all connected devices.')) command('clear');
  });
  sendButton.addEventListener('click', submit);
  paste.addEventListener('input', buttons);
  paste.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
  });
  $('search').addEventListener('input', render);
  render(); connect();
})();
