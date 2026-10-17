import {mkdir, cp} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, {recursive: true});
await Promise.all(['index.html', 'app.mjs'].map(file => cp(path.join(root, file), path.join(output, file))));
