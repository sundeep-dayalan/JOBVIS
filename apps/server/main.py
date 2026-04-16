import time
import uuid
import os as exit_os
import json
import asyncio
import httpx
from datetime import datetime, timezone as _tz
from sqlalchemy import text as _sql_text

from typing import List, Optional, Any, Dict
from pydantic import BaseModel
from enum import Enum

from fastapi import FastAPI, Request, Depends, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import uvicorn
import yaml
import os

import models
import database
from logger import logger
from llm_engine import LLMEngine
from pipeline.pipeline import JobPipeline
from mappers import linkedinDataMapper
from scrapers.ashby import run_ashby_scan, refetch_descriptions
from scrapers.greenhouse import run_greenhouse_scan
from scrapers.lever import run_lever_scan
from pipeline.preprocessors.jd_stripper import strip_jd
from scheduler import Scheduler

# Initialize the global engines
llm = LLMEngine()
pipeline = JobPipeline()
job_scheduler = Scheduler()

# Global registry of background tasks — cancelled cleanly on server shutdown
_background_tasks: set[asyncio.Task] = set()

def _track_task(task: asyncio.Task) -> asyncio.Task:
    """Register a task so it can be cancelled on shutdown."""
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task

app = FastAPI()

# --- STRICT API CONTRACTS ---
class JobStatus(str, Enum):
    ACTIVE = "ACTIVE"
    IGNORED = "IGNORED"

class AIAnalysisModel(BaseModel):
    score: Optional[float] = None
    reason: Optional[str] = None

class JobResponse(BaseModel):
    id: str
    title: str
    company_name: Optional[str] = None
    location: Optional[str] = None
    source_url: Optional[str] = None
    apply_url: Optional[str] = None
    job_posted_at: Optional[str] = None
    job_updated_at: Optional[str] = None
    source: Optional[str] = None
    status: JobStatus
    ignore_reason: Optional[str] = None
    description: Optional[str] = None
    ai_score: Optional[float] = None
    ai_analysis: Optional[AIAnalysisModel] = None
    activity_log: Optional[List[Any]] = None

# --- WEBSOCKET MANAGER ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        # We make a copy of the list to avoid issues if connections drop during iteration
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                pass

manager = ConnectionManager()

@app.websocket("/ws/deepscan")
async def websocket_deepscan(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # We don't really expect client messages, just waiting for disconnect
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


@app.on_event("startup")
async def startup_event():
    logger.info("[Server] Initializing Database...")
    retries = 5
    while retries > 0:
        try:
            database.ensure_database_exists()
            models.Base.metadata.create_all(bind=database.engine)
            # Safe migration: add activity_log column to existing DBs that predate this feature
            with database.engine.connect() as conn:
                conn.execute(_sql_text(
                    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS "
                    "activity_log JSONB DEFAULT '[]'::jsonb"
                ))
                conn.commit()
            logger.info("[Server] Database connected and initialized gracefully.")
            break
        except Exception as e:
            logger.warning("[Server] Database not ready yet, waiting 3 seconds... ({} retries left)", retries)
            await asyncio.sleep(3)
            retries -= 1

    logger.info("[Server] Checking LLM Engine Health ({}: {})...", llm.provider, llm.model)
    is_alive = await llm.check_health()
    if is_alive:
        logger.info("[Server] LLM Engine online - {} is responsive.", llm.provider)
        await llm.preload_model()
    else:
        logger.critical("[Server] CRITICAL: LLM Engine provider '{}' at {} is DOWN or unreachable.", llm.provider, llm.url)
        logger.critical("[Server] Halting FastAPI application startup as per strict config constraints.")
        exit_os._exit(1)

    # ── Register scheduled jobs ────────────────────────────────────────────────
    # interval_fn is a lambda so it re-reads settings.yml on every cycle.
    # Changing the interval or toggling enable/disable in the UI takes effect
    # on the next sleep without any server restart.
    def _ashby_interval_fn() -> float:
        s = _load_settings()
        cfg = s.get("scheduler", {}).get("ashby", {})
        if not cfg.get("enabled", False):
            return 0   # Scheduler._run_loop polls every 30s when interval <= 0
        return cfg.get("interval_minutes", 60) * 60

    job_scheduler.register(
        name="ashby",
        interval_fn=_ashby_interval_fn,
        job_fn=_execute_ashby_scan,
        task_tracker=_track_task,
    )

    def _greenhouse_interval_fn() -> float:
        s = _load_settings()
        cfg = s.get("scheduler", {}).get("greenhouse", {})
        if not cfg.get("enabled", False):
            return 0
        return cfg.get("interval_minutes", 60) * 60

    job_scheduler.register(
        name="greenhouse",
        interval_fn=_greenhouse_interval_fn,
        job_fn=_execute_greenhouse_scan,
        task_tracker=_track_task,
    )

    def _lever_interval_fn() -> float:
        s = _load_settings()
        cfg = s.get("scheduler", {}).get("lever", {})
        if not cfg.get("enabled", False):
            return 0
        return cfg.get("interval_minutes", 60) * 60

    job_scheduler.register(
        name="lever",
        interval_fn=_lever_interval_fn,
        job_fn=_execute_lever_scan,
        task_tracker=_track_task,
    )

@app.on_event("shutdown")
async def shutdown_event():
    if not _background_tasks:
        return
    logger.info("[Server] Shutdown signal — cancelling {} background task(s)...", len(_background_tasks))
    await llm.release_model()
    for task in list(_background_tasks):
        task.cancel()
    await asyncio.gather(*list(_background_tasks), return_exceptions=True)
    logger.info("[Server] All background tasks cancelled.")

# Allow connections from the Vite React app
origins = [
    "http://localhost:5173", # Vite default port
    "http://127.0.0.1:5173",
    "http://localhost:1997", # Prod alternate port
    "http://127.0.0.1:1997",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/api/deepscan")
async def receive_deepscan(request: Request, db: Session = Depends(database.get_db)):
    # Retrieve the JSON payload
    data = await request.json()
    
    # Extract and parse utilizing dedicated standard mapper
    raw_jobs = data.get("linkedinScrapeData", []) if isinstance(data, dict) else []
    jobs = [linkedinDataMapper(rj) for rj in raw_jobs]
    
    return await execute_job_pipeline(jobs, db, force_rescan=False)

class RescanRequest(BaseModel):
    job_ids: List[str]

@app.post("/api/rescan")
async def receive_rescan(request: RescanRequest, db: Session = Depends(database.get_db)):
    if "all" in request.job_ids:
        db_jobs = db.query(models.JobPosition).all()
    else:
        db_jobs = db.query(models.JobPosition).filter(models.JobPosition.id.in_(request.job_ids)).all()

    jobs = []
    logger.info("[jobs] Found {} jobs to rescan", len(db_jobs))
    for row in db_jobs:
        if not row.raw_data:
            continue
        jobs.append(linkedinDataMapper(row.raw_data))

    if not jobs:
        return {"message": "No valid targets found to rescan", "total_processed": 0, "status": "ignored"}

    # Re-fetch Ashby descriptions when enabled — jobs ingested with fetch disabled have
    # description=null in raw_data; re-snapshot raw_data after so the upsert persists it.
    settings = _load_settings()
    if settings.get("pipeline", {}).get("ashby_description_fetch_enabled", True):
        await refetch_descriptions(jobs)

    return await execute_job_pipeline(jobs, db, force_rescan=True)


# ─── Settings helpers ────────────────────────────────────────────────────────

SETTINGS_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '../../config/settings.yml')
)

