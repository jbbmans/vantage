#!/usr/bin/env python3
"""
Runs MiroFish on Vantage, cradle to grave: seed -> knowledge graph -> agent personas -> simulation -> interviews ->
prediction report. Standard library only, so it runs from any Python 3.11.

Needs, in the environment (never in a file in this repository):
  LLM_API_KEY, ZEP_API_KEY            required by MiroFish
  LLM_BASE_URL, LLM_MODEL_NAME        optional; MiroFish defaults to OpenAI's endpoint and gpt-4o-mini

Usage:
  python3 sim/mirofish/run.py                      # clone at $MIROFISH_DIR or /home/user/666ghj/mirofish
  python3 sim/mirofish/run.py --rounds 10          # a cheaper first run
  python3 sim/mirofish/run.py --no-start --base http://127.0.0.1:5001   # use a backend already running

Writes everything to sim/mirofish/runs/<UTC time>/: each step's response, the agents' posts, the interviews by
lifecycle stage, MiroFish's report, and summary.md, which puts them together.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


class Api:
    def __init__(self, base: str, out: Path):
        self.base = base.rstrip('/')
        self.out = out

    def _send(self, req: urllib.request.Request, timeout: int) -> dict:
        # MiroFish writes its ontology, personas and report in the request's language; it defaults to Chinese.
        req.add_header('Accept-Language', 'en')
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                body = res.read().decode('utf-8')
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', 'replace')
            try:
                payload = json.loads(body)
            except ValueError:
                raise RuntimeError(f'{req.get_method()} {req.full_url}: HTTP {e.code}: {body[:400]}') from None
            raise RuntimeError(f"{req.get_method()} {req.full_url}: HTTP {e.code}: {payload.get('error') or payload}") from None
        payload = json.loads(body)
        if isinstance(payload, dict) and payload.get('success') is False:
            raise RuntimeError(f"{req.get_method()} {req.full_url}: {payload.get('error') or payload}")
        return payload

    def get(self, path: str, timeout: int = 60) -> dict:
        return self._send(urllib.request.Request(self.base + path), timeout)

    def post(self, path: str, body: dict, timeout: int = 120) -> dict:
        data = json.dumps(body).encode('utf-8')
        return self._send(urllib.request.Request(self.base + path, data=data, method='POST', headers={'Content-Type': 'application/json'}), timeout)

    def post_files(self, path: str, fields: dict[str, str], files: list[Path], timeout: int = 600) -> dict:
        boundary = uuid.uuid4().hex
        parts: list[bytes] = []
        for name, value in fields.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode('utf-8'))
        for f in files:
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{f.name}"\r\nContent-Type: text/markdown\r\n\r\n'.encode('utf-8'))
            parts.append(f.read_bytes() + b'\r\n')
        parts.append(f'--{boundary}--\r\n'.encode('utf-8'))
        req = urllib.request.Request(self.base + path, data=b''.join(parts), method='POST', headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        return self._send(req, timeout)

    def save(self, name: str, payload: object) -> None:
        (self.out / name).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')


def poll(what: str, fetch, done, failed, every: float = 10, limit: float = 4 * 3600) -> dict:
    """Calls fetch() until done(data) or failed(data), printing progress when it changes."""
    started = time.time()
    last = None
    while True:
        data = fetch()
        note = f"{data.get('status') or data.get('runner_status') or ''} {data.get('progress') or data.get('progress_percent') or ''} {data.get('message') or ''}".strip()
        if note != last:
            log(f'{what}: {note}')
            last = note
        if done(data):
            return data
        if failed(data):
            detail = str(data.get('error') or data.get('message') or data)
            # MiroFish puts the whole traceback in a task's error; its last lines say what went wrong.
            raise RuntimeError(f"{what} failed: {detail[-800:]}")
        if time.time() - started > limit:
            raise RuntimeError(f'{what} did not finish in {limit / 3600:.1f} hours')
        time.sleep(every)


def start_backend(mirofish: Path, port: int, out: Path) -> subprocess.Popen:
    backend = mirofish / 'backend'
    if not (backend / 'run.py').exists():
        sys.exit(f'No MiroFish backend at {backend}. Clone https://github.com/666ghj/MiroFish there, or pass --mirofish.')
    env = {**os.environ, 'FLASK_PORT': str(port), 'FLASK_HOST': '127.0.0.1', 'FLASK_DEBUG': 'False', 'PYTHONUNBUFFERED': '1'}
    logf = open(out / 'backend.log', 'w', encoding='utf-8')
    log(f'Starting the MiroFish backend on port {port} (log: {out / "backend.log"})')
    return subprocess.Popen(['uv', 'run', 'python', 'run.py'], cwd=backend, env=env, stdout=logf, stderr=subprocess.STDOUT)


def wait_healthy(api: Api, proc: subprocess.Popen | None, seconds: int = 180) -> None:
    for _ in range(seconds):
        if proc and proc.poll() is not None:
            sys.exit(f'The MiroFish backend exited (code {proc.returncode}); see backend.log.')
        try:
            api.get('/health', timeout=5)
            return
        except Exception:
            time.sleep(1)
    sys.exit('The MiroFish backend did not answer /health in time; see backend.log.')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--mirofish', default=os.environ.get('MIROFISH_DIR', '/home/user/666ghj/mirofish'))
    ap.add_argument('--base', default='http://127.0.0.1:5001')
    ap.add_argument('--no-start', action='store_true', help='use a backend that is already running at --base')
    ap.add_argument('--rounds', type=int, default=20, help='maximum simulation rounds (MiroFish suggests under 40 for a first run)')
    ap.add_argument('--platform', default='parallel', choices=['parallel', 'twitter', 'reddit'])
    ap.add_argument('--profiles-parallel', type=int, default=3)
    ap.add_argument('--skip-interviews', action='store_true')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    missing = [k for k in ('LLM_API_KEY', 'ZEP_API_KEY') if not os.environ.get(k)]
    if missing and not args.no_start:
        sys.exit(f"Missing {', '.join(missing)} in the environment. Add them in the environment's settings; never commit them.")

    out = Path(args.out) if args.out else HERE / 'runs' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    out.mkdir(parents=True, exist_ok=True)
    api = Api(args.base, out)
    port = int(args.base.rsplit(':', 1)[-1].split('/')[0])
    proc = None if args.no_start else start_backend(Path(args.mirofish), port, out)
    sim_id = None
    try:
        wait_healthy(api, proc)
        seeds = sorted((HERE / 'seed').glob('*.md'))
        requirement = (HERE / 'requirement.txt').read_text(encoding='utf-8').strip()
        meta = {'started_at': datetime.now(timezone.utc).isoformat(), 'rounds': args.rounds, 'platform': args.platform,
                'model': os.environ.get('LLM_MODEL_NAME', 'gpt-4o-mini (MiroFish default)'), 'seeds': [s.name for s in seeds]}
        api.save('run.json', meta)

        # 1. Ontology: what kinds of people and things the seed holds.
        log(f"1/7 Reading the seed ({', '.join(s.name for s in seeds)}) into an ontology")
        onto = api.post_files('/api/graph/ontology/generate', {'simulation_requirement': requirement, 'project_name': 'Vantage cradle to grave',
                                                             'additional_context': 'All people and the unit are synthetic. Vantage is a Marine Corps work, record and evaluation-input tool.'}, seeds)['data']
        api.save('1-ontology.json', onto)
        project_id = onto['project_id']

        # 2. Knowledge graph (Zep).
        log('2/7 Building the knowledge graph')
        task_id = api.post('/api/graph/build', {'project_id': project_id, 'graph_name': 'vantage-cradle-to-grave'})['data']['task_id']
        poll('graph', lambda: api.get(f'/api/graph/task/{task_id}')['data'], lambda d: d['status'] == 'completed', lambda d: d['status'] == 'failed')
        project = api.get(f'/api/graph/project/{project_id}')['data']
        api.save('2-project.json', project)
        graph_id = project.get('graph_id')

        # 3. Simulation and agent personas.
        log('3/7 Creating the simulation and generating agent personas')
        sim = api.post('/api/simulation/create', {'project_id': project_id, 'graph_id': graph_id, 'enable_twitter': args.platform != 'reddit', 'enable_reddit': args.platform != 'twitter'})['data']
        sim_id = sim['simulation_id']
        meta['simulation_id'] = sim_id
        api.save('run.json', meta)
        prep = api.post('/api/simulation/prepare', {'simulation_id': sim_id, 'use_llm_for_profiles': True, 'parallel_profile_count': args.profiles_parallel}, timeout=300)['data']
        if not prep.get('already_prepared'):
            ptask = prep.get('task_id')
            poll('personas', lambda: api.post('/api/simulation/prepare/status', {'task_id': ptask, 'simulation_id': sim_id})['data'],
                 lambda d: d.get('status') in ('completed', 'ready') or d.get('already_prepared') is True, lambda d: d.get('status') == 'failed', every=15)
        for name, path in (('3-profiles.json', f'/api/simulation/{sim_id}/profiles'), ('3-config.json', f'/api/simulation/{sim_id}/config')):
            try:
                api.save(name, api.get(path)['data'])
            except RuntimeError as e:
                log(f'(could not save {name}: {e})')

        # 4. Run.
        log(f'4/7 Running the simulation ({args.platform}, at most {args.rounds} rounds)')
        api.post('/api/simulation/start', {'simulation_id': sim_id, 'platform': args.platform, 'max_rounds': args.rounds, 'enable_graph_memory_update': True})
        poll('simulation', lambda: api.get(f'/api/simulation/{sim_id}/run-status')['data'],
             lambda d: d.get('runner_status') in ('completed', 'stopped'), lambda d: d.get('runner_status') == 'failed', every=20)
        for platform in (['twitter', 'reddit'] if args.platform == 'parallel' else [args.platform]):
            try:
                api.save(f'4-posts-{platform}.json', api.get(f'/api/simulation/{sim_id}/posts?platform={platform}&limit=500')['data'])
            except RuntimeError as e:
                log(f'(could not save {platform} posts: {e})')

        # 5. Interviews, one question per lifecycle stage, asked of every agent.
        interviews = []
        if not args.skip_interviews:
            for q in json.loads((HERE / 'interviews.json').read_text(encoding='utf-8')):
                log(f"5/7 Interviewing every agent: stage {q['stage']}")
                try:
                    res = api.post('/api/simulation/interview/all', {'simulation_id': sim_id, 'prompt': q['prompt'], 'platform': 'reddit' if args.platform != 'twitter' else 'twitter', 'timeout': 300}, timeout=420)['data']
                    interviews.append({**q, 'answers': res})
                except RuntimeError as e:
                    interviews.append({**q, 'error': str(e)})
                    log(f'  failed: {e}')
                api.save('5-interviews.json', interviews)

        # 6. MiroFish's own report.
        log('6/7 Generating the prediction report')
        gen = api.post('/api/report/generate', {'simulation_id': sim_id})['data']
        rtask = gen.get('task_id')
        poll('report', lambda: api.post('/api/report/generate/status', {'task_id': rtask, 'simulation_id': sim_id})['data'],
             lambda d: d.get('status') == 'completed', lambda d: d.get('status') == 'failed', every=20)
        report = api.get(f'/api/report/by-simulation/{sim_id}')['data']
        api.save('6-report.json', report)
        (out / 'report.md').write_text(report.get('markdown_content') or '', encoding='utf-8')

        # 7. One file to read.
        log('7/7 Writing summary.md')
        lines = [f"# MiroFish on Vantage, cradle to grave ({meta['started_at'][:10]})", '',
                 f"Simulation `{sim_id}`, {args.platform}, up to {args.rounds} rounds, model {meta['model']}. Synthetic people only.", '',
                 '## Interviews by lifecycle stage', '']
        for q in interviews:
            lines += [f"### {q['stage']}", '', f"> {q['prompt']}", '']
            if 'error' in q:
                lines += [f"Not answered: {q['error']}", '']
                continue
            results = (q['answers'].get('result') or {}).get('results') or {}
            for key, r in results.items():
                text = str(r.get('response') or '').strip().replace('\n', ' ')
                if text:
                    lines.append(f"- **{key}**: {text}")
            lines.append('')
        lines += ['## MiroFish report', '', report.get('markdown_content') or '(empty)', '']
        (out / 'summary.md').write_text('\n'.join(lines), encoding='utf-8')
        meta['finished_at'] = datetime.now(timezone.utc).isoformat()
        api.save('run.json', meta)
        log(f'Done. Read {out / "summary.md"}')
    finally:
        if sim_id:
            try:
                api.post('/api/simulation/close-env', {'simulation_id': sim_id}, timeout=60)
            except Exception:
                pass
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == '__main__':
    main()
