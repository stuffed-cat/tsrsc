import { parentPort } from 'worker_threads';
import { transpileFile } from './transpiler';

type Task = {
  input: string;
  output?: string;
  options?: any;
};

if (!parentPort) {
  throw new Error('worker must be spawned as a worker thread');
}

const verbose = process.env.TSRSC_WORKER_LOG === '1' || process.env.TSRSC_WORKER_LOG === 'true';
parentPort.on('message', (msg: Task) => {
  const start = Date.now();
  if (verbose) console.error(`[worker] start ${msg.input}`);
  try {
    transpileFile(msg.input, msg.output, msg.options);
    const ms = Date.now() - start;
    if (verbose) console.error(`[worker] done ${msg.input} ${ms}ms`);
    parentPort!.postMessage({ ok: true, output: msg.output, ms });
  } catch (err: any) {
    const ms = Date.now() - start;
    console.error(`[worker] error ${msg.input} ${ms}ms: ${String(err && err.stack || err)}`);
    parentPort!.postMessage({ ok: false, error: String(err && err.stack || err), ms });
  }
});
