#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
cd /home/runner

fail() { printf '%s\n' "$*" >&2; exit 1; }

registered() {
    [[ -s .runner && -s .credentials && -f .registration-complete ]] || return 1
    jq -e '.agentName == env.RUNNER_NAME and
        .gitHubUrl == ("https://github.com/" + env.RUNNER_REPOSITORY)' .runner >/dev/null
}

read_token() {
    IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN || [[ -n "${ACTIONS_RUNNER_INPUT_TOKEN:-}" ]]
    [[ -n "${ACTIONS_RUNNER_INPUT_TOKEN:-}" ]] || fail 'Expected an ephemeral token on stdin.'
    export ACTIONS_RUNNER_INPUT_TOKEN
    trap 'unset ACTIONS_RUNNER_INPUT_TOKEN' EXIT
}

case "${1:-start}" in
    start)
        [[ "$(uname -m)" == x86_64 ]] || fail 'This runner must execute as Linux/x64.'
        mkdir -p "$TMPDIR"
        printf 'Waiting for the dedicated Docker daemon and runner registration.\n'
        until docker info >/dev/null 2>&1; do sleep 2; done
        until registered; do
            if [[ -f .registration-complete ]]; then
                fail 'Stored registration differs from RUNNER_REPOSITORY/RUNNER_NAME; restore configuration or unregister first.'
            fi
            sleep 2
        done
        exec ./run.sh
        ;;
    is-registered)
        registered
        ;;
    register)
        [[ ! -e .runner && ! -e .credentials ]] || fail 'Registration already exists; refusing to replace it.'
        read_token
        ./config.sh --unattended --url "https://github.com/$RUNNER_REPOSITORY" \
            --name "$RUNNER_NAME" --labels dependabot --work _work
        unset ACTIONS_RUNNER_INPUT_TOKEN
        chmod 0600 .runner .credentials .credentials_rsaparams
        touch .registration-complete
        registered
        ;;
    unregister)
        registered || fail 'No matching local registration; refusing removal.'
        read_token
        ./config.sh remove --unattended
        unset ACTIONS_RUNNER_INPUT_TOKEN
        rm -f .registration-complete
        ;;
    health)
        registered || exit 1
        docker info >/dev/null 2>&1 || exit 1
        # Rosetta exposes its translator in /proc/*/exe, not the x64 executable.
        for cmdline in /proc/[0-9]*/cmdline; do
            if IFS= read -r -d '' executable < "$cmdline" 2>/dev/null; then
                [[ "$executable" == /home/runner/bin/Runner.Listener ]] && exit 0
            fi
        done
        exit 1
        ;;
    verify)
        [[ "$(uname -m)" == x86_64 ]] || fail 'Runner architecture is not x64.'
        [[ "$(id -u)" == 1001 ]] || fail 'Runner must not run as root.'
        docker info --format 'Dedicated Docker: {{.OSType}}/{{.Architecture}}, {{.Driver}}'
        mkdir -p "$TMPDIR"
        probe="$TMPDIR/docker-bind-check-$$"
        mkdir "$probe"
        trap 'rm -f "$probe/marker" "$probe/result"; rmdir "$probe"' EXIT
        printf 'shared-workspace\n' > "$probe/marker"
        docker run --rm --platform linux/amd64 --user 1001:1001 \
            --cap-drop ALL --security-opt no-new-privileges \
            --mount "type=bind,src=$probe,dst=$probe" \
            alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63 \
            sh -ec 'test "$(uname -m)" = x86_64; test "$(cat "$1/marker")" = shared-workspace; printf nested-container-ok > "$1/result"' sh "$probe"
        [[ "$(cat "$probe/result")" == nested-container-ok ]] || fail 'Nested Docker bind mount did not share the workspace.'
        printf 'Verified non-root Linux/x64 runner and nested x64 Docker read/write at identical absolute workspace paths.\n'
        ;;
    *) fail 'Unknown runner operation.' ;;
esac
