import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

APP_ENV = os.getenv("APP_ENV", "dev").lower()
DB_NAME = "jobvisdb_prod" if APP_ENV == "prod" else "jobvisdb_dev"
SQLALCHEMY_DATABASE_URL = f"postgresql://jobvis:jobvispassword@localhost:5432/{DB_NAME}"

engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def ensure_database_exists():
    """Ensure the target DB exists, creating it via the default database if missing."""
    default_engine = create_engine("postgresql://jobvis:jobvispassword@localhost:5432/postgres", isolation_level="AUTOCOMMIT")
    with default_engine.connect() as conn:
        res = conn.execute(text(f"SELECT 1 FROM pg_database WHERE datname='{DB_NAME}'")).scalar()
        if not res:
            conn.execute(text(f"CREATE DATABASE {DB_NAME}"))
    default_engine.dispose()

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
