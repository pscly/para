#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
evidence_dir="$repo_root/.sisyphus/evidence"
evidence_file="$evidence_dir/task-beta-ws-multiproc.txt"

compose_project=""
postgres_port=""
redis_port=""
server_port=""
tmp_dir=""
server_pgid=""
worker_pgid=""
server_log=""
worker_log=""
cleanup_ran=0

step_marker() {
  local kind="$1"
  local name="$2"
  printf '\n========== [%s] %s ==========%s' "$kind" "$name" $'\n'
}

usage() {
  cat <<'EOF'
用法:
  ./scripts/qa_beta.sh [--dry-run] [--help]

说明:
  Beta QA Runner：本机硬验收“多进程 WS + Celery 事件可达”。

  启动拓扑:
    - docker compose 启动 Postgres(pgvector) + Redis（独立 COMPOSE_PROJECT_NAME + 动态空闲端口）
    - cd server && uv run alembic upgrade head（指向临时 Postgres）
    - uvicorn --workers 2 启动服务（指向同一 Postgres/Redis）
    - 独立 celery worker（non-eager，指向同一 Redis）

  验收:
    - Node(ws) 建立 WS（不重连），触发 /api/v1/dreams/trigger
    - 等待收到 TIMELINE_EVENT（payload.event 为 DREAM_ENTRY_CREATED 或等价事件）

  清理:
    - trap 保证异常退出也会清理：kill server/worker 进程组；docker compose down -v

参数:
  -h, --help      输出帮助信息并退出
  --dry-run       只打印“将要执行的命令清单”，不启动 docker/服务、不写 evidence

证据约定:
  evidence 根目录: .sisyphus/evidence/
  本脚本 evidence 文件: .sisyphus/evidence/task-beta-ws-multiproc.txt

示例:
  ./scripts/qa_beta.sh --help
  ./scripts/qa_beta.sh --dry-run
  ./scripts/qa_beta.sh
EOF
}

die_usage() {
  local msg="$1"
  printf 'ERROR: %s\n\n' "$msg" >&2
  usage >&2
  exit 2
}

need_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die_usage "missing_required_command=$name"
}

run_step() {
  local step_name="$1"
  local cmd_display="$2"
  shift 2

  step_marker "STEP START" "$step_name"
  printf '+ %s\n' "$cmd_display"

  if ! "$@"; then
    step_marker "STEP FAIL" "$step_name"
    printf 'failed_step=%s\n' "$step_name"
    printf 'failed_cmd=%s\n' "$cmd_display"
    return 1
  fi

  step_marker "STEP OK" "$step_name"
}

pick_free_port() {
  python3 - <<'PY'
import socket

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
port = s.getsockname()[1]
s.close()
print(port)
PY
}

pick_free_ports_3() {
  python3 - <<'PY'
import socket

ports = []
socks = []
for _ in range(3):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    socks.append(s)
    ports.append(s.getsockname()[1])
for s in socks:
    s.close()
print("\n".join(str(p) for p in ports))
PY
}

dc() {
  COMPOSE_PROJECT_NAME="$compose_project" docker compose -p "$compose_project" --project-directory "$repo_root" "$@"
}

wait_http_json() {
  local url="$1"
  local timeout_s="$2"
  python3 - <<PY
import json
import sys
import time
import urllib.request

url = ${url@Q}
deadline = time.time() + float(${timeout_s@Q})
last_err = None

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

while time.time() < deadline:
    try:
        with opener.open(url, timeout=5.0) as resp:
            if resp.status != 200:
                last_err = f"http_status={resp.status}"
                time.sleep(0.2)
                continue
            body = resp.read().decode("utf-8")
            obj = json.loads(body)
            print(json.dumps(obj, ensure_ascii=True, sort_keys=True))
            sys.exit(0)
    except Exception as e:
        last_err = type(e).__name__
        time.sleep(0.2)

print(f"ERROR: wait_http_json timeout url={url} last_err={last_err}")
sys.exit(1)
PY
}

