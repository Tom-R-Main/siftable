#!/bin/sh
set -eu
# Bind-mounted credentials/backups must belong to the invoking host user, not
# container root. Derive the identity from the private directory, never a fixed UID.
if [ "$(id -u)" = 0 ]; then
  exec su-exec "$(stat -c '%u:%g' /run/sift)" node packages/cli/dist/index.js "$@"
fi
exec node packages/cli/dist/index.js "$@"
