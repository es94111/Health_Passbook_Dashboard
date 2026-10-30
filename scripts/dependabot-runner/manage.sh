#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

fail() { printf '%s\n' "$*" >&2; exit 1; }
compose() { docker compose -f compose.yaml "$@"; }
runner() { compose exec -T runner /usr/local/bin/dependabot-runner "$@"; }

configuration() {
    command -v docker >/dev/null || fail 'Docker Desktop is required.'
    command -v jq >/dev/null || fail 'jq is required.'
    local config
    config=$(compose config --format json)
    repository=$(printf '%s' "$config" | jq -er '.services.runner.environment.RUNNER_REPOSITORY')
    runner_name=$(printf '%s' "$config" | jq -er '.services.runner.environment.RUNNER_NAME')
    [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'Invalid RUNNER_REPOSITORY.'
    [[ "$runner_name" =~ ^[A-Za-z0-9_.-]+$ ]] || fail 'Invalid RUNNER_NAME.'
}

github() {
    command -v gh >/dev/null || fail 'GitHub CLI authenticated as a repository administrator is required.'
    local path=$1
    shift
    gh api "repos/$repository/$path" "$@"
}

runner_id() {
    compose exec -T runner jq -er .agentId /home/runner/.runner
}

require_idle() {
    local id state
    id=$(runner_id)
    state=$(github "actions/runners/$id")
    [[ "$(printf '%s' "$state" | jq -r .name)" == "$runner_name" ]] || fail 'Runner identity mismatch; refusing to stop it.'
    [[ "$(printf '%s' "$state" | jq -r .busy)" == false ]] || fail 'Runner is busy; wait for its current job before stopping or re-registering.'
}

online() {
    local id attempt state
    id=$(runner_id)
    for ((attempt = 0; attempt < 30; attempt++)); do
        state=$(github "actions/runners/$id")
        if [[ "$(printf '%s' "$state" | jq -r .status)" == online ]]; then
            printf '%s' "$state" | jq '{id,name,os,status,busy,labels:[.labels[].name]}'
            return
        fi
        sleep 2
    done
    fail 'Runner did not become online; inspect ./manage.sh logs.'
}

setup() {
    local existing private
    private=$(gh api "repos/$repository" --jq .private)
    [[ "$private" == true ]] || fail 'Dependabot self-hosted runners require a private repository.'
    compose build --pull runner
    compose up --detach --wait --wait-timeout 180 docker
    compose up --detach runner
    runner verify
    if ! runner is-registered; then
        existing=$(github 'actions/runners?per_page=100' --paginate \
            --jq ".runners[] | select(.name == \"$runner_name\") | .id")
        [[ -z "$existing" ]] || fail 'A runner with this name already exists; restore its volume or remove that specific stale runner first. No replacement was attempted.'
        # Only the short-lived registration token crosses stdin; gh credentials stay on the Mac.
        github actions/runners/registration-token --method POST --jq .token | runner register
    fi
    compose up --detach --wait --wait-timeout 180 runner
    online
}

unregister() {
    require_idle
    compose stop runner
    github actions/runners/remove-token --method POST --jq .token | \
        compose run --rm --no-deps -T runner unregister
    compose stop docker
    printf 'Unregistered only this runner. Named volumes were retained.\n'
}

case "${1:-help}" in
    setup)
        configuration
        command -v gh >/dev/null || fail 'Install and authenticate GitHub CLI first.'
        setup
        ;;
    start)
        configuration
        compose up --detach --wait --wait-timeout 180
        online
        ;;
    stop)
        configuration
        require_idle
        compose stop runner docker
        ;;
    status)
        configuration
        compose ps
        id=$(runner_id)
        github "actions/runners/$id" --jq '{id,name,os,status,busy,labels:[.labels[].name]}'
        ;;
    verify)
        configuration
        runner verify
        online
        ;;
    unregister)
        configuration
        unregister
        ;;
    reregister)
        configuration
        unregister
        setup
        ;;
    logs)
        configuration
        compose logs --tail 100
        ;;
    help|--help|-h)
        printf 'Usage: %s {setup|start|stop|status|verify|unregister|reregister|logs}\n' "$0"
        printf 'Uses dedicated Compose services/volumes; never replaces other runners or deletes volumes.\n'
        ;;
    *) fail 'Unknown command; use --help.' ;;
esac
