import time
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
from llm_engine import LLMEngine
from pipeline.pipeline import JobPipeline
from mappers import linkedinDataMapper
from scrapers.ashby import run_ashby_scan
from pipeline.preprocessors.jd_stripper import strip_jd

# Initialize the global engines
llm = LLMEngine()
pipeline = JobPipeline()

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
    apply_decision: Optional[str] = None
    scores: Optional[Dict[str, Any]] = None
    working_in_my_favor: Optional[List[str]] = None
    critical_gaps: Optional[List[str]] = None
    missing_keywords: Optional[List[str]] = None

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
    print("Initializing Database...")
    retries = 5
    while retries > 0:
        try:
            models.Base.metadata.create_all(bind=database.engine)
            # Safe migration: add activity_log column to existing DBs that predate this feature
            with database.engine.connect() as conn:
                conn.execute(_sql_text(
                    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS "
                    "activity_log JSONB DEFAULT '[]'::jsonb"
                ))
                conn.commit()
            print("[✔] Database connected and initialized gracefully.")
            break
        except Exception as e:
            print(f"Database not ready yet, waiting 3 seconds... ({retries} retries left)")
            time.sleep(3)
            retries -= 1

    print(f"\nChecking LLM Engine Health ({llm.provider}: {llm.model})...")
    is_alive = await llm.check_health()
    if is_alive:
        print(f"[✔] LLM Engine online - {llm.provider} is responsive.")
        await llm.preload_model()
    else:
        print(f"[X] CRITICAL: LLM Engine provider '{llm.provider}' at {llm.url} is DOWN or unreachable.")
        print("Halting FastAPI application startup as per strict config constraints.")
        exit_os._exit(1)

@app.on_event("shutdown")
async def shutdown_event():
    if not _background_tasks:
        return
    print(f"[Server] Shutdown signal — cancelling {len(_background_tasks)} background task(s)...", flush=True)
    await llm.release_model()
    for task in list(_background_tasks):
        task.cancel()
    await asyncio.gather(*list(_background_tasks), return_exceptions=True)
    print("[Server] All background tasks cancelled.", flush=True)

