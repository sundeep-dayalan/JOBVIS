import uuid
from sqlalchemy import Column, String, Text, DateTime, func, Integer, ForeignKey, Float
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from database import Base

class ScanSession(Base):
    __tablename__ = "scans"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    total_jobs_scanned = Column(Integer, default=0)
    total_jobs_saved = Column(Integer, default=0)
    total_ignored = Column(Integer, default=0)
    source_meta = Column(JSONB, nullable=True)

class JobPosition(Base):
    __tablename__ = "jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scan_id = Column(UUID(as_uuid=True), ForeignKey("scans.id", ondelete="CASCADE"), nullable=True)
    
    # Intelligence columns
    ai_score = Column(Float, nullable=True)
    ai_analysis = Column(JSONB, nullable=True)
    
    # Generic normalization fields
    source = Column(String, index=True) # e.g., 'linkedin'
    source_id = Column(String, index=True, nullable=True)
    title = Column(String, index=True)
    company_name = Column(String, index=True)
    description = Column(Text, nullable=True)
    source_url = Column(String, nullable=True)
    apply_url = Column(String, nullable=True)
    job_posted_at = Column(String, nullable=True)
    job_updated_at = Column(String, nullable=True)
    location = Column(String, nullable=True)
    salary_info = Column(String, nullable=True)
    status = Column(String, default="ACTIVE") 
    ignore_reason = Column(String, nullable=True)
    
    # Dynamic payload to capture anything un-mapped
    raw_data = Column(JSONB, nullable=True)
    
    # Append-only audit trail: [{timestamp, event, summary, detail}]
    activity_log = Column(JSONB, nullable=True, default=list)
    
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
    updated_at  = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
