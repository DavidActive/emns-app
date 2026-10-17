'use strict';
// Alert screen. Text is only ever inserted as text (never as HTML). No button has focus when the alert opens, so an
// accidental Enter or space bar cannot answer "I'm safe" for someone.
(function () {
  const $ = (id) => document.getElementById(id);
  const ORDER = { alert: 0, drill: 1, test: 2 };
  let current = null;
  let audio = null, beepTimer = null;

  function stopSound() { if (beepTimer) { clearInterval(beepTimer); beepTimer = null; } if (audio) { try { audio.close(); } catch (e) { /* already closed */ } audio = null; } }
  function startSound(kind) {
    stopSound();
    try {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        [880, 660].forEach((f, i) => {
          const o = audio.createOscillator(), g = audio.createGain();
          o.type = 'square'; o.frequency.value = f; g.gain.value = 0.08;
          o.connect(g); g.connect(audio.destination);
          const t = audio.currentTime + i * 0.28; o.start(t); o.stop(t + 0.22);
        });
      };
      beep();
      if (kind === 'alert') beepTimer = setInterval(beep, 1500); // a real alert keeps sounding until it is answered; drills and tests chime once
    } catch (e) { /* no audio device: the screen still shows */ }
  }

  function pick(alerts) {
    return alerts.slice().sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || ((b.received_at || 0) - (a.received_at || 0)))[0];
  }

  function render(payload) {
    const alerts = payload.alerts || [];
    if (alerts.length === 0) { stopSound(); current = null; return; }
    const a = pick(alerts);
    const isNew = !current || current.delivery_id !== a.delivery_id;
    current = a;
    $('card').className = `kind-${a.kind}`;
    $('banner').textContent = a.kind === 'alert' ? 'EMERGENCY ALERT' : a.kind === 'drill' ? 'DRILL (practice)' : 'TEST';
    $('org').textContent = a.organization || '';
    $('message').textContent = a.body;
    $('meta').textContent = a.received_at ? `Received ${new Date(a.received_at).toLocaleTimeString()}` : '';
    $('safe').hidden = !a.requires_ack; $('help').hidden = !a.requires_ack; $('ok').hidden = !!a.requires_ack;
    $('more').textContent = alerts.length > 1 ? `${alerts.length - 1} more alert${alerts.length > 2 ? 's' : ''} waiting after this one.` : '';
    if (isNew) {
      $('status').textContent = '';
      for (const id of ['safe', 'help', 'ok']) $(id).disabled = false;
      if (payload.sound !== false) startSound(a.kind);
      window.emns.shown(a.delivery_id);
    }
  }

  async function answer(action) {
    if (!current) return;
    const id = current.delivery_id;
    for (const b of ['safe', 'help', 'ok']) $(b).disabled = true;
    stopSound();
    try {
      if (action === 'ok') { await window.emns.dismiss(id); return; }
      const r = await window.emns.ack(id, action === 'help' ? 'SOS' : 'SAFE');
      $('status').textContent = r && r.sent === false
        ? (action === 'help' ? 'Not sent yet: no connection. Still trying. If you are in danger, call emergency services now.' : 'Not sent yet: no connection. Still trying.')
        : (action === 'help' ? 'Your request for help was sent.' : 'You are marked safe. Thank you.');
    } catch (e) {
      $('status').textContent = 'Something went wrong. Try again.';
      for (const b of ['safe', 'help', 'ok']) $(b).disabled = false;
    }
  }
  $('safe').addEventListener('click', () => answer('safe'));
  $('help').addEventListener('click', () => answer('help'));
  $('ok').addEventListener('click', () => answer('ok'));
  window.emns.onAlerts(render);
})();