# Allow connections from the Vite React app
origins = [
    "http://localhost:5173", # Vite default port
    "http://127.0.0.1:5173",
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
    for row in db_jobs:
        if not row.raw_data:
            continue
        # The passthrough mapper works for all sources
        jobs.append(linkedinDataMapper(row.raw_data))
    
    if not jobs:
        return {"message": "No valid targets found to rescan", "total_processed": 0, "status": "ignored"}
        
    return await execute_job_pipeline(jobs, db, force_rescan=True)


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
        print(f"[Portals] Could not load portals.yml: {e}")
        return []

    entries = config.get('tracked_companies', [])
    if source:
        entries = [e for e in entries if e.get('source') == source]
    if enabled_only:
        entries = [e for e in entries if e.get('enabled', True)]
    return entries


# ─── Portal management ────────────────────────────────────────────────────────

@app.get("/api/portals")
def list_portals():
    """Returns all configured job board portals from portals.yml."""
    entries = _load_portals(enabled_only=False)  # Show all, not just enabled
    return [
        {
            "source":   e.get("source"),
            "org_slug": e.get("org_slug"),
            "name":     e.get("name"),
            "enabled":  e.get("enabled", True),
        }
        for e in entries
        if e.get("source") and e.get("org_slug")  # Skip incomplete entries
    ]

# ─── Server-side scrapers ─────────────────────────────────────────────────────

class AshbyScrapeRequest(BaseModel):
    org_slug: Optional[str] = None  # specific org, or omit for all enabled portals

@app.post("/api/scrape/ashby")
async def scrape_ashby(request: AshbyScrapeRequest):
    """Triggers server-side Ashby scrape. Reads portals.yml, skips existing DB jobs."""
    if request.org_slug:
        all_ashby = _load_portals(source="ashby", enabled_only=False)
        match = next((e for e in all_ashby if e["org_slug"] == request.org_slug), None)
        portals = [{"org_slug": request.org_slug, "name": match["name"] if match else request.org_slug}]
    else:
        enabled = _load_portals(source="ashby", enabled_only=True)
        if not enabled:
            return {"message": "No enabled Ashby portals in portals.yml.", "total_processed": 0}
        portals = [{"org_slug": e["org_slug"], "name": e["name"]} for e in enabled]

    # One DB query to get all known Ashby IDs — skips description fetches for existing jobs
    _db = next(database.get_db())
    try:
        existing_ids: set[str] = {
            row.source_id
            for row in _db.query(models.JobPosition.source_id)
                          .filter(models.JobPosition.source == "ashby")
                          .all()
            if row.source_id
        }
        print(f"[/api/scrape/ashby] {len(existing_ids)} existing Ashby jobs in DB")
    finally:
        _db.close()

    # Pipeline callback — each org gets its own DB session to avoid conflicts
    async def _pipeline(jobs: list[dict], org_slug: str) -> dict:
        db = next(database.get_db())
        try:
            result = await execute_job_pipeline(jobs, db, force_rescan=False)
            result["org"] = org_slug
            return result
        finally:
            db.close()

    return await run_ashby_scan(portals, existing_ids, _pipeline, task_tracker=_track_task)

# ─── Activity Log Helper ──────────────────────────────────────────────────────

def _activity_event(event: str, summary: str, detail: dict = None) -> dict:
    """Creates one structured entry for a job's activity_log."""
    return {
        "timestamp": datetime.now(_tz.utc).isoformat(),
        "event":     event,
        "summary":   summary,
        "detail":    detail or {},
    }


async def execute_job_pipeline(jobs: List[dict], db: Session, force_rescan: bool = False) -> dict:
    start_time = time.time()
    await manager.broadcast({"type": "info", "message": f"INITIATING DEEP SCAN... Received {len(jobs)} jobs."})
    await manager.broadcast({"type": "info", "message": "Applying pipeline deduplication and preliminary keyword filters..."})
    
    # 1. Execute advanced pipeline logic
    pipeline_result = pipeline.filter_and_deduplicate(jobs, db, force_rescan=force_rescan)
    
    jobs_to_evaluate = pipeline_result["jobs_to_generate"]
    upserts = pipeline_result["upserts"]
    inserts = pipeline_result["inserts"]
    skipped = pipeline_result["skipped"]
    print(f"Jobs to evaluate count: {len(jobs_to_evaluate)}")
    print(f"Upserts count: {len(upserts)}")
    print(f"Inserts count: {len(inserts)}")
    print(f"Skipped: {skipped}")
    
    # Report deductions visually via websocket
    await manager.broadcast({"type": "info", "message": f"DEDUPLICATION: Skipped {skipped} historically active jobs."})
    await manager.broadcast({"type": "info", "message": f"PRELIMINARY: {pipeline_result['ignored_count']} new/upserted jobs immediately ignored via keywords."})
    
    if len(jobs_to_evaluate) > 0:
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
        print(f"Warning: Could not load CV or Prompt: {e}")
            
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
            print(f"Evaluating: {title}")
            await manager.broadcast({"type": "job_update", "message": f"EVALUATING: {title} | {company}"})
            
            ai_start = time.time()
            ai_result = await llm.evaluate_job_match(system_prompt=system_prompt, user_prompt=user_prompt, client=client)
            ai_elapsed = round(time.time() - ai_start, 2)
            
            if ai_result:
                raw_score = ai_result.get("weighted_score")
                score = float(raw_score) if raw_score is not None else 0.0
                
                job["ai_score"] = score
                job["ai_analysis"] = ai_result
                
                print(f"  -> AI Result retrieved for {title}. Score: {score}")
                if score < 50:
                    await manager.broadcast({"type": "job_update", "message": f"  -> REJECTED: {title} | Score: {score} | {ai_elapsed}s"})
                    return (job, "IGNORED", f"AI Score {score} < 50")
                await manager.broadcast({"type": "job_update", "message": f"  -> PASSED: {title} | Score: {score} | {ai_elapsed}s"})
                return (job, "ACTIVE", None)
            else:
                print(f"Failed to get JSON from AI for {title} after retries.")
                await manager.broadcast({"type": "job_update", "message": f"  -> FAILED: {title} | Format error limit reached."})
                job["ai_score"] = None
                job["ai_analysis"] = {"error": "AI returned invalid format after 3 retries."}
                return (job, "ACTIVE", None)
        except Exception as e:
            print(f"Error communicating with AI for {title}: {e}")
            await manager.broadcast({"type": "job_update", "message": f"  -> CRASH: {title} | Connectivity error."})
            job["ai_score"] = None
            job["ai_analysis"] = {"error": str(e)}
            return (job, "ACTIVE", None)

    processed_jobs = []
    
    if llm.mode == "cloud":
        print(f"Running {len(jobs_to_evaluate)} evaluations concurrently (Cloud Mode) [concurrency={llm.concurrency}]")
        
        # Concurrency limit read from llm_config.yml — avoids 429s on rate-limited providers (e.g. Groq free tier)
        semaphore = asyncio.Semaphore(llm.concurrency)
        
        async with httpx.AsyncClient(timeout=120.0) as http_client:
            async def evaluate_with_limit(job):
                async with semaphore:
                    return await evaluate_single_job(job, client=http_client)
                    
            tasks = [evaluate_with_limit(job) for job in jobs_to_evaluate]
            results = await asyncio.gather(*tasks)
            processed_jobs.extend(results)
    else:
        print(f"Running {len(jobs_to_evaluate)} evaluations sequentially (Local Mode)")
        async with httpx.AsyncClient(timeout=120.0) as http_client:
            for job in jobs_to_evaluate:
                result = await evaluate_single_job(job, client=http_client)
                processed_jobs.append(result)
    
    # Note: `jobs_to_evaluate` contains dictionaries that mutated during `evaluate_single_job`.
    # Let's map LLM mutation results back to the original inserts/upserts arrays based on source_id!
    
    evaluated_map = {job.get("source_id"): (job, stat, rsn) for job, stat, rsn in processed_jobs}
    
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
    total_ignored = pipeline_result["ignored_count"]
    total_active = len(jobs_to_evaluate)
    total_saved = len(final_inserts) + len(final_upserts)
    
    # 1) Create the ScanSession first to get a valid UUID
    import uuid
    scan_session = models.ScanSession(
        total_jobs_scanned=len(jobs),
        total_jobs_saved=total_saved,
        total_ignored=total_ignored,
        source_meta=[{
            "source": "linkedin",
            "total_jobs_scanned": len(jobs),
            "skipped_duplicates": skipped,
            "total_active": total_active,
            "total_ignored": total_ignored
        }]
    )
    db.add(scan_session)
    db.commit() # commit immediately to generate the ID
    
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
            decision = analysis.get("apply_decision", "N/A")
            log.append(_activity_event(
                "AI_EVALUATED",
                f"Score: {score} — {decision}",
                {"score": score, "apply_decision": decision},
            ))

        db_job = models.JobPosition(
            scan_id=scan_session.id,
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
    for job, status, ignore_reason in final_upserts:
        # Fetch existing log so we can append to it (not overwrite)
        existing = db.query(models.JobPosition.activity_log).filter(
            models.JobPosition.source_id == job.get("source_id"),
            models.JobPosition.source == job.get("source"),
        ).scalar()
        log = list(existing or [])
        log.append(_activity_event(
            "STATUS_CHANGED",
            f"Status updated to {status}" + (f" — {ignore_reason}" if ignore_reason else ""),
            {"new_status": status, "reason": ignore_reason},
        ))
        if job.get("ai_score") is not None:
            score = job["ai_score"]
            analysis = job.get("ai_analysis") or {}
            decision = analysis.get("apply_decision", "N/A")
            log.append(_activity_event(
                "AI_EVALUATED",
                f"Score: {score} — {decision}",
                {"score": score, "apply_decision": decision},
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
            models.JobPosition.scan_id: scan_session.id,
            models.JobPosition.activity_log: log,
        })
        
    db.commit()

    # Print exactly what the user wants to console
    print("\n[✔] request received")
    print("-" * 30)
    print(f"Total jobs received and mapped: {len(jobs)}")
    print(f"Total successfully inserted/upserted into Postgres: {total_saved}")
    print("-" * 30 + "\n")
    
    total_elapsed = round(time.time() - start_time, 2)
    await manager.broadcast({
        "type": "complete", 
        "message": f"DEEP SCAN COMPLETE. Processed {total_saved} database inputs in {total_elapsed}s."
    })
    
    return {"message": "request received", "total_processed": len(jobs), "status": "success"}

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
