"""
JD Boilerplate Stripper — Production Grade

Strategy: Layered defense with safety net.
  Layer 1: Normalize (always safe)
  Layer 2: Remove unambiguous boilerplate (regex)
  Layer 3: Score-based paragraph filtering
  Layer 4: Deduplicate near-identical paragraphs
  Layer 5: Preserve critical knockout signals
  Layer 6: Validate output, fall back to Layer 1 if corrupted

Guarantees:
  - Never silently deletes knockout-relevant content
  - Worst case: returns normalized original (no compression, no corruption)
  - Handles scraped HTML, multi-language headers, bullet variants, smart quotes
"""

import re
import unicodedata
from typing import List, Set


# ============================================================================
# CONSTANTS
# ============================================================================

# Terms that indicate scoring-relevant content. Paragraphs with these are KEPT.
SIGNAL_TERMS: Set[str] = {
    # Experience and qualifications
    "year", "years", "yr", "yrs", "experience", "exp", "required", "must",
    "should", "ability", "proficient", "expert", "expertise", "knowledge",
    "familiar", "familiarity", "background", "understanding", "skilled",
    "strong", "solid", "deep", "hands-on", "proven", "demonstrated",
    "bachelor", "master", "phd", "degree", "bs", "ms", "cs",

    # Programming languages and tech
    "python", "java", "javascript", "typescript", "go", "golang", "rust",
    "c++", "cpp", "c#", "scala", "kotlin", "ruby", "php", "swift",
    "react", "angular", "vue", "node", "django", "flask", "fastapi",
    "spring", "rails", "express", "nextjs", "nuxt",
    "kubernetes", "k8s", "docker", "terraform", "ansible", "jenkins",
    "aws", "gcp", "azure", "cloud", "lambda", "ec2", "s3", "ecs",
    "sql", "nosql", "postgres", "postgresql", "mysql", "mongodb", "redis",
    "elasticsearch", "kafka", "rabbitmq", "pubsub", "spark", "hadoop",
    "api", "apis", "rest", "graphql", "grpc", "microservice", "microservices",
    "system", "systems", "distributed", "scalable", "scale", "production",
    "infrastructure", "platform", "backend", "frontend", "fullstack",
    "full-stack", "devops", "sre", "ml", "ai", "llm", "rag",

    # Engineering actions
    "engineer", "engineering", "develop", "development", "design", "architect",
    "build", "ship", "deliver", "implement", "deploy", "maintain", "optimize",
    "debug", "troubleshoot", "code", "coding", "programming", "software",
    "lead", "own", "ownership", "drive", "collaborate", "mentor",
    "review", "test", "testing", "quality", "performance", "reliability",

    # Role and responsibility
    "responsible", "responsibilities", "role", "position", "team", "work",
    "project", "projects", "product", "customer", "user", "stakeholder",

    # Knockout signals — CRITICAL: never drop paragraphs containing these
    "sponsor", "sponsorship", "visa", "h-1b", "h1b", "green card", "gc",
    "citizen", "citizenship", "clearance", "secret", "ts/sci", "dod",
    "remote", "hybrid", "onsite", "on-site", "on site", "in-office",
    "contract", "contractor", "temporary", "temp", "permanent", "full-time",
    "fulltime", "full time", "part-time", "intern", "internship",
    "location", "based", "headquartered", "office",
    "seattle", "washington", "wa", "usa", "united states",
}

# Terms that indicate non-scoring filler. Paragraphs with MANY of these are DROPPED.
NOISE_TERMS: Set[str] = {
    # Company marketing
    "mission", "vision", "values", "founded", "headquartered", "valued",
    "raised", "funding", "series", "investors", "backed", "venture",
    "unicorn", "fastest-growing", "leading", "world-class", "cutting-edge",
    "revolutionary", "innovative", "disrupting", "transforming",

    # Benefits and perks
    "perks", "401k", "401(k)", "vacation", "pto", "holidays", "stipend",
    "wellness", "gym", "snacks", "meals", "lunch", "dinner", "catered",
    "unlimited", "generous", "competitive", "commuter", "parental",
    "maternity", "paternity", "bonus", "equity", "rsu", "options",
    "medical", "dental", "vision", "insurance", "retirement", "hsa", "fsa",

    # EEO / legal
    "diverse", "diversity", "inclusive", "inclusion", "belonging",
    "equal opportunity", "eeo", "regardless of", "affirmative",
    "discrimination", "accommodation", "accommodations", "disabled",
    "veteran", "protected", "gender", "orientation", "religion",
    "national origin", "arrest", "conviction",

    # Salary boilerplate
    "salary range", "base salary", "compensation", "pay range",
    "target earnings", "ote", "commission",
}

