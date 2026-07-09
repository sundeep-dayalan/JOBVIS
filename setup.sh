#!/usr/bin/env bash
#
# JOBVIS — First-Run Setup Wizard
# ================================
# One-time interactive bootstrap. Run this ONCE after cloning:
#     ./setup.sh
# Then launch anytime with:
#     ./start.sh
#
# It checks prerequisites, creates your .env, installs the server + UI
# dependencies, and flags the config files you still need to edit.
# Safe to re-run — anything already configured is left untouched.

set -uo pipefail

# ── Locate repo root (this script's directory) ───────────────────────────────
cd "$(dirname "$0")"
ROOT="$(pwd)"

# ── Colors (disabled when not a TTY) ─────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YEL=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; CYN=""; RST=""
fi

ok()   { printf "  ${GRN}✓${RST} %s\n" "$1"; }
warn() { printf "  ${YEL}!${RST} %s\n" "$1"; }
err()  { printf "  ${RED}✗${RST} %s\n" "$1"; }
step() { printf "\n${BOLD}${CYN}%s${RST}\n" "$1"; }

FAIL=0

clear 2>/dev/null || true
printf "${BOLD}==============================================${RST}\n"
printf "${BOLD}         JOBVIS — First-Run Setup             ${RST}\n"
printf "${BOLD}==============================================${RST}\n"

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
step "[1/5] Checking prerequisites"

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "Docker is installed and running"
  else
    err "Docker is installed but the daemon isn't running — start Docker Desktop, then re-run"
    FAIL=1
  fi
else
  err "Docker not found — install Docker Desktop (needed for the PostgreSQL container)"
  FAIL=1
fi

if docker compose version >/dev/null 2>&1; then
  ok "docker compose available"
else
  warn "'docker compose' plugin not detected — you may be on the legacy 'docker-compose'"
fi

if command -v python3 >/dev/null 2>&1; then
  PYV="$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo '?')"
  if python3 -c 'import sys;exit(0 if sys.version_info[:2]>=(3,11) else 1)' 2>/dev/null; then
    ok "Python $PYV"
  else
    warn "Python $PYV found — 3.11+ recommended"
  fi
else
  err "python3 not found — install Python 3.11+"
  FAIL=1
fi

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  ok "Node $(node -v) / npm $(npm -v)"
else
  err "Node.js / npm not found — install Node 18+"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  printf "\n${RED}${BOLD}Fix the missing prerequisites above, then re-run ./setup.sh${RST}\n\n"
  exit 1
fi

# ── 2. Environment (.env + LLM provider) ─────────────────────────────────────
step "[2/5] Configuring environment (.env)"

set_env_var() {
  # set_env_var KEY VALUE — replaces KEY's line in .env, or appends if missing
  local key="$1" val="$2" file="$ROOT/.env"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$file" && rm -f "$file.bak"
  else
    printf "%s=%s\n" "$key" "$val" >> "$file"
  fi
}

if [ -f "$ROOT/.env" ]; then
  ok ".env already exists — leaving it untouched"
elif [ -f "$ROOT/.env.example" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  ok "Created .env from .env.example"
else
  : > "$ROOT/.env"
  warn "No .env.example found — created an empty .env"
fi

printf "\n  Which LLM provider will you use?\n"
printf "    ${BOLD}1${RST}) Gemini  (cloud, default) — needs a Google API key\n"
printf "    ${BOLD}2${RST}) Groq    (cloud)          — needs a Groq API key\n"
printf "    ${BOLD}3${RST}) Ollama  (local)          — no key; requires Ollama running\n"
printf "    ${BOLD}4${RST}) MLX     (local, Apple)   — no key; requires an mlx_lm server\n"
read -rp "  Choice [1]: " CH
CH="${CH:-1}"

case "$CH" in
  1)
    read -rp "  Paste your GEMINI_API_KEY (or press Enter to add it later): " K
    if [ -n "${K:-}" ]; then
      set_env_var "GEMINI_API_KEY" "$K"; ok "Saved GEMINI_API_KEY to .env"
    else
      warn "Skipped — add GEMINI_API_KEY to .env before launching"
    fi
    ok "config/llm_config.yml already defaults to Gemini — no change needed"
    ;;
  2)
    read -rp "  Paste your GROQ_API_KEY (or press Enter to add it later): " K
    if [ -n "${K:-}" ]; then
      set_env_var "GROQ_API_KEY" "$K"; ok "Saved GROQ_API_KEY to .env"
    else
      warn "Skipped — add GROQ_API_KEY to .env before launching"
    fi
    warn "In config/llm_config.yml: uncomment the 'groq' provider block and comment out 'gemini'"
    ;;
  3)
    ok "Ollama needs no API key"
    warn "In config/llm_config.yml: uncomment an 'ollama' block (comment out 'gemini'); make sure 'ollama serve' is running"
    ;;
  4)
    ok "MLX needs no API key"
    warn "In config/llm_config.yml: uncomment the 'mlx' block (comment out 'gemini'); start it with 'mlx_lm.server'"
    ;;
  *)
    warn "Unrecognized choice — defaulting to Gemini; add GEMINI_API_KEY to .env"
    ;;
