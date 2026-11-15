# OpenBao policy for CI + rotation (GitHub Actions OIDC / rotation role).
# Read-only on CI credentials; create/update only on the app secret tree so the
# rotation workflow can write new KV versions.

path "kv/data/ci/*" {
  capabilities = ["read"]
}

path "kv/data/apps/mediprisma/*" {
  capabilities = ["read", "update"]
}
