#!/usr/bin/env bash
set -euo pipefail

# Virtual display: Meet/Teams need a "real" display even when nobody looks at it.
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
export DISPLAY=:99

# dbus (Chromium/PulseAudio complain without it) — start it before Pulse.
mkdir -p /run/dbus
dbus-daemon --system --fork || true

# ── DETERMINISTIC virtual audio ──────────────────────────────────────────────
# The "57-minute silent audio" bug: if Chromium opens its output stream BEFORE
# MeetingSink exists and is the default, it sticks to `auto_null` (the dummy sink
# of module-always-sink) and `MeetingSink.monitor` — where ffmpeg captures from —
# stays silent for the whole call. Changing the default AFTERWARDS does not move
# an already-connected stream. Here we make sure, race-free, that MeetingSink
# exists, is the ONLY possible destination and is the default BEFORE anything
# plays audio. If anything essential fails we exit with an error (the machine
# dies instead of recording silence; the reapStaleDispatches watchdog reaps the
# meeting stuck in bot_scheduled).
pulseaudio --start --exit-idle-time=-1 --disallow-exit --log-target=stderr || true

# 1) Wait for the daemon to be READY before touching modules. Previously
#    load-module ran after a fixed `sleep 1` and could catch Pulse still starting.
ready=0
for _ in $(seq 1 40); do
  if pactl info >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.25
done
if [ "$ready" != 1 ]; then
  echo "FATAL: PulseAudio was not ready within 10s" >&2
  exit 1
fi

# 2) Create MeetingSink. Without it there is nothing to capture → fail loudly.
if ! pactl load-module module-null-sink \
      sink_name=MeetingSink \
      sink_properties=device.description=MeetingSink >/dev/null; then
  echo "FATAL: could not create the MeetingSink" >&2
  exit 1
fi

# 3) Close the ESCAPE ROUTES so Chromium has nowhere else to go:
#    - module-always-sink recreates auto_null when it thinks a sink is "missing";
#    - module-suspend-on-idle may suspend the sink and dry up the monitor.
for mod in module-always-sink module-suspend-on-idle; do
  pactl unload-module "$mod" 2>/dev/null || true
done

# 4) Set the default and VERIFY it took (it used to be fire-and-forget). The
#    `|| true` in the substitution keeps pipefail from aborting before the
#    explicit check below (which gives the clear message).
pactl set-default-sink MeetingSink || { echo "FATAL: set-default-sink MeetingSink failed" >&2; exit 1; }
def="$(pactl info 2>/dev/null | sed -n 's/^Default Sink: //p' || true)"
if [ "$def" != MeetingSink ]; then
  echo "FATAL: the default sink is '${def:-<none>}', expected MeetingSink" >&2
  exit 1
fi

echo "PulseAudio OK: MeetingSink is the default and only sink (no auto_null / suspend-on-idle)" >&2

exec "$@"