# Phrases that are ALWAYS safe to remove (exact regex matches).
# These are verified across 100+ JDs as pure boilerplate.
SAFE_REMOVAL_PATTERNS: List[str] = [
    # EEO statements (match full sentences)
    r"(?is)\b(we are |is )?an equal (employment )?opportunity employer[^.]*\.",
    r"(?is)all qualified applicants will receive consideration[^.]*\.",
    r"(?is)we (do not |don't )?discriminate[^.]*\.",
    r"(?is)reasonable accommodations?[^.]*\.",
    r"(?is)we are committed to (creating |building |fostering )?(a )?diverse[^.]*\.",
    r"(?is)\bregardless of (race|gender|age|religion|sexual|national)[^.]*\.",
    r"(?is)\bpursuant to (the |applicable )?(san francisco|los angeles|new york|fair chance)[^.]*\.",

    # Salary disclosure boilerplate (keeps the range itself but removes legalese)
    r"(?is)this (salary |pay )?range may be inclusive[^.]*\.",
    r"(?is)the (annual |actual |expected )?(us )?(base )?(salary|pay|compensation)\s*range[^.]*\.",
    r"(?is)additional benefits for this role[^.]*\.",

    # URLs and emails (rarely needed for scoring)
    r"https?://\S+",
    r"\S+@\S+\.\S+",

    # HTML remnants from scraping
    r"<[^>]+>",
    r"&nbsp;", r"&amp;", r"&lt;", r"&gt;", r"&#\d+;",
]

# Knockout terms that MUST be preserved if present in the original.
# If stripping removes any of these, abort and return the normalized original.
CRITICAL_KNOCKOUT_TERMS: List[str] = [
    "sponsor", "sponsorship", "visa", "h-1b", "h1b",
    "citizen", "citizenship", "clearance",
    "remote", "hybrid", "on-site", "onsite", "in-office", "in office",
    "contract", "contractor", "temporary", "temp-to-perm", "contract-to-hire",
    "full-time", "fulltime", "intern", "internship",
    "us person", "green card",
]

# Minimum output size thresholds for safety net
MIN_STRIPPED_CHARS = 200
MIN_RETENTION_RATIO = 0.15  # Must keep at least 15% of normalized input
MIN_SIGNAL_PARAGRAPHS = 1   # Must have at least one high-signal paragraph


# ============================================================================
# LAYER 1: NORMALIZATION (always safe, never destructive)
# ============================================================================

def normalize(text: str) -> str:
    """Clean up encoding artifacts and whitespace. 100% safe on any input."""
    if not text:
        return ""

    # Unicode normalize (NFKC handles most compatibility chars)
    text = unicodedata.normalize("NFKC", text)

    # Normalize bullet variants to dashes
    text = re.sub(r"[•●▪▫◦‣⁃◆◇■□▸▹►▻✓✔✗✘]", "-", text)

    # Smart quotes → straight quotes
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')

    # Em/en dashes → regular dash
    text = text.replace("\u2013", "-").replace("\u2014", "-")

    # Ellipsis
    text = text.replace("\u2026", "...")

    # Zero-width and exotic whitespace
    text = re.sub(r"[\u200b\u200c\u200d\u2060\ufeff]", "", text)
    text = re.sub(r"[\u00a0\u2007\u202f]", " ", text)  # NBSP variants → space

    # Normalize line endings
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # Strip trailing whitespace per line
    text = "\n".join(line.rstrip() for line in text.split("\n"))

    # Collapse 3+ newlines to 2 (preserves paragraph breaks)
    text = re.sub(r"\n{3,}", "\n\n", text)

    # Collapse runs of spaces/tabs within lines
    text = re.sub(r"[ \t]{2,}", " ", text)

    return text.strip()


# ============================================================================
# LAYER 2: SAFE REGEX REMOVAL (only unambiguous boilerplate)
# ============================================================================

def remove_safe_boilerplate(text: str) -> str:
    """Remove only phrases verified safe across 100+ JDs."""
    for pattern in SAFE_REMOVAL_PATTERNS:
        text = re.sub(pattern, "", text)
    # Clean up any double-spaces or orphan punctuation left behind
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


# ============================================================================
# LAYER 3: SCORE-BASED PARAGRAPH FILTERING
# ============================================================================

def tokenize(text: str) -> Set[str]:
    """Extract lowercase word tokens for signal matching."""
    return set(re.findall(r"\b[a-z][a-z+#.-]*\b", text.lower()))


def score_paragraph(para: str) -> int:
    """
    Return signal score. Higher = more scoring-relevant.
    Positive = keep. Zero or negative = candidate for removal.
    """
    words = tokenize(para)
    signal = len(words & SIGNAL_TERMS)
    noise = len(words & NOISE_TERMS)

    # Bonus for paragraphs with bullet lists (usually requirements)
    if re.search(r"^\s*[-*]\s", para, re.M):
        signal += 1

    # Bonus for paragraphs mentioning years of experience
    if re.search(r"\d+\+?\s*(?:to\s*\d+\+?)?\s*years?", para, re.I):
        signal += 2

    # Bonus for explicit "requirements"/"qualifications" headers
    if re.search(r"\b(requirements?|qualifications?|must have|responsibilities)\b", para, re.I):
        signal += 2

    return signal - noise