_SETTINGS_DEFAULTS = {
    "pipeline": {
        "ai_scoring_enabled": True,
        "ashby_description_fetch_enabled": True,
        "greenhouse_description_fetch_enabled": True,
    },
    "scheduler": {
        "ashby": {
            "enabled": False,          # opt-in — must be explicitly enabled
            "interval_minutes": 60,    # base interval; ±1 min jitter applied automatically
        },
        "greenhouse": {
            "enabled": False,
            "interval_minutes": 60,
        },
        "lever": {
            "enabled": False,
            "interval_minutes": 60,
        },
    },
}

def _load_settings() -> dict:
    """Reads config/settings.yml; falls back to defaults on any error."""
    try:
        with open(SETTINGS_PATH, 'r') as f:
            data = yaml.safe_load(f) or {}
        # Deep-merge with defaults so missing keys never crash
        for section, defaults in _SETTINGS_DEFAULTS.items():
            if section not in data:
                data[section] = dict(defaults)
            else:
                for key, val in defaults.items():
                    data[section].setdefault(key, val)
        return data
    except Exception as e:
        logger.warning("[Settings] Could not load settings.yml: {} — using defaults", e)
        return dict(_SETTINGS_DEFAULTS)


def _save_settings(settings: dict) -> None:
    """Writes settings dict back to settings.yml atomically."""
    import tempfile, shutil
    tmp_path = SETTINGS_PATH + ".tmp"
    try:
        with open(tmp_path, 'w') as f:
            yaml.dump(settings, f, default_flow_style=False, allow_unicode=True)
        shutil.move(tmp_path, SETTINGS_PATH)
    except Exception as e:
        logger.error("[Settings] Failed to write settings.yml: {}", e)
        raise


# ─── Portal helpers ───────────────────────────────────────────────────────────

PORTALS_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '../../config/portals.yml')
)

def _load_portals(source: Optional[str] = None, enabled_only: bool = True) -> list[dict]:
    """
    Reads tracked_companies from portals.yml.
    Optionally filters by source (e.g. 'ashby') and/or enabled flag.
    """
    try:
        with open(PORTALS_PATH, 'r') as f:
            config = yaml.safe_load(f) or {}
    except Exception as e:
        logger.warning("[Portals] Could not load portals.yml: {}", e)
        return []

    entries = config.get('tracked_companies', [])
    if source:
        entries = [e for e in entries if e.get('source') == source]
    if enabled_only:
        entries = [e for e in entries if e.get('enabled', True)]
    return entries


# ─── Settings endpoints ──────────────────────────────────────────────────────

@app.get("/api/settings")
def get_settings():
    """Returns the current runtime settings."""
    return _load_settings()


class PipelineSettingsPatch(BaseModel):
    ai_scoring_enabled: Optional[bool] = None
    ashby_description_fetch_enabled: Optional[bool] = None
    greenhouse_description_fetch_enabled: Optional[bool] = None

class AshbySchedulerPatch(BaseModel):
    enabled: Optional[bool] = None
    interval_minutes: Optional[int] = None

class GreenhouseSchedulerPatch(BaseModel):
    enabled: Optional[bool] = None
    interval_minutes: Optional[int] = None

class LeverSchedulerPatch(BaseModel):
    enabled: Optional[bool] = None
    interval_minutes: Optional[int] = None

