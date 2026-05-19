import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv()

DATABASE_URL = (
    f"mysql+pymysql://{os.getenv('DB_USER')}:"
    f"{os.getenv('DB_PASSWORD')}@"
    f"{os.getenv('DB_HOST')}:"
    f"{os.getenv('DB_PORT')}/"
    f"{os.getenv('DB_NAME')}"
)

engine = create_engine(
    DATABASE_URL,

    # 开发环境建议 True
    # 部署生产环境建议 False
    echo=True,

    # 连接池配置
    pool_size=10,
    max_overflow=20,
    pool_recycle=3600,

    # 自动检测失效连接（很重要）
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(
    autoflush=False,
    autocommit=False,
    bind=engine,

    # 防止提交后对象失效
    expire_on_commit=False,
)

Base = declarative_base()