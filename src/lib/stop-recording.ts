/** Cancellation does not necessarily settle SDK stop() during pending startup. */
export async function stopRecording(active: { stop(): Promise<unknown>; cancel(): void }, timeoutMs = 3500) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  try {
    await Promise.race([
      active.stop().catch(() => { interrupted = true; }),
      new Promise<void>(resolve => { timeout = setTimeout(() => { interrupted = true; resolve(); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timeout); active.cancel(); }
  return { interrupted };
}