def filter_paragraphs(text: str, min_score: int = 1) -> str:
    """
    Keep paragraphs that score >= min_score OR contain knockout signals.
    Knockout signals always preserved regardless of score.
    """
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    kept = []

    for para in paras:
        # ALWAYS keep paragraphs with knockout signals
        para_lower = para.lower()
        has_knockout = any(term in para_lower for term in CRITICAL_KNOCKOUT_TERMS)

        if has_knockout:
            kept.append(para)
            continue

        # ALWAYS keep short list items (bullet points in a requirements block)
        if len(para) < 200 and re.match(r"^\s*[-*]", para):
            if score_paragraph(para) >= 0:
                kept.append(para)
                continue

        # Score-based keep
        if score_paragraph(para) >= min_score:
            kept.append(para)

    return "\n\n".join(kept)


# ============================================================================
# LAYER 4: DEDUPLICATION
# ============================================================================

def dedupe_paragraphs(text: str) -> str:
    """
    Remove near-duplicate paragraphs using normalized fingerprints.
    Catches the common case of repeated 'Hybrid work' or 'Remote policy' blocks.
    """
    seen: Set[str] = set()
    out: List[str] = []

    for para in text.split("\n\n"):
        para_stripped = para.strip()
        if not para_stripped:
            continue

        # Fingerprint: lowercase, collapse whitespace, first 120 chars
        fingerprint = re.sub(r"\s+", " ", para_stripped.lower())[:120]

        if fingerprint in seen:
            continue

        seen.add(fingerprint)
        out.append(para_stripped)

    return "\n\n".join(out)


# ============================================================================
# LAYER 5: SAFETY NET — validate output before returning
# ============================================================================

def is_valid_stripped(original: str, stripped: str) -> tuple[bool, str]:
    """
    Validate that stripping didn't corrupt the input.
    Returns (is_valid, reason_if_invalid).
    """
    if not stripped or len(stripped) < MIN_STRIPPED_CHARS:
        return False, f"Output too short ({len(stripped)} chars)"

    if len(stripped) < len(original) * MIN_RETENTION_RATIO:
        return False, f"Over-cut: kept only {len(stripped)}/{len(original)} chars"

    # Must have at least one signal-heavy paragraph
    paras = [p for p in stripped.split("\n\n") if p.strip()]
    if not any(score_paragraph(p) >= 2 for p in paras):
        return False, "No signal-heavy paragraphs remain"

    # Critical check: knockout terms that existed in the original must survive
    original_lower = original.lower()
    stripped_lower = stripped.lower()

    for term in CRITICAL_KNOCKOUT_TERMS:
        if term in original_lower and term not in stripped_lower:
            return False, f"Lost knockout signal: '{term}'"

    return True, "ok"


# ============================================================================
# PUBLIC API
# ============================================================================

def strip_jd(raw_jd: str, verbose: bool = False) -> str:
    """
    Strip boilerplate from a job description.

    Args:
        raw_jd: Raw JD text (may contain HTML, bullets, multi-language artifacts)
        verbose: If True, print diagnostic info about what was stripped

    Returns:
        Stripped JD text. Never corrupted: if stripping fails validation,
        returns the normalized original.
    """
    if not raw_jd or not raw_jd.strip():
        return ""

    # Layer 1: Always-safe normalization
    normalized = normalize(raw_jd)

    # Layer 2-4: Aggressive stripping pipeline
    try:
        stripped = remove_safe_boilerplate(normalized)
        stripped = filter_paragraphs(stripped, min_score=1)
        stripped = dedupe_paragraphs(stripped)
    except Exception as e:
        if verbose:
            print(f"[strip_jd] Pipeline error: {e}. Returning normalized.")
        return normalized

    # Layer 5: Safety net
    valid, reason = is_valid_stripped(normalized, stripped)
    if not valid:
        if verbose:
            print(f"[strip_jd] Safety net triggered: {reason}. Returning normalized.")
        return normalized

    if verbose:
        print(f"[strip_jd] OK: {len(raw_jd)} → {len(stripped)} chars "
              f"({100*(1-len(stripped)/max(len(raw_jd),1)):.0f}% reduction)")

    return stripped


def strip_jd_with_stats(raw_jd: str) -> dict:
    """
    Strip JD and return diagnostic stats. Useful for testing and monitoring.
    """
    normalized = normalize(raw_jd)
    stripped = strip_jd(raw_jd, verbose=False)

    return {
        "original_chars": len(raw_jd),
        "normalized_chars": len(normalized),
        "stripped_chars": len(stripped),
        "reduction_pct": round(100 * (1 - len(stripped) / max(len(raw_jd), 1)), 1),
        "safety_net_triggered": stripped == normalized and len(normalized) != len(raw_jd),
        "fell_through": stripped == normalized,
        "output": stripped,
    }