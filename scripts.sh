#!/bin/sh
# Build helper for Redew.
#
# Unlike Fusion, Redew's frontend has no build step: it's plain HTML/CSS/JS
# already sitting in backend/internal/web/dist, embedded directly into the
# Go binary via //go:embed. So "building Redew" is just "building the Go
# binary" — there is no frontend bundler in this pipeline at all.

set -eu

resolve_version() {
  if [ -n "${REDEW_VERSION:-}" ]; then
    printf '%s\n' "$REDEW_VERSION"
    return
  fi
  if git describe --tags --abbrev=0 >/dev/null 2>&1; then
    git describe --tags --abbrev=0
    return
  fi
  git rev-parse --short HEAD
}

test_backend() {
  echo "testing backend"
  (cd backend && go test ./...)
}

build_backend() {
  target_os=${1:-$(cd backend && go env GOOS)}
  target_arch=${2:-$(cd backend && go env GOARCH)}
  root=$(pwd)
  output_path=${3:-"${root}/build/redew"}

  case "$output_path" in
  /*) ;;
  *) output_path="${root}/${output_path#./}" ;;
  esac

  if [ ! -f backend/internal/web/dist/index.html ]; then
    echo "frontend files not found at backend/internal/web/dist/index.html"
    exit 1
  fi

  version=$(resolve_version)
  echo "building backend for OS: ${target_os}, Arch: ${target_arch}, Output: ${output_path} (version ${version})"

  mkdir -p "$(dirname "$output_path")"
  (
    cd backend
    CGO_ENABLED=0 GOOS="${target_os}" GOARCH="${target_arch}" go build \
      -trimpath \
      -ldflags "-s -w -X main.version=${version}" \
      -o "$output_path" \
      ./cmd/redew
  )
}

release() {
  echo "building release artifacts"
  rm -rf ./dist
  mkdir -p ./dist

  platforms="linux/amd64 darwin/arm64 windows/amd64"

  for platform in $platforms; do
    os=${platform%/*}
    arch=${platform#*/}
    echo "--- building ${os}/${arch} ---"

    bin_name="redew"
    if [ "$os" = "windows" ]; then
      bin_name="redew.exe"
    fi

    build_backend "$os" "$arch" "./dist/${bin_name}"

    archive="redew_${os}_${arch}.zip"
    zip -j "./dist/${archive}" "./dist/${bin_name}" README.md
    rm "./dist/${bin_name}"
  done

  (
    cd ./dist
    sha256sum ./*.zip > checksums.txt
  )

  echo "release artifacts:"
  ls -lh ./dist/
}

build() {
  test_backend
  build_backend
}

usage() {
  cat <<'EOF'
Usage: ./scripts.sh <command>

Commands:
  test-backend             Run backend tests
  build-backend [os] [arch] [output]
                           Build backend binary (frontend is static, no build step)
  build                    Run backend tests and build for the host platform
  release                  Build release archives and checksums for all platforms
EOF
}

case "${1:-}" in
"test" | "test-backend")
  test_backend
  ;;
"build-backend")
  build_backend "${2:-}" "${3:-}" "${4:-}"
  ;;
"build")
  build
  ;;
"release")
  release
  ;;
*)
  usage
  exit 1
  ;;
esac
