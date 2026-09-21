#!/usr/bin/env bash
#
# Manual installer for the opencode-memory plugin.
#
# Downloads a release archive, installs its two search backends, and places
# the payload into an OpenCode plugins directory.
#
#   curl -fsSL https://raw.githubusercontent.com/nedy13/opencode-memory/main/scripts/install.sh | bash
#
# Order matters: OpenCode loads a plugin the moment it appears in a watched
# plugins directory. If it loads before node_modules/ exists, Bun caches a
# failed module resolution for that directory and both search backends stay
# unavailable until the server restarts — memory_search then silently returns
# nothing. So the payload is staged in a temp directory, has its dependencies
# installed there, and is only then moved into place.
#
set -euo pipefail

REPO="${OPENCODE_MEMORY_REPO:-nedy13/opencode-memory}"
TAG=""
PLUGINS_DIR="${HOME}/.config/opencode/plugins"
MEMORY_DIR="${OPENCODE_MEMORY_DIR:-${HOME}/opencode-memory}"
SKILLS_DIR="${HOME}/.agents/skills"
SKIP_MODEL=0
SKIP_SKILL=0

CATEGORIES=(preferences repos technical people workflows snippets notes)

usage() {
  cat <<'EOF'
Install the opencode-memory plugin from a GitHub release.

Usage: install.sh [options]

  --tag <tag>        Release tag to install (default: newest release,
                     including prereleases)
  --repo <own/repo>  Source repository (default: nedy13/opencode-memory)
  --project <path>   Install into <path>/.opencode/plugins instead of the
                     global ~/.config/opencode/plugins
  --plugins-dir <p>  Install into an explicit plugins directory
  --memory-dir <p>   Memory root (default: ~/opencode-memory)
  --skip-model       Do not download the ~90MB embedding model
  --skip-skill       Do not symlink the skill into ~/.agents/skills
  -h, --help         Show this help

Requires: curl, tar, git, and one of bun or npm.
EOF
}

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)         TAG="${2:?--tag needs a value}"; shift 2 ;;
    --repo)        REPO="${2:?--repo needs a value}"; shift 2 ;;
    --project)     PLUGINS_DIR="${2:?--project needs a value}/.opencode/plugins"; shift 2 ;;
    --plugins-dir) PLUGINS_DIR="${2:?--plugins-dir needs a value}"; shift 2 ;;
    --memory-dir)  MEMORY_DIR="${2:?--memory-dir needs a value}"; shift 2 ;;
    --skip-model)  SKIP_MODEL=1; shift ;;
    --skip-skill)  SKIP_SKILL=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option: $1 (try --help)" ;;
  esac
done

# --- prerequisites -----------------------------------------------------

for cmd in curl tar git; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is required but not installed."
done

# Dependencies are plain npm packages, so either package manager works. Bun is
# preferred only because OpenCode itself is a Bun program.
if command -v bun >/dev/null 2>&1; then
  PKG_MANAGER="bun"
elif command -v npm >/dev/null 2>&1; then
  PKG_MANAGER="npm"
else
  die "need bun or npm to install the search backends.
  Ubuntu:  sudo apt install npm
  or bun:  curl -fsSL https://bun.sh/install | bash"
fi

# The bundled CLI imports bun:sqlite, so it only runs under Bun. Without Bun
# the same bootstrap is done in shell further below.
HAVE_BUN=0
[ "$PKG_MANAGER" = "bun" ] && HAVE_BUN=1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- resolve the release asset ----------------------------------------

api() {
  # GH_TOKEN is optional; it only raises the anonymous rate limit.
  if [ -n "${GH_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer ${GH_TOKEN}" "$@"
  else
    curl -fsSL "$@"
  fi
}

if [ -n "$TAG" ]; then
  log "Looking up release $TAG in $REPO"
  RELEASE_JSON="$(api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")" \
    || die "release '$TAG' not found in $REPO"
else
  # /releases/latest skips prereleases, so take the newest entry from the list.
  log "Looking up the newest release in $REPO"
  RELEASE_JSON="$(api "https://api.github.com/repos/${REPO}/releases?per_page=1")" \
    || die "could not query releases for $REPO"
fi

