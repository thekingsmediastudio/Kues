import { parentPort, workerData } from 'node:worker_threads';
import { parseDocument } from './file-formats.mjs';
try { parentPort.postMessage({ ok:true, result:await parseDocument(new Uint8Array(workerData.bytes),workerData.name) }); }
catch(error) { parentPort.postMessage({ ok:false, code:/^file_[a-z_]+$/.test(error.message)?error.message:'file_parse_failed' }); }