class SchedulerSettingsPatch(BaseModel):
    ashby: Optional[AshbySchedulerPatch] = None
    greenhouse: Optional[GreenhouseSchedulerPatch] = None
    lever: Optional[LeverSchedulerPatch] = None

class SettingsPatch(BaseModel):
    pipeline: Optional[PipelineSettingsPatch] = None
    scheduler: Optional[SchedulerSettingsPatch] = None

@app.patch("/api/settings")
def patch_settings(patch: SettingsPatch):
    """Partially updates runtime settings and persists to settings.yml."""
    current = _load_settings()
    if patch.pipeline is not None:
        if patch.pipeline.ai_scoring_enabled is not None:
            current["pipeline"]["ai_scoring_enabled"] = patch.pipeline.ai_scoring_enabled
        if patch.pipeline.ashby_description_fetch_enabled is not None:
            current["pipeline"]["ashby_description_fetch_enabled"] = patch.pipeline.ashby_description_fetch_enabled
        if patch.pipeline.greenhouse_description_fetch_enabled is not None:
            current["pipeline"]["greenhouse_description_fetch_enabled"] = patch.pipeline.greenhouse_description_fetch_enabled
    if patch.scheduler is not None:
        sched = current.setdefault("scheduler", {})
        if patch.scheduler.ashby is not None:
            ashby_cfg = sched.setdefault("ashby", dict(_SETTINGS_DEFAULTS["scheduler"]["ashby"]))
            if patch.scheduler.ashby.enabled is not None:
                ashby_cfg["enabled"] = patch.scheduler.ashby.enabled
            if patch.scheduler.ashby.interval_minutes is not None:
                ashby_cfg["interval_minutes"] = patch.scheduler.ashby.interval_minutes
        if patch.scheduler.greenhouse is not None:
            gh_cfg = sched.setdefault("greenhouse", dict(_SETTINGS_DEFAULTS["scheduler"]["greenhouse"]))
            if patch.scheduler.greenhouse.enabled is not None:
                gh_cfg["enabled"] = patch.scheduler.greenhouse.enabled
            if patch.scheduler.greenhouse.interval_minutes is not None:
                gh_cfg["interval_minutes"] = patch.scheduler.greenhouse.interval_minutes
        if patch.scheduler.lever is not None:
            lever_cfg = sched.setdefault("lever", dict(_SETTINGS_DEFAULTS["scheduler"]["lever"]))
            if patch.scheduler.lever.enabled is not None:
                lever_cfg["enabled"] = patch.scheduler.lever.enabled
            if patch.scheduler.lever.interval_minutes is not None:
                lever_cfg["interval_minutes"] = patch.scheduler.lever.interval_minutes
    _save_settings(current)
    logger.info("[Settings] Updated: {}", current)
    return current


@app.get("/api/scheduler/status")
def get_scheduler_status():
    """Returns live scheduler task states + current config."""
    settings = _load_settings()
    return {
        "tasks": job_scheduler.status(),
        "config": settings.get("scheduler", {}),
    }


_VALID_SCHEDULER_JOBS = {"ashby", "greenhouse", "lever"}

@app.post("/api/scheduler/trigger/{job_name}")
async def trigger_scheduler_job(job_name: str):
    """
    Immediately triggers a scheduled job.
    If the scheduler is sleeping, it wakes it and resets the timer.
    If the scheduler is disabled, fires the job once directly as a background task.
    """
    if job_name not in _VALID_SCHEDULER_JOBS:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Unknown scheduler job: '{job_name}'")

    woken = job_scheduler.trigger_now(job_name)

    if not woken:
        # Scheduler not sleeping (disabled or not yet registered) — fire directly
        logger.info("[Scheduler] /trigger/{} — not active, firing directly", job_name)
        if job_name == "greenhouse":
            task = asyncio.create_task(_execute_greenhouse_scan())
        elif job_name == "lever":
            task = asyncio.create_task(_execute_lever_scan())
        else:
            task = asyncio.create_task(_execute_ashby_scan())
        _track_task(task)
        return {"message": f"'{job_name}' fired directly (scheduler inactive). Timer not reset.", "timer_reset": False}

    return {"message": f"'{job_name}' triggered now. Timer will reset after this run.", "timer_reset": True}


# ─── Portal management ────────────────────────────────────────────────────────

@app.get("/api/portals")
def list_portals():
    """Returns all configured job board portals from portals.yml."""
    entries = _load_portals(enabled_only=False)  # Show all, not just enabled
    return [
        {
            "source":      e.get("source"),
            "slug":        e.get("slug"),
            "name":        e.get("name"),
            "enabled":     e.get("enabled", True),
        }
        for e in entries
        if e.get("source") and e.get("slug")
    ]


class PortalImportEntry(BaseModel):
    slug: str
    name: str
    source: str = "ashby"
    enabled: bool = True

@app.post("/api/portals/import")
def import_portals(entries: List[PortalImportEntry]):
    """
    Bulk-import portals into portals.yml.
    Skips slugs/tokens already present. Appends new entries as YAML text to
    preserve existing file structure and comments.
    Uses the unified slug key for all sources.
    """
    existing = _load_portals(enabled_only=False)
    existing_keys = {e.get("slug") for e in existing} - {None}

    def _entry_key(e: PortalImportEntry) -> str:
        return e.slug or ""

    new_entries = [e for e in entries if _entry_key(e) not in existing_keys]

    if new_entries:
        with open(PORTALS_PATH, "a") as f:
            for e in new_entries:
                f.write(f"  - name: {e.name}\n")
                f.write(f"    source: {e.source}\n")
                f.write(f"    slug: {e.slug}\n")
                f.write(f"    enabled: {'true' if e.enabled else 'false'}\n")

    return {
        "imported":   len(new_entries),
        "skipped":    len(entries) - len(new_entries),
        "new_tokens": [_entry_key(e) for e in new_entries],
    }


