#!/usr/bin/env bun
import { MAX_INPUT_BYTES, MAX_RUN_MS, WorkerError, failure, summarize, validateRequest } from './core.mjs';
import { readiness, withLocalGenerator } from './omp.mjs';

// Capture only our protocol sink. Dependency console output is suppressed; the
// native parent should additionally discard stderr and treat a non-JSON exit as
// a failed invocation. Raw exceptions can contain transcript or provider data.
const output = process.stdout.write.bind(process.stdout);
let finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  output(`${JSON.stringify(result)}\n`, () => process.exit(0));
}
const silent = (...args) => { const callback = args.at(-1); if (typeof callback === 'function') callback(); return true; };
process.stdout.write = silent;
process.stderr.write = silent;
process.on('uncaughtException', () => finish(failure(new WorkerError('GENERATION_FAILED'))));
process.on('unhandledRejection', () => finish(failure(new WorkerError('GENERATION_FAILED'))));
process.on('SIGTERM', () => finish(failure(new WorkerError('CANCELLED'))));
process.on('SIGINT', () => finish(failure(new WorkerError('CANCELLED'))));
setTimeout(() => finish(failure(new WorkerError('TIMED_OUT'))), MAX_RUN_MS).unref();

try {
  if (process.argv.length === 3 && process.argv[2] === '--check') {
    finish(await readiness());
  } else {
    if (process.argv.length !== 2) throw new WorkerError('INVALID_REQUEST');
    const pieces = []; let bytes = 0;
    for await (const piece of process.stdin) {
      bytes += piece.length;
      if (bytes > MAX_INPUT_BYTES) throw new WorkerError('INPUT_TOO_LARGE');
      pieces.push(piece);
    }
    let request;
    try { request = JSON.parse(Buffer.concat(pieces).toString('utf8')); }
    catch { throw new WorkerError('INVALID_REQUEST'); }
    validateRequest(request);
    finish(await withLocalGenerator(generator => summarize(request, generator)));
  }
} catch (error) { finish(failure(error)); }
