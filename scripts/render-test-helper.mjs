import { render } from '../src/render.mjs';
import { buildStorageFromEnv } from '../src/helpers.mjs';
import { Counters } from '../src/counters.mjs';

const data = './data';
const counters = new Counters(data);
await counters.load();
const storage = buildStorageFromEnv(process.env, { dataDir: data, counters });
const code = 'graph TD\n  A[Start] --> B[End]';
const result = await render(code);
console.log('rendered id:', result.id);
await storage.put(result.id, { code, title: 'UAT S02 Test' }, result.svg);
console.log('stored ok');
const entry = await storage.pruneIfExpired(result.id);
console.log('entry exists:', !!entry);
const svg = await storage.readSvg(result.id);
console.log('svg length:', svg?.length);
