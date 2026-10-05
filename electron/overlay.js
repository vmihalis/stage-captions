const card = document.getElementById('caption-card');
const japanese = document.getElementById('japanese');
const committed = document.getElementById('committed');
const partial = document.getElementById('partial');
const english = document.getElementById('english');
const status = document.getElementById('caption-status');
const statusLabels = { idle: 'Ready', live: '', rehearsal: 'Rehearsal · sample captions', reconnecting: 'Reconnecting', error: 'Captions interrupted', stopped: 'Stopped' };
let pendingScroll = false;
let stable = false;

function fitStableLines() {
  japanese.style.fontSize = '';
  if (!stable) return;
  const width = japanese.clientWidth;
  const naturalWidth = Math.max(committed.scrollWidth, partial.scrollWidth);
  const base = Number.parseFloat(document.documentElement.style.getPropertyValue('--caption-size'));
  if (width > 0 && naturalWidth > width && base > 0) {
    japanese.style.fontSize = `${Math.max(1, Math.floor(base * width / naturalWidth * 10) / 10)}px`;
  }
}

function showNewestWords() {
  if (stable) { japanese.scrollTop = 0; fitStableLines(); return; }
  if (pendingScroll) return;
  pendingScroll = true;
  requestAnimationFrame(() => {
    pendingScroll = false;
    // Keep the final two rendered lines visible regardless of font size or screen width.
    japanese.scrollTop = stable ? 0 : japanese.scrollHeight;
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
  japanese.lang = captions.translationLanguage || 'ja';
  const fontSize = `${options.fontSize}px`;
  let geometryChanged = document.documentElement.style.getPropertyValue('--caption-size') !== fontSize;
  document.documentElement.style.setProperty('--caption-size', fontSize);
  document.documentElement.style.setProperty('--caption-opacity', String(options.opacity));
  document.body.classList.toggle('top', options.position === 'top');
  document.body.classList.toggle('show-source', options.showEnglish);
  document.body.classList.toggle('windowed', options.outputMode === 'window');
  stable = Array.isArray(captions.stableLines);
  if (!stable) japanese.style.fontSize = '';
  document.body.classList.toggle('stable-captions', stable);
  const active = captions.status === 'live' || captions.status === 'rehearsal';
  japanese.hidden = !active;
  english.hidden = !active || !options.showEnglish || !captions.english;
  geometryChanged = setText(english, active ? captions.english : '') || geometryChanged;
  // The main renderer sends the visible caption segment, not an accumulating transcript.
  geometryChanged = setText(committed, active ? (stable ? captions.stableLines[0] || '' : captions.japanese) : '') || geometryChanged;
  geometryChanged = setText(partial, active ? (stable ? captions.stableLines[1] || '' : captions.partialJapanese || '') : '') || geometryChanged;
  status.textContent = statusLabels[captions.status] || '';
  status.dataset.status = captions.status;
  status.hidden = !status.textContent;
  card.hidden = active && !(stable ? captions.stableLines.some(Boolean) : captions.japanese || captions.partialJapanese) && !status.textContent;
  if (geometryChanged) showNewestWords();
});
window.stageCaptions.ready();
