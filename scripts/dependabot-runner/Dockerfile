FROM ghcr.io/actions/actions-runner:2.338.2@sha256:759a1d94a15b05941aba5196974ff43fe15b4cbba29b694b35cbc32a1166b232

USER root
RUN mkdir -p /home/runner/_work/_temp /run/runner-docker \
    && chown -R 1001:1001 /home/runner/_work \
    && chmod 0750 /home/runner
COPY --chmod=0755 runner-entrypoint.sh /usr/local/bin/dependabot-runner
USER 1001:1001
WORKDIR /home/runner
ENV ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=0 \
    DOCKER_HOST=unix:///run/runner-docker/docker.sock \
    DOCKER_DEFAULT_PLATFORM=linux/amd64 \
    TMPDIR=/home/runner/_work/_temp
ENTRYPOINT ["/usr/local/bin/dependabot-runner"]
CMD ["start"]