wait_http_status() {
  local url="$1"
  local wanted_status="$2"
  local timeout_s="$3"
  python3 - <<PY
import sys
import time
import urllib.request
import urllib.error

url = ${url@Q}
wanted = int(${wanted_status@Q})
deadline = time.time() + float(${timeout_s@Q})
last_err = None

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

while time.time() < deadline:
    try:
        status = None
        try:
            with opener.open(url, timeout=5.0) as resp:
                status = int(resp.status)
        except urllib.error.HTTPError as e:
            status = int(getattr(e, "code", 0) or 0)

        if status != wanted:
            last_err = f"http_status={status}"
            time.sleep(0.2)
            continue
        print(f"http_ok status={status}")
        sys.exit(0)
    except Exception as e:
        last_err = type(e).__name__
        time.sleep(0.2)

print(f"ERROR: wait_http_status timeout url={url} wanted_status={wanted} last_err={last_err}")
sys.exit(1)
PY
}

wait_http_any() {
  local url="$1"
  local timeout_s="$2"
  python3 - <<PY
import sys
import time
import urllib.error
import urllib.request

url = ${url@Q}
deadline = time.time() + float(${timeout_s@Q})
last_err = None

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

while time.time() < deadline:
    try:
        with opener.open(url, timeout=5.0) as resp:
            print(f"http_any status={resp.status}")
            sys.exit(0)
    except urllib.error.HTTPError as e:
        print(f"http_any status={e.code}")
        sys.exit(0)
    except Exception as e:
        last_err = type(e).__name__
        time.sleep(0.2)

print(f"ERROR: wait_http_any timeout url={url} last_err={last_err}")
sys.exit(1)
PY
}

wait_tcp_port() {
  local host="$1"
  local port="$2"
  local timeout_s="$3"
  python3 - <<PY
import socket
import sys
import time

host = ${host@Q}
port = int(${port@Q})
deadline = time.time() + float(${timeout_s@Q})
last_err = None

while time.time() < deadline:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            print("tcp_ok=True")
            sys.exit(0)
    except Exception as e:
        last_err = type(e).__name__
        time.sleep(0.2)

print(f"ERROR: wait_tcp_port timeout host={host} port={port} last_err={last_err}")
sys.exit(1)
PY
}

wait_file_contains() {
  local path="$1"
  local needle="$2"
  local timeout_s="$3"
  python3 - <<PY
import sys
import time
from pathlib import Path

path = Path(${path@Q})
needle = ${needle@Q}
deadline = time.time() + float(${timeout_s@Q})

while time.time() < deadline:
    try:
        if path.exists() and needle in path.read_text(errors="ignore"):
            print("file_contains=True")
            sys.exit(0)
    except Exception:
        pass
    time.sleep(0.2)

print(f"ERROR: wait_file_contains timeout path={str(path)} needle={needle}")
sys.exit(1)
PY
}

cleanup() {
  if (( cleanup_ran == 1 )); then
    return 0
  fi
  cleanup_ran=1

  set +e
  step_marker "CLEANUP" "清理进程与 docker compose（project 仅本次）"

  if [[ -n "${worker_pgid:-}" ]]; then
    printf '+ kill -TERM -- -%s  # celery worker process group\n' "$worker_pgid"
    kill -TERM -- "-$worker_pgid" >/dev/null 2>&1 || true
  fi
  if [[ -n "${server_pgid:-}" ]]; then
    printf '+ kill -TERM -- -%s  # uvicorn process group\n' "$server_pgid"
    kill -TERM -- "-$server_pgid" >/dev/null 2>&1 || true
  fi

  sleep 1

  if [[ -n "${compose_project:-}" ]]; then
    printf '+ docker compose -p %s down -v\n' "$compose_project"
    dc down -v >/dev/null 2>&1 || true
  fi

  if [[ -n "${tmp_dir:-}" && -d "${tmp_dir:-}" ]]; then
    if [[ -n "${server_log:-}" && -f "${server_log:-}" ]]; then
      printf '\n--- uvicorn.log (tail, cleanup) ---\n'
      python3 - <<PY
from pathlib import Path
p = Path(${server_log@Q})
lines = p.read_text(errors="ignore").splitlines() if p.exists() else []
for ln in lines[-120:]:
    print(ln)
PY
    fi
    if [[ -n "${worker_log:-}" && -f "${worker_log:-}" ]]; then
      printf '\n--- celery.log (tail, cleanup) ---\n'
      python3 - <<PY
from pathlib import Path
p = Path(${worker_log@Q})
lines = p.read_text(errors="ignore").splitlines() if p.exists() else []
for ln in lines[-160:]:
    print(ln)
PY
    fi

    printf '+ rm -rf %s\n' "$tmp_dir"
    rm -rf "$tmp_dir" >/dev/null 2>&1 || true
  fi

  set -e
}

