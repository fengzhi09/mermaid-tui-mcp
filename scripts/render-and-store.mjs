import { render } from '../src/render.mjs';
import { buildStorageFromEnv } from '../src/helpers.mjs';
import { Counters } from '../src/counters.mjs';

const data = './data';
const counters = new Counters(data);
await counters.load();
const storage = buildStorageFromEnv(process.env, { dataDir: data, counters });
const code = 'graph TD\n  A[Start] --> B[End]';
const result = await render(code);
await storage.put(result.id, code, result.svg, code.length, 'UAT S02 Fresh Theme');
console.log('Stored:', result.id);
const entry = await storage.pruneIfExpired(result.id);
console.log('entry code:', typeof entry?.code, entry?.code?.slice(0, 30));