ASSET_URL="$(printf '%s' "$RELEASE_JSON" \
  | grep -o '"browser_download_url": *"[^"]*opencode-memory-plugin-[^"]*\.tar\.gz"' \
  | head -1 | sed 's/.*"\(https[^"]*\)"$/\1/')"

[ -n "$ASSET_URL" ] || die "no opencode-memory-plugin-*.tar.gz asset found.
  The release must be built by the Build workflow; a plain source tarball
  will not work because it contains no dist/ directory."

log "Downloading $(basename "$ASSET_URL")"
curl -fsSL -o "$TMP/payload.tar.gz" "$ASSET_URL"

# --- stage and install dependencies (before going live) ---------------

mkdir -p "$TMP/stage"
tar -xzf "$TMP/payload.tar.gz" -C "$TMP/stage"

STAGED="$TMP/stage/opencode-memory"
[ -f "$STAGED/index.js" ] || die "archive layout unexpected: $STAGED/index.js is missing"

log "Installing search backends with $PKG_MANAGER"
# --omit=peer matters: the optional typing peers pull in the whole OpenCode
# SDK and inflate the install from ~46MB to ~640MB.
if [ "$PKG_MANAGER" = "bun" ]; then
  ( cd "$STAGED" && bun install --production --omit=peer --omit=dev )
else
  ( cd "$STAGED" && npm install --omit=dev --omit=peer --no-audit --no-fund )
fi

RG_BIN="$(find "$STAGED/node_modules" -type f -path '*/bin/rg' 2>/dev/null | head -1 || true)"
RAG_SHIM="$STAGED/node_modules/@mathew-cf/rag-cli/bin/rag.js"
[ -n "$RG_BIN" ] || warn "ripgrep binary not found — keyword search will be unavailable"
[ -f "$RAG_SHIM" ] || warn "rag shim not found — semantic search will be unavailable"

# --- move into place ---------------------------------------------------

TARGET="$PLUGINS_DIR/opencode-memory"
mkdir -p "$PLUGINS_DIR"

REPLACED=0
if [ -e "$TARGET" ]; then
  log "Replacing existing install at $TARGET"
  rm -rf "$TARGET"
  REPLACED=1
fi

mv "$STAGED" "$TARGET"
log "Installed plugin to $TARGET"

# Re-point at the installed tree; the staged paths are gone after the move.
RAG_SHIM="$TARGET/node_modules/@mathew-cf/rag-cli/bin/rag.js"

# --- memory directory --------------------------------------------------

if [ "$HAVE_BUN" -eq 1 ]; then
  log "Bootstrapping memory directory via the bundled CLI"
  INIT_ARGS=(init)
  [ "$SKIP_MODEL" -eq 1 ] && INIT_ARGS+=(--skip-model)
  [ "$SKIP_SKILL" -eq 1 ] && INIT_ARGS+=(--skip-skills)
  OPENCODE_MEMORY_DIR="$MEMORY_DIR" bun "$TARGET/dist/cli.js" "${INIT_ARGS[@]}"
else
  # Same work as `cli.js init`, minus the Bun dependency.
  log "Bootstrapping memory directory at $MEMORY_DIR"
  mkdir -p "$MEMORY_DIR"
  if [ ! -d "$MEMORY_DIR/.git" ]; then
    git -C "$MEMORY_DIR" init -q
  fi
  for cat in "${CATEGORIES[@]}"; do
    mkdir -p "$MEMORY_DIR/$cat"
    [ -f "$MEMORY_DIR/$cat/.gitkeep" ] || : > "$MEMORY_DIR/$cat/.gitkeep"
  done

  if [ "$SKIP_SKILL" -eq 0 ]; then
    mkdir -p "$SKILLS_DIR"
    LINK="$SKILLS_DIR/opencode-memory"
    SKILL_SRC="$TARGET/skills/opencode-memory"
    if [ -L "$LINK" ] || [ ! -e "$LINK" ]; then
      ln -sfn "$SKILL_SRC" "$LINK"
      log "Skill symlinked: $LINK"
    else
      warn "$LINK exists and is not a symlink — left untouched"
    fi
  fi

  if [ "$SKIP_MODEL" -eq 0 ] && [ -f "$RAG_SHIM" ]; then
    if command -v node >/dev/null 2>&1; then
      log "Downloading the embedding model (~90MB)"
      node "$TARGET/node_modules/@mathew-cf/rag-cli/bin/rag.js" download
    else
      warn "node not found — skipping model download.
  Fetch it later with:
    node $TARGET/node_modules/@mathew-cf/rag-cli/bin/rag.js download"
    fi
  fi
fi

# --- done --------------------------------------------------------------

echo
log "Done. Verify with:"
echo "    opencode plugin list        # expect: opencode-memory"
echo

if [ "$REPLACED" -eq 1 ]; then
  warn "An earlier install was replaced. Restart OpenCode so it drops the old
  module from memory:
    opencode service restart"
fi

cat <<EOF
Notes:
  - Installing both globally and per project fails the second one with
    "Duplicate plugin ID: opencode-memory". Pick one.
  - If memory_setup reports the backends as NOT resolvable, run
    'opencode service restart' once.
EOF