# ─── Server-side scrapers ─────────────────────────────────────────────────────

async def _execute_ashby_scan(org_slug: Optional[str] = None) -> dict:
    """
    Core Ashby scan logic — shared by the HTTP endpoint and the scheduler.
    Reads current settings fresh on every call so UI toggles take effect immediately.
    """
    if org_slug:
        all_ashby = _load_portals(source="ashby", enabled_only=False)
        match = next((e for e in all_ashby if e["slug"] == org_slug), None)
        portals = [{"slug": org_slug, "name": match["name"] if match else org_slug}]
    else:
        enabled = _load_portals(source="ashby", enabled_only=True)
        if not enabled:
            return {"message": "No enabled Ashby portals in portals.yml.", "total_processed": 0}
        portals = [{"slug": e["slug"], "name": e["name"]} for e in enabled]

    _db = next(database.get_db())
    try:
        existing_ids: set[str] = {
            row.source_id
            for row in _db.query(models.JobPosition.source_id)
                          .filter(models.JobPosition.source == "ashby")
                          .all()
            if row.source_id
        }
        logger.info("[Ashby] {} existing jobs in DB", len(existing_ids))

        # Create ONE ScanSession for the entire run up-front so all orgs share it.
        scan_session = models.ScanSession(
            total_jobs_scanned=0,
            total_jobs_saved=0,
            total_ignored=0,
            source_meta=[{"source": "ashby", "orgs": [p["slug"] for p in portals]}],
        )
        _db.add(scan_session)
        _db.commit()
        shared_session_id = scan_session.id
        logger.info("[Ashby] Created shared ScanSession {}", shared_session_id)
    finally:
        _db.close()

    async def _pipeline(jobs: list[dict], slug: str) -> dict:
        db = next(database.get_db())
        try:
            result = await execute_job_pipeline(
                jobs, db,
                force_rescan=False,
                scan_source="ashby",
                session_id=shared_session_id,
            )
            result["org"] = slug
            return result
        finally:
            db.close()

    settings = _load_settings()
    scan_result = await run_ashby_scan(
        portals,
        existing_ids,
        _pipeline,
        task_tracker=_track_task,
        fetch_descriptions=settings.get("pipeline", {}).get("ashby_description_fetch_enabled", True),
    )

    # Update the shared session with aggregate totals from all orgs.
    _db = next(database.get_db())
    try:
        sess = _db.query(models.ScanSession).filter(models.ScanSession.id == shared_session_id).first()
        if sess:
            sess.total_jobs_scanned = scan_result.get("total_scanned", 0)
            sess.total_jobs_saved   = scan_result.get("total_saved", 0)
            sess.total_ignored      = scan_result.get("total_ignored", 0)
            _db.commit()
    finally:
        _db.close()

    return scan_result


class AshbyScrapeRequest(BaseModel):
    slug: Optional[str] = None  # specific org slug, or omit for all enabled portals

@app.post("/api/scrape/ashby")
async def scrape_ashby(request: AshbyScrapeRequest):
    """Triggers server-side Ashby scrape. Reads portals.yml, skips existing DB jobs."""
    return await _execute_ashby_scan(org_slug=request.slug)


async def _execute_greenhouse_scan(board_token: Optional[str] = None) -> dict:
    """
    Core Greenhouse scan logic — shared by the HTTP endpoint and the scheduler.
    Reads current settings fresh on every call so UI toggles take effect immediately.
    """
    if board_token:
        all_gh = _load_portals(source="greenhouse", enabled_only=False)
        match = next((e for e in all_gh if e["slug"] == board_token), None)
        portals = [{"slug": board_token, "name": match["name"] if match else board_token}]
    else:
        enabled = _load_portals(source="greenhouse", enabled_only=True)
        if not enabled:
            return {"message": "No enabled Greenhouse portals in portals.yml.", "total_processed": 0}
        portals = [{"slug": e["slug"], "name": e["name"]} for e in enabled]

    _db = next(database.get_db())
    try:
        existing_ids: set[str] = {
            row.source_id
            for row in _db.query(models.JobPosition.source_id)
                          .filter(models.JobPosition.source == "greenhouse")
                          .all()
            if row.source_id
        }
        logger.info("[Greenhouse] {} existing jobs in DB", len(existing_ids))

        scan_session = models.ScanSession(
            total_jobs_scanned=0,
            total_jobs_saved=0,
            total_ignored=0,
            source_meta=[{"source": "greenhouse", "boards": [p["slug"] for p in portals]}],
        )
        _db.add(scan_session)
        _db.commit()
        shared_session_id = scan_session.id
        logger.info("[Greenhouse] Created shared ScanSession {}", shared_session_id)
    finally:
        _db.close()

    async def _pipeline(jobs: list[dict], token: str) -> dict:
        db = next(database.get_db())
        try:
            result = await execute_job_pipeline(
                jobs, db,
                force_rescan=False,
                scan_source="greenhouse",
                session_id=shared_session_id,
            )
            result["board"] = token
            return result
        finally:
            db.close()

    settings = _load_settings()
    scan_result = await run_greenhouse_scan(
        portals,
        existing_ids,
        _pipeline,
        task_tracker=_track_task,
        fetch_descriptions=settings.get("pipeline", {}).get("greenhouse_description_fetch_enabled", True),
    )

    _db = next(database.get_db())
    try:
        sess = _db.query(models.ScanSession).filter(models.ScanSession.id == shared_session_id).first()
        if sess:
            sess.total_jobs_scanned = scan_result.get("total_scanned", 0)
            sess.total_jobs_saved   = scan_result.get("total_saved", 0)
            sess.total_ignored      = scan_result.get("total_ignored", 0)
            _db.commit()
    finally:
        _db.close()

    return scan_result


