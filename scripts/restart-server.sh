#!/usr/bin/env bash
# helper for local verification: (re)start the production server on 127.0.0.1:4173
cd "$(dirname "$0")/.."
PID=$(ss -ltnp 2>/dev/null | grep ':4173' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
[ -n "$PID" ] && kill "$PID" && sleep 2
rm -rf timemachine
SWY_TM_DIR="$PWD/timemachine" nohup npx next start -H 127.0.0.1 -p 4173 >/tmp/next-start.log 2>&1 &
sleep 5; tail -2 /tmp/next-start.log
