const card = document.getElementById('caption-card');
const japanese = document.getElementById('japanese');
const committed = document.getElementById('committed');
const partial = document.getElementById('partial');
const english = document.getElementById('english');
const status = document.getElementById('caption-status');
const statusLabels = { idle: 'Ready', live: '', rehearsal: 'Rehearsal · sample captions', reconnecting: 'Reconnecting', error: 'Captions interrupted', stopped: 'Stopped' };
let pendingScroll = false;

function showNewestWords() {
  if (pendingScroll) return;
  pendingScroll = true;
  requestAnimationFrame(() => {
    pendingScroll = false;
    // Keep the final two rendered lines visible regardless of font size or screen width.
    japanese.scrollTop = japanese.scrollHeight;
    english.scrollLeft = english.scrollWidth;
  });
}

function setText(element, text) {
  if (element.textContent === text) return false;
  element.textContent = text;
  return true;
}

new ResizeObserver(showNewestWords).observe(japanese);
document.fonts.ready.then(showNewestWords);
document.fonts.addEventListener('loadingdone', showNewestWords);

window.stageCaptions.onUpdate(({ options, captions }) => {
  const fontSize = `${options.fontSize}px`;
  let geometryChanged = document.documentElement.style.getPropertyValue('--caption-size') !== fontSize;
  document.documentElement.style.setProperty('--caption-size', fontSize);
  document.documentElement.style.setProperty('--caption-opacity', String(options.opacity));
  document.body.classList.toggle('top', options.position === 'top');
  const active = captions.status === 'live' || captions.status === 'rehearsal';
  japanese.hidden = !active;
  english.hidden = !active || !options.showEnglish || !captions.english;
  geometryChanged = setText(english, active ? captions.english : '') || geometryChanged;
  // The main renderer sends the visible caption segment, not an accumulating transcript.
  geometryChanged = setText(committed, active ? captions.japanese : '') || geometryChanged;
  geometryChanged = setText(partial, active ? captions.partialJapanese || '' : '') || geometryChanged;
  status.textContent = statusLabels[captions.status] || '';
  status.dataset.status = captions.status;
  status.hidden = !status.textContent;
  card.hidden = active && !captions.japanese && !captions.partialJapanese && !status.textContent;
  if (geometryChanged) showNewestWords();
});
window.stageCaptions.ready();
