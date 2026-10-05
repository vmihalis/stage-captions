(() => {
  const video = document.getElementById('presentation-video');
  const picker = document.getElementById('source-picker');
  const output = document.getElementById('presentation-output');
  const list = document.getElementById('source-list');
  const load = document.getElementById('load-sources');
  const error = document.getElementById('capture-error');
  let stream;
  let generation = 0;
  function stopStream() {
    generation++;
    if (stream) stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
    stream = undefined;
    video.srcObject = null;
  }
  function showError(message) { error.textContent = message; error.hidden = false; }
  function reset() {
    stopStream();
    picker.hidden = false;
    output.hidden = true;
    error.hidden = true;
    list.replaceChildren();
    load.disabled = false;
  }
  async function choose(id) {
    stopStream();
    const request = generation;
    for (const button of list.querySelectorAll('button')) button.disabled = true;
    load.disabled = true;
    error.hidden = true;
    try {
      await window.stagePresentation.selectSource(id);
      if (request !== generation) return;
      const captured = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
      if (request !== generation) { captured.getTracks().forEach(track => track.stop()); return; }
      stream = captured;
      stream.getVideoTracks().forEach(track => { track.onended = () => {
        reset();
        window.stagePresentation.stop().catch(() => {});
      }; });
      video.srcObject = stream;
      await video.play();
      if (request !== generation) return;
      await window.stagePresentation.started();
      if (request !== generation) return;
      picker.hidden = true;
      output.hidden = false;
    } catch (failure) {
      if (request !== generation) return;
      stopStream();
      picker.hidden = false;
      output.hidden = true;
      window.stagePresentation.error();
      showError('Could not share this source. Allow Stage in your system screen recording settings, keep the source open, then choose again.');
    } finally {
      if (picker.hidden === false) {
        load.disabled = false;
        for (const button of list.querySelectorAll('button')) button.disabled = false;
      }
    }
  }
  load.addEventListener('click', async () => {
    load.disabled = true;
    error.hidden = true;
    const request = generation;
    try {
      const sources = await window.stagePresentation.getSources();
      if (request !== generation) return;
      list.replaceChildren();
      for (const source of sources) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `${source.kind === 'screen' ? 'Screen' : 'Window'} · ${source.name}`;
        button.addEventListener('click', () => choose(source.id));
        list.append(button);
      }
      if (!sources.length) showError('No available sources. Open your slides or app on the control screen and check screen recording permission, then refresh.');
      load.textContent = 'Refresh sources';
    } catch { showError('Could not list windows. Check screen recording permission in your system settings, then refresh.'); }
    finally { load.disabled = false; }
  });
  window.stagePresentation.onReset(reset);
  window.addEventListener('beforeunload', stopStream);
  window.addEventListener('pagehide', stopStream);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { reset(); window.stagePresentation.stop().catch(() => {}); }
  });
})();
