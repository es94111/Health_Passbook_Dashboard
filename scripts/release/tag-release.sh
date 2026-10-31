#!/usr/bin/env bash
# 建立並推送 vX.Y.Z 標籤，觸發 GitHub Actions 發佈 Docker image 與 GitHub Release。
#
# 用法：
#   bash scripts/release/tag-release.sh          # 預覽（不推送）
#   bash scripts/release/tag-release.sh --yes    # 建立並推送標籤
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

confirm=0
for arg in "$@"; do
  case "$arg" in
    -y | --yes) confirm=1 ;;
    -h | --help)
      sed -n '2,7p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "未知參數：$arg" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "✖ $*" >&2
  exit 1
}

[ -z "$(git status --porcelain)" ] || fail "工作目錄有未提交的變更，請先提交或 stash"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || fail "請在 main 分支發版（目前為 ${branch}）"

git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
  fail "本機 main 與 origin/main 不一致，請先 git pull"

version="$(node -e "process.stdout.write(require('./changelog.json').currentVersion)")"
tag="v${version}"

if git rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null; then
  fail "本機已存在標籤 ${tag}"
fi
if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
  fail "遠端已存在標籤 ${tag}"
fi

node scripts/release/check-version.mjs "$tag"
node scripts/release/release-notes.mjs --tag "$tag"

echo
echo "即將建立並推送標籤：${tag}"
echo "推送後 GitHub Actions 會建置 Docker image 並建立 GitHub Release。"
echo
if [ "$confirm" -ne 1 ]; then
  echo "這是預覽。確認無誤後執行：npm run release:tag -- --yes"
  exit 0
fi

git tag -a "$tag" -m "${tag}"
git push origin "$tag"

echo
echo "✔ 已推送 ${tag}。查看發佈進度："
echo "  gh run list --workflow docker-publish.yml --limit 1"
