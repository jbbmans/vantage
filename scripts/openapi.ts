import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from '../server/config.ts';

/**
 * Every API route the app serves, as an OpenAPI 3.0 document, so the security scan reaches each one instead of only
 * what a crawler finds. The mounts are read from server/app.ts and the routes from each router as Express holds them,
 * so a route added anywhere is in the next scan. Bodies are described as JSON objects; the scanner fills them in.
 *
 *   node scripts/openapi.ts <out.json>
 */

interface RouteLayer { route?: { path: unknown; methods: Record<string, boolean> } }
interface RouterLike { stack: RouteLayer[] }

const out = process.argv[2] || join(PROJECT_ROOT, '.hawkscan', 'openapi.json');
const appSource = readFileSync(join(PROJECT_ROOT, 'server', 'app.ts'), 'utf8');

/** Which module each router is imported from. */
const moduleOf = new Map<string, string>();
for (const m of appSource.matchAll(/import \{([^}]+)\} from '\.\/routes\/([\w-]+)\.ts'/g)) {
  for (const name of m[1].split(',').map((s) => s.trim())) if (/Router$/.test(name)) moduleOf.set(name, m[2]);
}
const mounts = [...appSource.matchAll(/app\.use\('(\/api[^']*)', (\w+Router)\)/g)].map((m) => ({ mount: m[1], router: m[2] }));
const direct = [...appSource.matchAll(/app\.(get|post|put|patch|delete)\('(\/api[^']*)'/g)].map((m) => ({ method: m[1], path: m[2] }));

const routes: Array<{ method: string; path: string }> = [...direct];
for (const { mount, router } of mounts) {
  const file = moduleOf.get(router);
  if (!file) throw new Error(`${router} is mounted at ${mount} but its import was not found in server/app.ts.`);
  const mod = await import(`../server/routes/${file}.ts`) as Record<string, RouterLike>;
  const r = mod[router];
  if (!r?.stack) throw new Error(`${router} in server/routes/${file}.ts is not a router.`);
  for (const layer of r.stack) {
    if (!layer.route || typeof layer.route.path !== 'string') continue;
    const sub = layer.route.path === '/' ? '' : layer.route.path;
    for (const method of Object.keys(layer.route.methods)) if (method !== '_all') routes.push({ method, path: `${mount}${sub}` });
  }
}

/** Express's /units/:unitId to OpenAPI's /units/{unitId}; a wildcard path cannot be described, so it is left out. */
const toOpenApi = (path: string) => path.replace(/:(\w+)\??/g, '{$1}');
const paths: Record<string, Record<string, unknown>> = {};
let left = 0;
for (const { method, path } of routes) {
  if (/[*(]/.test(path)) { left += 1; continue; }
  const p = toOpenApi(path);
  const params = [...p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  const op: Record<string, unknown> = { operationId: `${method}_${p.replace(/[^\w]+/g, '_')}`, responses: { default: { description: 'Any response' } } };
  if (params.length) op.parameters = params;
  if (['post', 'put', 'patch'].includes(method)) op.requestBody = { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
  (paths[p] ||= {})[method] = op;
}

const doc = { openapi: '3.0.3', info: { title: 'Vantage API', version: '1' }, paths };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`${Object.keys(paths).length} paths, ${routes.length - left} operations written to ${out}${left ? `; ${left} wildcard routes left out` : ''}.`);
