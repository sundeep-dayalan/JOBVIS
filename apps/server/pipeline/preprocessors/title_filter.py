from typing import Tuple, List

def title_filter(title: str, includes: List[str], excludes: List[str]) -> Tuple[str, str]:
    status = "ACTIVE"
    ignore_reason = None
    
    if includes:
        matches_positive = [inc for inc in includes if inc in title]
        if not matches_positive:
            status = "IGNORED"
            ignore_reason = "Missing positive title keyword match."
            return status, ignore_reason
            
    if excludes and status == "ACTIVE":
        matches_negative = [exc for exc in excludes if exc in title]
        if matches_negative:
            status = "IGNORED"
            ignore_reason = f"Matched negative title keyword(s): {', '.join(matches_negative)}"
            
    return status, ignore_reason