class GreenhouseScrapeRequest(BaseModel):
    slug: Optional[str] = None  # specific board slug, or omit for all enabled portals

@app.post("/api/scrape/greenhouse")
async def scrape_greenhouse(request: GreenhouseScrapeRequest):
    """Triggers server-side Greenhouse scrape. Reads portals.yml, skips existing DB jobs."""
    return await _execute_greenhouse_scan(board_token=request.slug)


async def _execute_lever_scan(org_slug: Optional[str] = None) -> dict:
    """
    Core Lever scan logic — shared by the HTTP endpoint and the scheduler.
    Reads current settings fresh on every call so UI toggles take effect immediately.

    Because the Lever listing API returns descriptions inline with every posting,
    there is no separate description-fetch phase.
    """
    if org_slug:
        all_lever = _load_portals(source="lever", enabled_only=False)
        match = next((e for e in all_lever if e["slug"] == org_slug), None)
        portals = [{"slug": org_slug, "name": match["name"] if match else org_slug}]
    else:
        enabled = _load_portals(source="lever", enabled_only=True)
        if not enabled:
            return {"message": "No enabled Lever portals in portals.yml.", "total_processed": 0}
        portals = [{"slug": e["slug"], "name": e["name"]} for e in enabled]

    _db = next(database.get_db())
    try:
        existing_ids: set[str] = {
            row.source_id
            for row in _db.query(models.JobPosition.source_id)
                          .filter(models.JobPosition.source == "lever")
                          .all()
            if row.source_id
        }
        logger.info("[Lever] {} existing jobs in DB", len(existing_ids))

        scan_session = models.ScanSession(
            total_jobs_scanned=0,
            total_jobs_saved=0,
            total_ignored=0,
            source_meta=[{"source": "lever", "orgs": [p["slug"] for p in portals]}],
        )
        _db.add(scan_session)
        _db.commit()
        shared_session_id = scan_session.id
        logger.info("[Lever] Created shared ScanSession {}", shared_session_id)
    finally:
        _db.close()

    async def _pipeline(jobs: list[dict], slug: str) -> dict:
        db = next(database.get_db())
        try:
            result = await execute_job_pipeline(
                jobs, db,
                force_rescan=False,
                scan_source="lever",
                session_id=shared_session_id,
            )
            result["org"] = slug
            return result
        finally:
            db.close()

    scan_result = await run_lever_scan(
        portals,
        existing_ids,
        _pipeline,
        task_tracker=_track_task,
    )

    _db = next(database.get_db())
    try:
        sess = _db.query(models.ScanSession).filter(models.ScanSession.id == shared_session_id).first()
        if sess:
            sess.total_jobs_scanned = scan_result.get("total_scanned", 0)
            sess.total_jobs_saved   = scan_result.get("total_saved", 0)
            sess.total_ignored      = scan_result.get("total_ignored", 0)
            _db.commit()
    finally:
        _db.close()

    return scan_result


class LeverScrapeRequest(BaseModel):
    slug: Optional[str] = None  # specific org slug, or omit for all enabled portals

@app.post("/api/scrape/lever")
async def scrape_lever(request: LeverScrapeRequest):
    """Triggers server-side Lever scrape. Reads portals.yml, skips existing DB jobs."""
    return await _execute_lever_scan(org_slug=request.slug)


# ─── Activity Log Helper ──────────────────────────────────────────────────────

def _fmt_duration(seconds: float) -> str:
    """Converts seconds to a human-readable string like 1m2s or 45s."""
    seconds = int(seconds)
    if seconds >= 3600:
        h, rem = divmod(seconds, 3600)
        m, s = divmod(rem, 60)
        return f"{h}h{m}m{s}s"
    if seconds >= 60:
        m, s = divmod(seconds, 60)
        return f"{m}m{s}s"
    return f"{seconds}s"


def _activity_event(event: str, summary: str, detail: dict = None) -> dict:
    """Creates one structured entry for a job's activity_log."""
    return {
        "timestamp": datetime.now(_tz.utc).isoformat(),
        "event":     event,
        "summary":   summary,
        "detail":    detail or {},
    }


