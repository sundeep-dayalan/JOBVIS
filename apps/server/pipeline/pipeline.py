import os
import yaml
from sqlalchemy.orm import Session
from sqlalchemy import select
from typing import List, Dict, Any, Tuple
import models
from .preprocessors.title_filter import title_filter
from .preprocessors.jd_filter import job_description_filter
from logger import logger

class JobPipeline:
    def __init__(self, config_path: str = None):
        if not config_path:
            config_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../config/filter.yml'))
            
        try:
            with open(config_path, 'r') as f:
                self.filter_config = yaml.safe_load(f) or {}
        except Exception as e:
            logger.error("[Pipeline] Error loading {}: {}", config_path, e)
            self.filter_config = {}

        title_filter_config = self.filter_config.get('title_filter', {})
        self.includes = [i.lower() for i in title_filter_config.get('include_any', [])]
        self.excludes = [e.lower() for e in title_filter_config.get('exclude_any', [])]

        desc_filter_config = self.filter_config.get('job_description_filter', {})
        self.desc_includes = [i.lower() for i in desc_filter_config.get('include_any', [])]
        self.desc_excludes = [e.lower() for e in desc_filter_config.get('exclude_any', [])]

    def apply_preliminary_filters(self, job: Dict[str, Any]) -> Tuple[str, str]:
        """Runs preliminary filters. Returns (status, ignore_reason)."""
        logger.debug("[Pipeline] Applying preliminary filters to job: {}", job.get('title'))
        title = job.get('title')
        
        if not title:
            logger.debug("[Pipeline] Job missing title, skipping preliminary filter.")
            return "ACTIVE", None
            
        title = title.lower()
        status, ignore_reason = title_filter(title, self.includes, self.excludes)
        
        if status == "IGNORED":
            logger.debug("[Pipeline] Job '{}' ignored: {}", job.get('title'), ignore_reason)
            return status, ignore_reason
            
        description = job.get('description')
        if not description:
            logger.debug("[Pipeline] Job missing description, skipping description filter.")
        else:
            description = description.lower()
            status, ignore_reason = job_description_filter(description, self.desc_includes, self.desc_excludes)
            if status == "IGNORED":
                logger.debug("[Pipeline] Job '{}' ignored: {}", job.get('title'), ignore_reason)
                
        return status, ignore_reason

    def filter_and_deduplicate(self, jobs: List[Dict[str, Any]], db: Session, force_rescan: bool = False) -> Dict[str, Any]:
        """
        Executes N+1 optimized pipeline logic.
        1. Queries DB for all matching source_ids in O(1), scoped by source.
        2. Drops [ACTIVE]->[ACTIVE] and [IGNORED]->[IGNORED] duplicates entirely.
        3. Identifies [IGNORED]->[ACTIVE] as Upserts.
        4. Identifies entirely new jobs as DB Inserts.
        Supports any source value (linkedin, ashby, etc.)
        """
        logger.info("[Pipeline] Filtering and deduplicating {} jobs.", len(jobs))
        
        # Derive source dynamically from the batch (all jobs in a batch share the same source)
        source = jobs[0].get("source", "unknown") if jobs else "unknown"
        source_ids = [job.get("source_id") for job in jobs if job.get("source_id")]
        logger.debug("[Pipeline] Source: {} | Source IDs count: {}", source, len(source_ids))
        
        # 1. Grab all existing records for this source
        existing_records = db.query(models.JobPosition.source_id, models.JobPosition.status).filter(
            models.JobPosition.source == source,
            models.JobPosition.source_id.in_(source_ids)
        ).all()
        logger.debug("[Pipeline] Existing records in DB: {}", len(existing_records))
        
        # Build O(1) dictionary: { "jobId_123": "IGNORED", "jobId_456": "ACTIVE" }
        existing_map = {rec.source_id: rec.status for rec in existing_records}
        logger.debug("[Pipeline] Existing jobs map: {}", existing_map)
        
        result = {
            "upserts": [],          # Jobs to jump to LLM and overwrite Postgres status
            "inserts": [],          # Brand new jobs going into Postgres
            "jobs_to_generate": [], # Pointer array for everything that goes to the LLM (inserts + upserts that are ACTIVE)
            "skipped": 0,           # Jobs completely vaporized by dedupe
            "ignored_count": 0      # New or Upserted jobs that were immediately killed by preliminary logic
        }

        for job in jobs:
            logger.debug("[Pipeline] Processing job: {}", job.get('title'))
            job_id = job.get("source_id")
            if not job_id:
                # Malformed payload
                logger.debug("[Pipeline] Job '{}' skipped: Malformed payload", job.get('title'))
                continue

              
            current_status, current_reason = self.apply_preliminary_filters(job)
            
            # The job will carry its metadata payload
            job_tuple = (job, current_status, current_reason)
            
            if job_id in existing_map:
                history_status = existing_map[job_id]
                
                # If it's a standard background Deep Scan, securely drop any duplicate to prevent AI infinite loops
                if not force_rescan:
                    logger.debug("[Pipeline] Job '{}' skipped: {} -> {} [Cache Hit]", job.get('title'), history_status, current_status)
                    result["skipped"] += 1
                    continue
                    
                # We only reach here if force_rescan is enabled (Manual UI re-evaluation)
                logger.debug("[Pipeline] Job '{}' upserted: {} -> {} [Force Rescan? {}]", job.get('title'), history_status, current_status, force_rescan)
                result["upserts"].append(job_tuple)
                if current_status == "ACTIVE":
                    result["jobs_to_generate"].append(job)
            else:
                # Brand new job
                logger.debug("[Pipeline] Job '{}' inserted: {}", job.get('title'), current_status)
                result["inserts"].append(job_tuple)
                if current_status == "ACTIVE":
                    result["jobs_to_generate"].append(job)
                else:
                    result["ignored_count"] += 1

        return result