esac

# ── 3. Server dependencies (Python venv) ─────────────────────────────────────
step "[3/5] Installing server dependencies"
if [ -d "$ROOT/apps/server/venv" ]; then
  ok "Python venv already exists — skipping (delete apps/server/venv to rebuild)"
else
  if python3 -m venv "$ROOT/apps/server/venv"; then
    ok "Created Python venv"
  else
    err "Failed to create venv"; FAIL=1
  fi
fi

if [ -d "$ROOT/apps/server/venv" ]; then
  printf "  ${DIM}installing requirements (this can take a minute)...${RST}\n"
  "$ROOT/apps/server/venv/bin/pip" install -q --upgrade pip >/dev/null 2>&1 || true
  if "$ROOT/apps/server/venv/bin/pip" install -q -r "$ROOT/apps/server/requirements.txt"; then
    ok "Server dependencies installed"
  else
    err "pip install failed — see output above"; FAIL=1
  fi
fi

# ── 4. Dashboard UI dependencies (npm) ───────────────────────────────────────
step "[4/5] Installing dashboard UI dependencies"
if [ -d "$ROOT/apps/ui/node_modules" ]; then
  ok "node_modules already present — skipping (delete apps/ui/node_modules to reinstall)"
else
  printf "  ${DIM}running npm install...${RST}\n"
  if (cd "$ROOT/apps/ui" && npm install --silent); then
    ok "UI dependencies installed"
  else
    err "npm install failed — see output above"; FAIL=1
  fi
fi

# ── 5. Candidate profile for AI scoring ──────────────────────────────────────
step "[5/5] Your candidate profile (drives the AI job scoring)"

PROMPT_FILE="$ROOT/apps/server/prompts/JobMatchAnalyst.md"
PROFILE_TOKENS='<MIN_YEARS>|<WORK_AUTH>|<CLEARANCE>|<ALLOWED_LOCATIONS>|<EMPLOYMENT_TYPE>|<SALARY_FLOOR>'

DO_PROFILE=1
if [ ! -f "$PROMPT_FILE" ]; then
  warn "Prompt file not found — skipping profile setup"
  DO_PROFILE=0
elif ! grep -qE "$PROFILE_TOKENS" "$PROMPT_FILE"; then
  printf "  Your CANDIDATE PROFILE already appears configured.\n"
  read -rp "  Re-configure it? [y/N]: " RC
  case "${RC:-N}" in [Yy]*) DO_PROFILE=1 ;; *) DO_PROFILE=0; ok "Keeping the existing profile" ;; esac
fi

