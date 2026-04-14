from typing import Tuple, List

def job_description_filter(description: str, includes: List[str], excludes: List[str]) -> Tuple[str, str]:
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