async def execute_job_pipeline(jobs: List[dict], db: Session, force_rescan: bool = False, scan_source: str = "linkedin", session_id=None) -> dict:
    start_time = time.time()
    await manager.broadcast({"type": "info", "message": f"INITIATING DEEP SCAN... Received {len(jobs)} jobs."})
    await manager.broadcast({"type": "info", "message": "Applying pipeline deduplication and preliminary keyword filters..."})

    # Read live settings (re-read each pipeline run so UI toggles take effect immediately)
    settings = _load_settings()
    ai_scoring_enabled: bool = settings.get("pipeline", {}).get("ai_scoring_enabled", True)

    # 1. Execute advanced pipeline logic
    pipeline_result = pipeline.filter_and_deduplicate(jobs, db, force_rescan=force_rescan)
    
    jobs_to_evaluate = pipeline_result["jobs_to_generate"]
    upserts = pipeline_result["upserts"]
    inserts = pipeline_result["inserts"]
    skipped = pipeline_result["skipped"]
    logger.debug("[Pipeline] jobs_to_evaluate={}", len(jobs_to_evaluate))
    logger.debug("[Pipeline] upserts={}", len(upserts))
    logger.debug("[Pipeline] inserts={}", len(inserts))
    logger.debug("[Pipeline] skipped={}", skipped)
    logger.debug("[Pipeline] ai_scoring_enabled={}", ai_scoring_enabled)
    
    # Report deductions visually via websocket
    await manager.broadcast({"type": "info", "message": f"DEDUPLICATION: Skipped {skipped} historically active jobs."})
    await manager.broadcast({"type": "info", "message": f"PRELIMINARY: {pipeline_result['ignored_count']} new/upserted jobs immediately ignored via keywords."})
    
    if not ai_scoring_enabled:
        await manager.broadcast({"type": "info", "message": "⚠ AI SCORING is DISABLED — bypassing LLM evaluation. All surviving jobs will be saved as ACTIVE."})
    elif len(jobs_to_evaluate) > 0:
        await manager.broadcast({"type": "info", "message": f"Beginning AI scoring for {len(jobs_to_evaluate)} surviving active jobs..."})
    else:
        await manager.broadcast({"type": "info", "message": "No new jobs survived preliminary filters. Terminating early."})

    cv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../config/cv.md'))
    prompt_path = os.path.abspath(os.path.join(os.path.dirname(__file__), 'prompts/JobMatchAnalyst.md'))
    
    cv_content = ""
    system_prompt_template = ""
    try:
        with open(cv_path, 'r') as f:
            cv_content = f.read()
        with open(prompt_path, 'r') as f:
            system_prompt_template = f.read()
    except Exception as e:
        logger.warning("[Pipeline] Could not load CV or Prompt: {}", e)
            
    # PRE-OPTIMIZATION: Replace CV globally outside the loop so we don't duplicate megabytes of RAM 50 times
    base_system_prompt = system_prompt_template.replace("{{CV_CONTENT}}", cv_content)
            
    # --- AI EVALUATION ---
    async def evaluate_single_job(job, client=None):
        title = job.get('title', 'Unknown')
        company = job.get('company_name', 'Unknown')
        
        # Keeping system prompt completely static for caching
        system_prompt = base_system_prompt
        
        stripped_jd = strip_jd(job.get('description') or '')
        user_prompt = f"TITLE: {title}\nJD: {stripped_jd}\nLOCATION: {job.get('location') or 'Unknown'}"
        
        try:
            logger.info("[AI] Evaluating: {}", title)
            await manager.broadcast({"type": "job_update", "message": f"EVALUATING: {title} | {company}"})

            ai_start = time.time()
            ai_result = await llm.evaluate_job_match(system_prompt=system_prompt, user_prompt=user_prompt, client=client)
            ai_elapsed = round(time.time() - ai_start, 2)
            ai_elapsed_fmt = _fmt_duration(ai_elapsed)

            if ai_result:
                raw_score = ai_result.get("score")
                score = float(raw_score) if raw_score is not None else 0.0

                job["ai_score"] = score
                job["ai_analysis"] = ai_result

                logger.info("[AI] Result for {}: score={} ({})", title, score, ai_elapsed_fmt)
                if score < 2.5:
                    await manager.broadcast({"type": "job_update", "message": f"  -> REJECTED: {title} | Score: {score} | {ai_elapsed_fmt}"})
                    return (job, "IGNORED", f"AI Score {score} < 2.5", ai_elapsed)
                await manager.broadcast({"type": "job_update", "message": f"  -> PASSED: {title} | Score: {score} | {ai_elapsed_fmt}"})
                return (job, "ACTIVE", None, ai_elapsed)
            else:
                logger.warning("[AI] Failed to get JSON for {} after retries ({})", title, ai_elapsed_fmt)
                await manager.broadcast({"type": "job_update", "message": f"  -> FAILED: {title} | Format error limit reached. | {ai_elapsed_fmt}"})
                job["ai_score"] = None
                job["ai_analysis"] = {"error": "AI returned invalid format after 3 retries."}
                return (job, "ACTIVE", None, ai_elapsed)
        except Exception as e:
            ai_elapsed = round(time.time() - ai_start, 2)
            logger.error("[AI] Error communicating with AI for {}: {}", title, e)
            await manager.broadcast({"type": "job_update", "message": f"  -> CRASH: {title} | Connectivity error."})
            job["ai_score"] = None
            job["ai_analysis"] = {"error": str(e)}
            return (job, "ACTIVE", None, ai_elapsed)

    processed_jobs = []

    if not ai_scoring_enabled:
        # ── AI SCORING BYPASSED ───────────────────────────────────────────────
        # Skip LLM entirely. All jobs that made it through keyword filters are
        # treated as ACTIVE with no score. The evaluated_map stays empty so the
        # downstream merge loop just keeps their preliminary status as-is.
        logger.info("[Pipeline] AI scoring bypassed by settings toggle.")
    else:
        # Unified concurrency path for both local and cloud modes.
        # Local Ollama defaults to concurrency=1 (sequential). Set concurrency > 1 in
        # llm_config.yml only if OLLAMA_NUM_PARALLEL is configured on your Ollama server.
        concurrency_label = f"concurrency={llm.concurrency}" if llm.concurrency > 1 else "sequential"
        logger.info("[Pipeline] Running {} evaluations [{} mode | {}]", len(jobs_to_evaluate), llm.mode, concurrency_label)

        semaphore = asyncio.Semaphore(llm.concurrency)

        async with httpx.AsyncClient(timeout=120.0) as http_client:
            async def evaluate_with_limit(job):
                async with semaphore:
                    return await evaluate_single_job(job, client=http_client)

            tasks = [evaluate_with_limit(job) for job in jobs_to_evaluate]
            results = await asyncio.gather(*tasks)
            processed_jobs.extend(results)

    # --- TIMING STATS ---
    if processed_jobs:
        job_times = [(job.get("title", "Unknown"), elapsed) for job, _s, _r, elapsed in processed_jobs]
        slowest  = max(job_times, key=lambda x: x[1])
        fastest  = min(job_times, key=lambda x: x[1])
        avg_time = sum(t for _, t in job_times) / len(job_times)

        stats_lines = [
            f"{'─' * 50}",
            f"  AI EVALUATION STATS  ({len(processed_jobs)} jobs)",
            f"{'─' * 50}",
            f"  Slowest : {_fmt_duration(slowest[1])}  — {slowest[0]}",
            f"  Fastest : {_fmt_duration(fastest[1])}  — {fastest[0]}",
            f"  Average : {_fmt_duration(avg_time)}",
            f"{'─' * 50}",
        ]
        logger.info("[Pipeline] AI stats:\n{}", "\n".join(stats_lines))
        per_job = "\n".join(f"  {i:>2}. {_fmt_duration(elapsed):>6}  {title}" for i, (title, elapsed) in enumerate(sorted(job_times, key=lambda x: x[1], reverse=True), 1))
        logger.debug("[Pipeline] Per-job breakdown:\n{}", per_job)

    # Note: `jobs_to_evaluate` contains dictionaries that mutated during `evaluate_single_job`.
    # Let's map LLM mutation results back to the original inserts/upserts arrays based on source_id!

    evaluated_map = {job.get("source_id"): (job, stat, rsn) for job, stat, rsn, _elapsed in processed_jobs}
    
    def update_job_with_ai(job_tuple):
        j_dict, j_stat, j_rsn = job_tuple
        jid = j_dict.get("source_id")
        if jid in evaluated_map:
            ai_dict, ai_stat, ai_rsn = evaluated_map[jid]
            # Reattach the mutated scores
            j_dict["ai_score"] = ai_dict.get("ai_score")
            j_dict["ai_analysis"] = ai_dict.get("ai_analysis")
            # Overwrite preliminary status with LLM explicit status
            j_stat = ai_stat
            j_rsn = ai_rsn
        return (j_dict, j_stat, j_rsn)

    final_inserts = [update_job_with_ai(jt) for jt in inserts]
    final_upserts = [update_job_with_ai(jt) for jt in upserts]
    
    # Telemetry logging ignores deduplicated skipped jobs!
    # Recalculate accurately based on final LLM/preliminary decisions (resolves rescan sync bugs)
    total_active = sum(1 for _, status, _ in final_inserts + final_upserts if status == "ACTIVE")
    total_ignored = sum(1 for _, status, _ in final_inserts + final_upserts if status == "IGNORED")
    total_saved = len(final_inserts) + len(final_upserts)
    
    # 1) Use the provided shared session, or create a new one (LinkedIn / single-org path)
    if session_id is not None:
        _scan_id = session_id
    else:
        derived_source = jobs[0].get("source", scan_source) if jobs else scan_source
        scan_session = models.ScanSession(
            total_jobs_scanned=len(jobs),
            total_jobs_saved=total_saved,
            total_ignored=total_ignored,
            source_meta=[{
                "source": derived_source,
                "total_jobs_scanned": len(jobs),
                "skipped_duplicates": skipped,
                "total_active": total_active,
                "total_ignored": total_ignored
            }]
        )
        db.add(scan_session)
        db.commit()
        _scan_id = scan_session.id
    
    # 2) Save new jobs (Inserts)
    for job, status, ignore_reason in final_inserts:
        # Build activity log for this new job
        log = [
            _activity_event(
                "INGESTED",
                f"Added from {job.get('source')} / {job.get('company_name', '')}",
                {"source": job.get("source"), "source_id": job.get("source_id")},
            )
        ]
        if status == "IGNORED":
            log.append(_activity_event(
                "FILTER_IGNORED" if not job.get("ai_score") else "AI_REJECTED",
                ignore_reason or "Filtered by pipeline",
                {"filter_type": "preliminary_title" if not job.get("ai_score") else "ai_score"},
            ))
        else:
            log.append(_activity_event("FILTER_PASSED", "Passed preliminary title filters"))

        if job.get("ai_score") is not None:
            score = job["ai_score"]
            analysis = job.get("ai_analysis") or {}
            reason = analysis.get("reason", "N/A")
            log.append(_activity_event(
                "AI_EVALUATED",
                f"Score: {score} — {reason}",
                {"score": score, "reason": reason},
            ))

        db_job = models.JobPosition(
            scan_id=_scan_id,
            source=job.get("source"),
            source_id=job.get("source_id"),
            title=job.get("title"),
            company_name=job.get("company_name"),
            description=job.get("description"),
            source_url=job.get("source_url"),
            apply_url=job.get("apply_url"),
            job_posted_at=job.get("job_posted_at"),
            job_updated_at=job.get("job_updated_at"),
            location=job.get("location"),
            salary_info=job.get("salary_info"),
            status=status,
            ignore_reason=ignore_reason,
            ai_score=job.get("ai_score"),
            ai_analysis=job.get("ai_analysis"),
            raw_data=job.get("raw_data"),
            activity_log=log,
        )
        db.add(db_job)

    # 3) Upsert existing jobs (from IGNORED back to ACTIVE, or forced rescan sync)
    # Batch-fetch all existing activity logs in one query to avoid N+1 per upsert.
    upsert_source_ids = [job.get("source_id") for job, _, _ in final_upserts if job.get("source_id")]
    if upsert_source_ids:
        existing_logs_rows = db.query(
            models.JobPosition.source_id,
            models.JobPosition.activity_log,
        ).filter(
            models.JobPosition.source_id.in_(upsert_source_ids)
        ).all()
        existing_logs_map = {row.source_id: row.activity_log for row in existing_logs_rows}
    else:
        existing_logs_map = {}

    for job, status, ignore_reason in final_upserts:
        # Rescan: preserve the existing log as-is — no new history entries for a re-evaluation
        log = list(existing_logs_map.get(job.get("source_id")) or [])
        if not force_rescan:
            log.append(_activity_event(
                "STATUS_CHANGED",
                f"Status updated to {status}" + (f" — {ignore_reason}" if ignore_reason else ""),
                {"new_status": status, "reason": ignore_reason},
            ))
            if job.get("ai_score") is not None:
                score = job["ai_score"]
                analysis = job.get("ai_analysis") or {}
                reason = analysis.get("reason", "N/A")
                log.append(_activity_event(
                    "AI_EVALUATED",
                    f"Score: {score} — {reason}",
                    {"score": score, "reason": reason},
                ))

        db.query(models.JobPosition).filter(
            models.JobPosition.source_id == job.get("source_id"),
            models.JobPosition.source == job.get("source")
        ).update({
            models.JobPosition.title: job.get("title"),
            models.JobPosition.company_name: job.get("company_name"),
            models.JobPosition.description: job.get("description"),
            models.JobPosition.source_url: job.get("source_url"),
            models.JobPosition.apply_url: job.get("apply_url"),
            models.JobPosition.job_posted_at: job.get("job_posted_at"),
            models.JobPosition.job_updated_at: job.get("job_updated_at"),
            models.JobPosition.location: job.get("location"),
            models.JobPosition.salary_info: job.get("salary_info"),
            models.JobPosition.status: status,
            models.JobPosition.ignore_reason: ignore_reason,
            models.JobPosition.ai_score: job.get("ai_score"),
            models.JobPosition.ai_analysis: job.get("ai_analysis"),
            models.JobPosition.raw_data: job.get("raw_data"),
            models.JobPosition.scan_id: _scan_id,
            models.JobPosition.activity_log: log,
        })
        
    db.commit()

    logger.info("[Pipeline] Request complete")
    logger.info("[Pipeline] Total jobs received: {}", len(jobs))
    logger.info("[Pipeline] Saved to DB: {}", total_saved)
    
    
    total_elapsed = round(time.time() - start_time, 2)
    await manager.broadcast({
        "type": "complete",
        "message": f"DEEP SCAN COMPLETE. Processed {total_saved} database inputs in {_fmt_duration(total_elapsed)}."
    })
    
    return {
        "message": "request received",
        "total_processed": len(jobs),
        "total_scanned": len(jobs),
        "total_saved": total_saved,
        "total_ignored": total_ignored,
        "status": "success",
    }

