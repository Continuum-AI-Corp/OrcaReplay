// `server.json` carries its own version, and the MCP Registry rejects a publish whose version it
// has already seen. Deriving it from the tag keeps one number in one place: forget to edit this
// file and the release fails, which is the wrong failure to have at publish time.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) throw new Error('usage: sync-server-json.mjs <version>');

const manifest = JSON.parse(readFileSync('server.json', 'utf8'));
manifest.version = version;
for (const pkg of manifest.packages ?? []) pkg.version = version;
writeFileSync('server.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`server.json -> ${version}`);