start_deps() {
  POSTGRES_PORT="$postgres_port" \
  REDIS_PORT="$redis_port" \
  dc up -d postgres redis

  local pg_container="${compose_project}-postgres"
  local redis_container="${compose_project}-redis"

  local i
  local st

  for ((i=0; i<240; i++)); do
    st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$pg_container" 2>/dev/null || true)"
    if [[ "$st" == "healthy" ]]; then
      break
    fi
    sleep 0.5
  done
  if [[ "${st:-}" != "healthy" ]]; then
    printf 'ERROR: postgres not healthy (status=%s)\n' "${st:-<none>}" >&2
    docker logs "$pg_container" || true
    return 1
  fi

  for ((i=0; i<120; i++)); do
    st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$redis_container" 2>/dev/null || true)"
    if [[ "$st" == "healthy" ]]; then
      break
    fi
    sleep 0.5
  done
  if [[ "${st:-}" != "healthy" ]]; then
    printf 'ERROR: redis not healthy (status=%s)\n' "${st:-<none>}" >&2
    docker logs "$redis_container" || true
    return 1
  fi

  local ok
  ok=0
  for ((i=0; i<240; i++)); do
    if dc exec -T postgres pg_isready -U para -d para >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 0.5
  done
  if (( ok == 0 )); then
    printf 'ERROR: postgres pg_isready did not become ready (db=user=para)\n' >&2
    dc logs postgres || true
    return 1
  fi

  ok=0
  for ((i=0; i<120; i++)); do
    if dc exec -T redis redis-cli ping 2>/dev/null | grep -q "PONG"; then
      ok=1
      break
    fi
    sleep 0.5
  done
  if (( ok == 0 )); then
    printf 'ERROR: redis ping did not become ready\n' >&2
    dc logs redis || true
    return 1
  fi

  dc ps
}

run_migrations() {
  (cd "$repo_root/server" && \
    DATABASE_URL="postgresql+psycopg://para:para@127.0.0.1:${postgres_port}/para" \
    uv run alembic upgrade head)
}

ensure_server_ws_support() {
  if (cd "$repo_root/server" && uv run python -c "import websockets" >/dev/null 2>&1); then
    printf 'ws_support_backend=websockets\n'
    return 0
  fi
  if (cd "$repo_root/server" && uv run python -c "import wsproto" >/dev/null 2>&1); then
    printf 'ws_support_backend=wsproto\n'
    return 0
  fi

  printf 'ERROR: missing_ws_dependency_for_uvicorn (need: websockets or wsproto)\n' >&2
  printf 'HINT: cd server && uv pip install websockets\n' >&2
  return 1
}

start_server() {
  local db_url="postgresql+psycopg://para:para@127.0.0.1:${postgres_port}/para"
  local redis_url="redis://127.0.0.1:${redis_port}/0"

  server_log="$tmp_dir/uvicorn.log"
  : >"$server_log"

  ensure_server_ws_support

  setsid bash -c "cd ${repo_root@Q}/server && \
    export ENV=dev && \
    export HEALTH_TIMEOUT_S=2.0 && \
    export DATABASE_URL=${db_url@Q} && \
    export CELERY_BROKER_URL=${redis_url@Q} && \
    export CELERY_RESULT_BACKEND=${redis_url@Q} && \
    export WS_REDIS_URL=${redis_url@Q} && \
    export CELERY_TASK_ALWAYS_EAGER=0 && \
    uv run uvicorn app.main:app --host 127.0.0.1 --port ${server_port@Q} --workers 2" \
    >>"$server_log" 2>&1 &
  server_pgid=$!

  printf 'server_pgid=%s\n' "$server_pgid"
  printf 'server_log=%s\n' "$server_log"

  local probe
  if ! probe="$(wait_tcp_port 127.0.0.1 "$server_port" 30)"; then
    printf 'ERROR: server did not become ready\n' >&2
    printf 'wait_tcp_port_output=%s\n' "$probe" >&2
    printf -- '--- uvicorn.log (tail, start_server failure) ---\n' >&2
    python3 - <<PY >&2
from pathlib import Path
p = Path(${server_log@Q})
lines = p.read_text(errors="ignore").splitlines() if p.exists() else []
for ln in lines[-200:]:
    print(ln)
PY
    return 1
  fi
  printf 'server_ready_probe=%s\n' "$probe"
}

