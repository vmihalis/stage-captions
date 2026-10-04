const form = document.getElementById('connection-form');
const input = document.getElementById('server-address');
const error = document.getElementById('error');
const button = form.querySelector('button');

window.stageConnection.getConfiguration().then(configuration => {
  input.value = configuration.origin || '';
  error.textContent = configuration.message || '';
  document.getElementById('development-note').hidden = !configuration.development;
}).catch(() => { error.textContent = 'Could not read the connection settings. Restart Stage to try again.'; });

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  error.textContent = '';
  try {
    const result = await window.stageConnection.connect(input.value);
    if (!result.ok) error.textContent = result.error;
  } catch { error.textContent = 'Could not connect. Check the address and try again.'; }
  finally { button.disabled = false; }
});
