from typing import Tuple, List, Optional
import re

def job_description_filter(
    description: str,
    includes: List[str],
    excludes: List[str],
    pattern_excludes: Optional[List[str]] = None,
) -> Tuple[str, str]:
    status = "ACTIVE"
    ignore_reason = None

    if includes:
        matches_positive = [inc for inc in includes if inc in description]
        if not matches_positive:
            status = "IGNORED"
            ignore_reason = "Missing positive job description keyword match."
            return status, ignore_reason

    if excludes and status == "ACTIVE":
        matches_negative = [exc for exc in excludes if exc in description]
        if matches_negative:
            status = "IGNORED"
            ignore_reason = f"Matched negative job description keyword(s): {', '.join(matches_negative)}"
            return status, ignore_reason

    # Regex pattern exclusions — run against the raw (lowercased) description.
    # Primarily used to catch hourly/contractor pay disclosures, C2C markers, etc.
    if pattern_excludes and status == "ACTIVE":
        for pattern in pattern_excludes:
            match = re.search(pattern, description, re.IGNORECASE)
            if match:
                status = "IGNORED"
                ignore_reason = f"Matched description exclusion pattern '{pattern}': '{match.group(0)}'"
                return status, ignore_reason

    return status, ignore_reason