@app.get("/api/jobs", response_model=List[JobResponse])
def get_jobs(db: Session = Depends(database.get_db)):
    jobs = db.query(models.JobPosition).order_by(models.JobPosition.created_at.desc()).all()
    return [
        {
            "id": str(job.id),
            "title": job.title,
            "company_name": job.company_name,
            "location": job.location,
            "source_url": job.source_url,
            "apply_url": job.apply_url,
            "job_posted_at": job.job_posted_at,
            "job_updated_at": job.job_updated_at,
            "source": job.source,
            "status": job.status,
            "ignore_reason": job.ignore_reason,
            "description": job.description,
            "ai_score": job.ai_score,
            "ai_analysis": job.ai_analysis,
            "activity_log": job.activity_log or [],
        }
        for job in jobs
    ]

@app.get("/api/scans")
def get_scans(db: Session = Depends(database.get_db)):
    scans = db.query(models.ScanSession).order_by(models.ScanSession.created_at.desc()).all()
    return [
        {
            "id": str(s.id),
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "total_jobs_scanned": s.total_jobs_scanned,
            "total_jobs_saved": s.total_jobs_saved,
            "total_ignored": s.total_ignored,
            "source_meta": s.source_meta
        }
        for s in scans
    ]

@app.delete("/api/scans/{scan_id}")
def delete_scan(scan_id: str, db: Session = Depends(database.get_db)):
    scan = db.query(models.ScanSession).filter(models.ScanSession.id == scan_id).first()
    if not scan:
        return {"status": "error", "message": "Scan not found"}
        
    db.delete(scan)
    db.commit()
    # Thanks to ON DELETE CASCADE on the jobs.scan_id foreign key, Postgres drops all identical jobs!
    return {"status": "success", "message": "Scan and all associated jobs deleted."}

if __name__ == "__main__":
    # To run this you can also simply run: python main.py
    uvicorn.run("main:app", host="0.0.0.1", port=8000, reload=True)
