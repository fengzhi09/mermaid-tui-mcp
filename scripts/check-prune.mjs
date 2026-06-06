import { buildStorageFromEnv } from '../src/helpers.mjs';
import { Counters } from '../src/counters.mjs';

const data = './data';
const counters = new Counters(data);
await counters.load();
const storage = buildStorageFromEnv(process.env, { dataDir: data, counters });
const entry = await storage.pruneIfExpired('mmq2fi3w5001');
console.log('entry:', JSON.stringify(entry, null, 2));
console.log('has:', storage.has('mmq2fi3w5001'));
const svg = await storage.readSvg('mmq2fi3w5001');
console.log('svg length:', svg?.length);