start_worker() {
  local db_url="postgresql+psycopg://para:para@127.0.0.1:${postgres_port}/para"
  local redis_url="redis://127.0.0.1:${redis_port}/0"

  worker_log="$tmp_dir/celery.log"
  : >"$worker_log"

  setsid bash -c "cd ${repo_root@Q}/server && \
    export ENV=dev && \
    export DATABASE_URL=${db_url@Q} && \
    export CELERY_BROKER_URL=${redis_url@Q} && \
    export CELERY_RESULT_BACKEND=${redis_url@Q} && \
    export WS_REDIS_URL=${redis_url@Q} && \
    export CELERY_TASK_ALWAYS_EAGER=0 && \
    uv run celery -A app.workers.celery_app:celery_app worker -l INFO -c 1" \
    >>"$worker_log" 2>&1 &
  worker_pgid=$!

  printf 'worker_pgid=%s\n' "$worker_pgid"
  printf 'worker_log=%s\n' "$worker_log"

  local probe
  if ! probe="$(wait_file_contains "$worker_log" "ready." 60)"; then
    printf 'ERROR: worker not ready (log did not contain ready.)\n' >&2
    printf 'wait_file_contains_output=%s\n' "$probe" >&2
    printf -- '--- celery.log (tail, start_worker failure) ---\n' >&2
    python3 - <<PY >&2
from pathlib import Path
p = Path(${worker_log@Q})
lines = p.read_text(errors="ignore").splitlines() if p.exists() else []
for ln in lines[-200:]:
    print(ln)
PY
    return 1
  fi
  printf 'worker_ready_probe=%s\n' "$probe"
}

verify_smoke() {
  local node_path="$repo_root/client/node_modules"
  local ws_module_path="$repo_root/client/node_modules/ws"
  if [[ ! -d "$node_path" ]]; then
    die_usage "missing_client_node_modules_expected_at=$node_path (run: npm -C client install)"
  fi
  if [[ ! -d "$ws_module_path" ]]; then
    die_usage "missing_ws_module_expected_at=$ws_module_path"
  fi

  local node_out_file="$tmp_dir/node_ws.log"
  : >"$node_out_file"

  set +e
  NODE_PATH="$node_path" \
    PARA_SERVER_BASE_URL="http://127.0.0.1:${server_port}" \
    PARA_WS_MODULE_PATH="$ws_module_path" \
    node - <<'NODE' | tee "$node_out_file"
const crypto = require('crypto');
const http = require('http');
const wsModulePath = process.env.PARA_WS_MODULE_PATH;
const WS = wsModulePath ? require(wsModulePath) : require('ws');

function must(cond, msg) {
  if (!cond) {
    const err = new Error(msg);
    err.name = 'ASSERT';
    throw err;
  }
}

function httpJson(path, { method = 'GET', token = null, body = null } = {}) {
  const base = process.env.PARA_SERVER_BASE_URL;
  must(base, 'PARA_SERVER_BASE_URL missing');
  const url = new URL(path, base);
  must(url.protocol === 'http:', `only_http_supported_in_beta_qa url=${url.toString()}`);

  const headers = { Accept: 'application/json' };
  let bodyStr = null;
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, text, json });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

