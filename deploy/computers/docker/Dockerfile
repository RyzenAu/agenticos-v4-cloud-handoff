# The shared-computer image for the `docker` adapter (scripts/computers/docker.ts). NOT BUILT: Docker is not installed on the PC that
# wrote this. Build it on the host that has Docker, push or load it, then pin the result by digest (`name@sha256:...`): the adapter
# refuses a tag. Everything the computer does is deploy/computers/linux/computer-ctl.sh, run inside the container with `docker exec`.
FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb chromium x11vnc xdotool fonts-liberation nodejs ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
# Debian 13 ships Node 20; the companion needs 22 (global WebSocket). Replace this layer with your chosen Node 22 source (owner decision).
RUN useradd --create-home --home-dir /home/mu --shell /bin/bash mu
USER mu
WORKDIR /home/mu
ENV MU_COMPUTERS_HOME=/home/mu/mu-computers MU_COMPUTER_NO_SANDBOX=1
# The container runs as an unprivileged user with every capability dropped, so Chromium's own sandbox cannot start: the container
# (namespaces, cap-drop, no-new-privileges, limits) is the boundary, which is why MU_COMPUTER_NO_SANDBOX is set here and only here.
CMD ["sleep", "infinity"]
