'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  if (q.get('server')) $('server').value = q.get('server');
  if (q.get('locked') === '1') $('serverRow').hidden = true; // IT set the address in config.json: nothing to type
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('msg');
    msg.className = ''; msg.textContent = 'Pairing…';
    $('go').disabled = true;
    const r = await window.emns.enroll({ serverUrl: $('server').value, code: $('code').value });
    if (r && r.ok) { msg.className = 'good'; msg.textContent = 'Paired. You will get alerts on this computer.'; }
    else { msg.className = 'error'; msg.textContent = (r && r.error) || 'Could not pair. Check the code and try again.'; $('go').disabled = false; }
  });
})();