if [ "$DO_PROFILE" -eq 1 ]; then
  printf "  ${DIM}Answer each line, or press Enter to SKIP it. Skipped items are left out\n  entirely — the matching knockout gate then passes automatically.${RST}\n\n"

  read -rp "  Experience range in years     [e.g. 3-5]                          : " P_EXP
  read -rp "  Work authorization            [e.g. Needs H-1B sponsorship]       : " P_AUTH
  read -rp "  Security clearance            [e.g. No clearance eligibility]     : " P_CLR
  read -rp "  Allowed locations             [e.g. WA state or fully remote USA] : " P_LOC
  read -rp "  Employment type               [e.g. Full-time only]              : " P_EMP
  read -rp "  Minimum salary floor / year   [e.g. \$150,000]                    : " P_SAL

  # Build bullet lines only for answered fields (skipped = omitted)
  NEW_PROFILE=""
  [ -n "${P_EXP:-}" ]  && NEW_PROFILE+="- Experience: ${P_EXP} years"$'\n'
  [ -n "${P_AUTH:-}" ] && NEW_PROFILE+="- Work authorization: ${P_AUTH}"$'\n'
  [ -n "${P_CLR:-}" ]  && NEW_PROFILE+="- Clearance: ${P_CLR}"$'\n'
  [ -n "${P_LOC:-}" ]  && NEW_PROFILE+="- Location: ${P_LOC}"$'\n'
  [ -n "${P_EMP:-}" ]  && NEW_PROFILE+="- Employment type: ${P_EMP}"$'\n'
  [ -n "${P_SAL:-}" ]  && NEW_PROFILE+="- Salary floor: ${P_SAL}/year"$'\n'

  # Splice the new block into the prompt's "## CANDIDATE PROFILE" section.
  # Python (stdlib only) does the line surgery — far safer than sed here.
  if PROMPT_FILE="$PROMPT_FILE" NEW_PROFILE="$NEW_PROFILE" python3 - <<'PYEOF'
import os, sys
path = os.environ["PROMPT_FILE"]
bullets = [ln for ln in os.environ["NEW_PROFILE"].split("\n") if ln.strip()]
with open(path, encoding="utf-8") as f:
    lines = f.read().split("\n")
out, i, n, replaced = [], 0, len(lines), False
while i < n:
    if lines[i].strip() == "## CANDIDATE PROFILE":
        out.append("## CANDIDATE PROFILE")
        out.extend(bullets)
        replaced = True
        i += 1
        while i < n and not lines[i].startswith("## "):  # drop old block
            i += 1
        if out and out[-1].strip() != "":
            out.append("")                                # blank line before next section
        continue
    out.append(lines[i]); i += 1
if replaced:
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
sys.exit(0 if replaced else 1)
PYEOF
  then
    if [ -n "$NEW_PROFILE" ]; then
      ok "CANDIDATE PROFILE written into JobMatchAnalyst.md"
    else
      warn "All fields skipped — profile left empty (AI will score on skills only)"
    fi
  else
    warn "Couldn't update the prompt automatically — edit its CANDIDATE PROFILE block by hand"
  fi
fi

# cv.md is too large to prompt for — just flag if it's still a template
printf "\n"
if grep -q "YOUR FULL NAME" "$ROOT/config/cv.md" 2>/dev/null; then
  warn "config/cv.md still has the template placeholder — paste your résumé into it"
else
  ok "config/cv.md looks filled in"
fi
ok "config/filter.yml & config/portals.yml ship with working examples — tune them to taste"

# ── Summary ──────────────────────────────────────────────────────────────────
printf "\n${BOLD}----------------------------------------------${RST}\n"
if [ "$FAIL" -eq 0 ]; then
  printf "${GRN}${BOLD}Setup complete.${RST}\n\n"
else
  printf "${YEL}${BOLD}Setup finished, but note the warnings/errors above.${RST}\n\n"
fi
printf "${BOLD}Next steps:${RST}\n"
printf "  1. Fill in ${CYN}config/cv.md${RST} and the CANDIDATE PROFILE in ${CYN}apps/server/prompts/JobMatchAnalyst.md${RST}\n"
printf "  2. Launch everything:    ${BOLD}./start.sh${RST}\n"
printf "  3. Load the extension:   chrome://extensions -> Developer mode -> Load unpacked -> ${CYN}apps/extension${RST}\n"
printf "     ${DIM}(reload it after each ./start.sh — the port config is regenerated)${RST}\n"
printf "  4. Open the dashboard:   ${CYN}http://localhost:5173${RST}, then use the Settings page to enable scrapers.\n\n"

exit 0
