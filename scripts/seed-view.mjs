// Standalone script to seed a diagram for E2E testing of /view
import { LocalFsStorage } from '../src/storage/LocalFsStorage.mjs';
import { render } from '../src/render.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const storage = new LocalFsStorage(dataDir);
await storage.load();

const code = 'graph TD\n  A[Start] --> B[End]';
const r = await render(code);
await storage.put(r.id, code, r.svg, code.length, 'Final');
await storage.save();
console.log(r.id);
