"""
JOBVIS Logger
=============
Single import for all server modules. Configures:
  - Coloured stderr output (replaces bare print statements)
  - Rotating JSON log files under logs/ (filterable with jq / lnav)

Usage anywhere in the server:
    from logger import logger
    logger.info("message")
    logger.warning("something odd")
    logger.error("it broke")
    logger.debug("verbose detail")

Binding extra fields for structured filtering:
    log = logger.bind(org="ashby", org_slug="ramp")
    log.info("42 postings found")
    # → JSON will have "org" and "org_slug" fields
"""

import sys
import os
from loguru import logger

# ── Ensure logs/ directory exists ────────────────────────────────────────────
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

# ── Remove loguru's default stderr sink (we add our own below) ───────────────
logger.remove()

APP_ENV = os.getenv("APP_ENV", "dev").upper()

# ── Sink 1: Coloured console — mirrors what print() gave you before ──────────
logger.add(
    sys.stderr,
    colorize=True,
    level="DEBUG",
    format=(
        "<green>{time:HH:mm:ss}</green> "
        f"<cyan>[{APP_ENV}]</cyan> "
        "<level>{level: <7}</level> "
        "{message}"
    ),
)

# ── Sink 2: Newline-delimited JSON log files ──────────────────────────────────
# One file per day, kept for 14 days, gzipped on rotation.
# Each line is valid JSON → filterable with jq, lnav, or plain grep.
logger.add(
    os.path.join(LOG_DIR, "jobvis_{time:YYYY-MM-DD}.log"),
    rotation="00:00",       # new file at midnight
    retention="14 days",
    compression="gz",
    serialize=True,         # writes JSON lines
    level="DEBUG",
    enqueue=True,           # non-blocking — safe inside async event loop
)