function waitForWsType(ws, wantedType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout_waiting_for_ws_type=${wantedType}`));
    }, timeoutMs);

    function onMessage(data) {
      try {
        const str = typeof data === 'string' ? data : data.toString('utf-8');
        const msg = JSON.parse(str);
        if (msg && msg.type === wantedType) {
          cleanup();
          resolve(msg);
        }
      } catch {
        // ignore
      }
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onClose(code, reason) {
      cleanup();
      reject(new Error(`ws_closed_before_${wantedType} code=${code} reason=${reason}`));
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

function waitForWsOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout_waiting_for_ws_open'));
    }, timeoutMs);

    function onOpen() {
      cleanup();
      resolve();
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function onClose(code, reason) {
      cleanup();
      reject(new Error(`ws_closed_before_open code=${code} reason=${reason}`));
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onClose);
    }

    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

async function main() {
  process.stdout.write(`node_version=${process.versions.node}\n`);

  const email = `qa-beta-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.com`;
  const password = 'password123';

  const reg = await httpJson('/api/v1/auth/register', {
    method: 'POST',
    body: { email, password },
  });
  must(reg.status === 201, `register_failed status=${reg.status} body=${reg.text}`);
  const access = reg.json && reg.json.access_token;
  must(typeof access === 'string' && access.length > 0, 'access_token missing');

  const saveResp = await httpJson('/api/v1/saves', {
    method: 'POST',
    token: access,
    body: { name: 'qa-beta-ws-multiproc' },
  });
  must(saveResp.status === 201, `create_save_failed status=${saveResp.status} body=${saveResp.text}`);
  const saveId = saveResp.json && saveResp.json.id;
  must(typeof saveId === 'string' && saveId.length > 0, 'save_id missing');

  const wsUrl = new URL('/ws/v1', process.env.PARA_SERVER_BASE_URL);
  wsUrl.searchParams.set('save_id', saveId);
  wsUrl.searchParams.set('resume_from', '0');
  wsUrl.searchParams.set('device_id', `qa_beta_${crypto.randomBytes(4).toString('hex')}`);

  const finalWsUrl = wsUrl.toString().replace(/^http:/, 'ws:');
  process.stdout.write(`ws_url=${finalWsUrl}\n`);

  const ws = new WS(finalWsUrl, {
    headers: { Authorization: `Bearer ${access}` },
  });

  await waitForWsOpen(ws, 15_000);

  const trigger = await httpJson('/api/v1/dreams/trigger', {
    method: 'POST',
    token: access,
    body: { save_id: saveId, kind: 'dream', content: 'qa-beta ws multiproc smoke' },
  });
  must(trigger.status === 200, `trigger_failed status=${trigger.status} body=${trigger.text}`);
  const taskId = trigger.json && trigger.json.task_id;
  must(typeof taskId === 'string' && taskId.length > 0, 'task_id missing');

  process.stdout.write(`qa_task_id=${taskId}\n`);

   const frame = await waitForWsType(ws, 'TIMELINE_EVENT', 45_000);
   const serverEventId = frame && frame.server_event_id;
   const seq = frame && frame.seq;
   const payloadEvent = frame && frame.payload && frame.payload.event;

   must(typeof serverEventId === 'string' && serverEventId.length > 0, 'server_event_id missing');
   must(typeof seq === 'number' && seq >= 1, `invalid_seq got=${String(seq)}`);
   must(payloadEvent === 'DREAM_ENTRY_CREATED', `unexpected_payload_event got=${String(payloadEvent)}`);

   ws.send(JSON.stringify({ type: 'ACK', cursor: seq }));
   ws.close(1000, 'qa_done');

   const evidence = {
     email,
     save_id: saveId,
     trigger_task_id: taskId,
     ws_frame_type: frame.type,
     ws_frame_seq: seq,
     ws_frame_server_event_id: serverEventId,
     ws_payload_event: payloadEvent,
     assert_ws_timeline_event: true,
     assert_ws_payload_event_is_dream_entry_created: true,
   };
   process.stdout.write(`ws_evidence=${JSON.stringify(evidence)}\n`);
   process.stdout.write('assert_ws_timeline_event=True\n');
   process.stdout.write('assert_ws_payload_event=DREAM_ENTRY_CREATED\n');
 }

main().catch((err) => {
  process.stderr.write(`ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
NODE

  node_rc=${PIPESTATUS[0]}
  set -e

  if (( node_rc != 0 )); then
    printf 'ERROR: node_ws_smoke_failed rc=%s\n' "$node_rc" >&2
    return "$node_rc"
  fi

  local task_id
  task_id="$(python3 - <<PY
from pathlib import Path
import sys

p = Path(${node_out_file@Q})
text = p.read_text(errors="ignore") if p.exists() else ""
task_id = None
for ln in text.splitlines():
    if ln.startswith("qa_task_id="):
        task_id = ln.split("=", 1)[1].strip()
        break
if not task_id:
    sys.exit(1)
print(task_id)
PY
  )"
  printf 'assert_task_id_from_trigger=%s\n' "$task_id"

  wait_file_contains "$worker_log" "$task_id" 30
  printf 'assert_worker_processed_task_id=True\n'
}

verify_evidence() {
  printf '\n--- uvicorn.log (tail) ---\n'
  python3 - <<PY
from pathlib import Path
p = Path(${server_log@Q})
if not p.exists():
    print("(missing)")
else:
    lines = p.read_text(errors="ignore").splitlines()
    for ln in lines[-80:]:
        print(ln)
PY

  printf '\n--- celery.log (tail) ---\n'
  python3 - <<PY
from pathlib import Path
p = Path(${worker_log@Q})
if not p.exists():
    print("(missing)")
else:
    lines = p.read_text(errors="ignore").splitlines()
    for ln in lines[-120:]:
        print(ln)
PY

  printf '\nassert_evidence_file=%s\n' "$evidence_file"
}

