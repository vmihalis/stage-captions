const CAPTION_STATUSES = new Set(['idle', 'live', 'rehearsal', 'reconnecting', 'error', 'stopped']);

function normalizeServerOrigin(value, { allowDevelopmentHttp = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid team server address.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter the full address, starting with https://.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowDevelopmentHttp && loopback && url.protocol === 'http:')) {
    throw new Error('The team server must use HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Use only the server address, without a path, invitation, or password.');
  }
  return url.origin;
}

function matchesOrigin(value, origin) {
  try { return Boolean(origin) && new URL(value).origin === origin; } catch { return false; }
}

function normalizeOverlayOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid caption settings.');
  const fontSize = value.fontSize;
  const opacity = value.opacity;
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize < 24 || fontSize > 96) {
    throw new Error('Caption size must be between 24 and 96.');
  }
  if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0.3 || opacity > 1) {
    throw new Error('Caption background opacity must be between 0.3 and 1.');
  }
  if (!['top', 'bottom'].includes(value.position)) throw new Error('Choose the top or bottom of the screen.');
  if (typeof value.showEnglish !== 'boolean' || typeof value.clickThrough !== 'boolean') {
    throw new Error('Invalid caption settings.');
  }
  if (value.displayId !== undefined && (typeof value.displayId !== 'string' || value.displayId.length > 64)) {
    throw new Error('Invalid screen.');
  }
  if (value.outputMode !== undefined && !['overlay', 'window', 'presentation'].includes(value.outputMode)) {
    throw new Error('Invalid caption output mode.');
  }
  return { ...(value.outputMode === undefined ? {} : { outputMode: value.outputMode }),
    displayId: value.displayId, fontSize, opacity, position: value.position,
    showEnglish: value.showEnglish, clickThrough: value.clickThrough };
}

function normalizeCaptionPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !CAPTION_STATUSES.has(value.status)) {
    throw new Error('Invalid caption update.');
  }
  const strings = {};
  for (const key of ['english', 'japanese', 'partialJapanese']) {
    const content = value[key] === undefined && key === 'partialJapanese' ? '' : value[key];
    if (typeof content !== 'string' || content.length > 6000) throw new Error('Caption update is too long.');
    strings[key] = content;
  }
  if (value.translationLanguage !== undefined) {
    if (!['en', 'ja'].includes(value.translationLanguage)) throw new Error('Invalid caption language.');
    strings.translationLanguage = value.translationLanguage;
  }
  if (value.stableLines !== undefined) {
    if (!Array.isArray(value.stableLines) || value.stableLines.length > 2
      || value.stableLines.some(line => typeof line !== 'string' || line.length > 6000 || /[\r\n]/.test(line))) {
      throw new Error('Invalid stable caption lines.');
    }
    strings.stableLines = [...value.stableLines];
  }
  return { ...strings, status: value.status };
}

function chooseDisplay(displays, primaryId, requestedId) {
  return displays.find(display => String(display.id) === requestedId)
    || displays.find(display => display.id === primaryId) || displays[0];
}

function overlayBounds(workArea, options) {
  const margin = Math.min(24, Math.floor(workArea.width * 0.02), Math.floor(workArea.height * 0.04));
  const width = Math.max(1, workArea.width - margin * 2);
  // Two translation lines, optional spoken text, padding, and a readable status badge.
  const desiredHeight = Math.ceil(options.fontSize * 2.9 + (options.showEnglish ? options.fontSize * 0.8 : 0) + 96);
  const height = Math.max(1, Math.min(workArea.height - margin * 2, desiredHeight));
  return { x: Math.round(workArea.x + margin), y: Math.round(options.position === 'top'
    ? workArea.y + margin : workArea.y + workArea.height - height - margin), width, height };
}

function separateWindowBounds(workArea, options) {
  const bounds = overlayBounds(workArea, options);
  return { ...bounds, width: Math.min(bounds.width, 1100) };
}

function captureSourceAllowed(source, outputDisplay, displays, ownIds) {
  if (!source || typeof source.id !== 'string' || ownIds.includes(source.id) || /^window:[^:]+:1$/.test(source.id)) return false;
  if (source.id.startsWith('window:')) return true;
  if (!source.id.startsWith('screen:') || !source.display_id) return false;
  const sourceDisplay = displays.find(display => String(display.id) === source.display_id);
  if (!sourceDisplay || String(outputDisplay.id) === source.display_id) return false;
  const a = sourceDisplay.bounds, b = outputDisplay.bounds;
  // Mirrored or overlapping desktop coordinates can feed output back into capture.
  return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
}

module.exports = { normalizeServerOrigin, matchesOrigin, normalizeOverlayOptions, normalizeCaptionPayload, chooseDisplay, overlayBounds, separateWindowBounds, captureSourceAllowed };
