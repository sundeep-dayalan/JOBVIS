def linkedinDataMapper(raw_job: dict) -> dict:
    """
    Maps a LinkedIn scrape payload to the internal job schema.

    As of v2, the Chrome extension already outputs the standardized keys
    (source, source_id, company_name, source_url, apply_url, job_posted_at,
    salary_info, etc.) so this mapper is now a thin passthrough that only
    ensures `raw_data` is attached for archival.
    """
    # Attach the original payload as raw_data for debugging / re-scanning
    raw_job["raw_data"] = {k: v for k, v in raw_job.items() if k != "raw_data"}
    return raw_job