plan_steps() {
  STEP_NAMES=(
    "start_deps"
    "run_migrations"
    "start_server"
    "start_worker"
    "verify_smoke"
    "verify_evidence"
  )
  STEP_TITLES=(
    "启动依赖拓扑（deps）"
    "迁移（alembic upgrade head）"
    "启动服务（uvicorn multiproc）"
    "启动 Worker（celery non-eager）"
    "硬验收（WS + Celery 事件可达）"
    "证据/日志摘要（evidence）"
  )
  STEP_CMDS=(
    "docker compose -p <project> up -d postgres redis  # COMPOSE_PROJECT_NAME=<project> POSTGRES_PORT=<dynamic> REDIS_PORT=<dynamic>"
    "cd server && DATABASE_URL=postgresql+psycopg://... uv run alembic upgrade head"
    "cd server && uv run uvicorn app.main:app --workers 2 --host 127.0.0.1 --port <dynamic>"
    "cd server && uv run celery -A app.workers.celery_app:celery_app worker -l INFO -c 1"
    "node(ws) 连接 /ws/v1 并触发 /api/v1/dreams/trigger，等待 TIMELINE_EVENT"
    "写入证据文件 + 输出 server/worker 日志尾部；最后由 trap 清理 docker/进程"
  )
}

print_dry_run() {
  plan_steps
  step_marker "DRY RUN" "将要执行的命令清单（不会执行）"
  printf 'repo_root=%s\n' "$repo_root"
  printf 'evidence_dir=%s\n' "$evidence_dir"
  printf 'evidence_file=%s\n\n' "$evidence_file"
  printf 'NOTE: 实际运行时会用 python3 绑定 127.0.0.1:0 选择动态空闲端口（postgres/redis/server）。\n\n'

  local i
  for ((i = 0; i < ${#STEP_CMDS[@]}; i++)); do
    printf '%2d. [%s] + %s\n' "$((i + 1))" "${STEP_NAMES[$i]}" "${STEP_CMDS[$i]}"
  done
}

run_all() {
  plan_steps

  need_cmd docker
  need_cmd uv
  need_cmd python3
  need_cmd node

  trap cleanup EXIT INT TERM

  compose_project="qa-beta-ws-multiproc-$(date +%s)-$$"
  mapfile -t _ports < <(pick_free_ports_3)
  postgres_port="${_ports[0]}"
  redis_port="${_ports[1]}"
  server_port="${_ports[2]}"
  tmp_dir="$(mktemp -d)"

  step_marker "TASK" "Beta QA Runner（多进程 WS + Celery 事件可达）"
  printf 'repo_root=%s\n' "$repo_root"
  printf 'compose_project=%s\n' "$compose_project"
  printf 'ports: postgres=%s redis=%s server=%s\n' "$postgres_port" "$redis_port" "$server_port"
  printf 'tmp_dir=%s\n' "$tmp_dir"
  printf 'evidence_file=%s\n' "$evidence_file"

  local i
  for ((i = 0; i < ${#STEP_NAMES[@]}; i++)); do
    case "${STEP_NAMES[$i]}" in
      start_deps)
        run_step "${STEP_TITLES[$i]}" "${STEP_CMDS[$i]}" start_deps || return 1
        ;;
      run_migrations)
        run_step "${STEP_TITLES[$i]}" "${STEP_CMDS[$i]}" run_migrations || return 1
        ;;
      start_server)
        run_step "${STEP_TITLES[$i]}" "${STEP_CMDS[$i]}" start_server || return 1
        ;;
      start_worker)
        run_step "${STEP_TITLES[$i]}" "${STEP_CMDS[$i]}" start_worker || return 1
        ;;
      verify_smoke)
        run_step "${STEP_TITLES[$i]}" "${STEP_CMDS[$i]}" verify_smoke || return 1
        ;;
      verify_evidence)
        run_step "${STEP_TITLES[$i]}" "${STEP_CMDS[$i]}" verify_evidence || return 1
        ;;
      *)
        return 1
        ;;
    esac
  done

  step_marker "TASK" "ALL GREEN"
}

dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      die_usage "unknown_arg=$1"
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  die_usage "unexpected_extra_args=$*"
fi

if (( dry_run == 1 )); then
  print_dry_run
  exit 0
fi

mkdir -p "$evidence_dir"

set +e
run_all 2>&1 | tee "$evidence_file"
rc=${PIPESTATUS[0]}
set -e

exit "$rc"
