from typing import Tuple, List, Optional


def location_filter(location: Optional[str], allowed_locations: List[str]) -> Tuple[str, str]:
    """
    Gate a job based on its location field.

    Rules:
    - If no allowlist is configured → pass through (no-op).
    - If location is missing/empty → pass through (location may be populated later
      or the scraper didn't expose it; a missing location is NOT sufficient reason
      to reject — rely on the LLM for that edge case).
    - If location is present → at least one allowed term must appear (case-insensitive).
      Otherwise the job is IGNORED.

    Returns (status, ignore_reason).
    """
    if not allowed_locations:
        return "ACTIVE", None

    if not location:
        # Location field absent — let the job through; LLM will catch it if needed.
        return "ACTIVE", None

    location_lower = location.lower()
    for term in allowed_locations:
        if term.lower() in location_lower:
            return "ACTIVE", None

    return "IGNORED", f"Location '{location}' did not match any allowed location term."
