# OpenBao policy for the APP runtime role (container / AppRole).
# The app only ever READS its own secrets; rotation is done by the rotation
# role / workflow with a separate policy.

# Runtime env injection (entrypoint) and the AI proxy's server-side secrets.
path "kv/data/apps/mediprisma/*" {
  capabilities = ["read", "list"]
}
