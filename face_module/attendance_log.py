from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import os
from pathlib import Path
import re
from typing import Any, Callable

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dependency is declared in requirements.txt
    load_dotenv = None


ARRIVAL = "arrival"
DEPARTURE = "departure"
SOURCE_FACE = "face"


class AttendanceLogError(RuntimeError):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail

    def to_payload(self) -> dict[str, str]:
        return {
            "code": self.code,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class StudentRecord:
    id: str
    name: str
    class_id: str

    def to_payload(self) -> dict[str, str]:
        return {
            "student_id": self.id,
            "name": self.name,
            "class_id": self.class_id,
        }


@dataclass(frozen=True)
class PresenceEvent:
    id: str
    student_id: str
    class_id: str
    event_type: str
    occurred_at: str
    attendance_date: str
    source: str = SOURCE_FACE
    idempotency_key: str = ""

    def to_payload(self) -> dict[str, str]:
        return {
            "id": self.id,
            "student_id": self.student_id,
            "class_id": self.class_id,
            "event_type": self.event_type,
            "occurred_at": self.occurred_at,
            "attendance_date": self.attendance_date,
            "source": self.source,
            "idempotency_key": self.idempotency_key,
        }


@dataclass(frozen=True)
class AttendanceResult:
    student: StudentRecord
    event_type: str
    status: str
    event: PresenceEvent | None = None
    duplicate: bool = False
    dry_run: bool = False
    skipped_reason: str = ""

    @property
    def attendance_status(self) -> str:
        if self.status == "cooldown":
            return "cooldown"
        return "present" if self.event_type == ARRIVAL else "departed"

    def to_payload(self) -> dict[str, Any]:
        return {
            **self.student.to_payload(),
            "event_type": self.event_type,
            "attendance_status": self.attendance_status,
            "attendance_result": self.status,
            "duplicate": self.duplicate,
            "dry_run": self.dry_run,
            "skipped_reason": self.skipped_reason,
            "event": self.event.to_payload() if self.event else None,
        }


def load_environment(extra_paths: list[str | Path] | None = None) -> None:
    if load_dotenv is None:
        return
    module_dir = Path(__file__).resolve().parent
    candidates = [
        Path.cwd() / ".env",
        module_dir.parent / ".env",
        module_dir / ".env",
        *(Path(path) for path in (extra_paths or [])),
    ]
    for env_path in candidates:
        if env_path.exists():
            load_dotenv(env_path, override=False)


def next_presence_event_type(latest_event: PresenceEvent | dict[str, Any] | None) -> str:
    if not latest_event:
        return ARRIVAL
    event_type = latest_event.event_type if isinstance(latest_event, PresenceEvent) else latest_event.get("event_type")
    return DEPARTURE if event_type == ARRIVAL else ARRIVAL


def event_state(event_type: str) -> str:
    return "present" if event_type == ARRIVAL else "departed"


def build_idempotency_key(
    station_id: str,
    student_id: str,
    attendance_date: str,
    event_type: str,
    now: datetime,
    bucket_seconds: int,
) -> str:
    bucket = int(now.timestamp() // max(1, int(bucket_seconds or 1)))
    station = re.sub(r"[^a-zA-Z0-9_-]+", "-", station_id.strip().lower()).strip("-") or "station"
    station = station[:18]
    raw = f"face:{station}:{student_id}:{attendance_date}:{event_type}:{bucket}"
    if len(raw) <= 64:
        return raw
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    student_tail = str(student_id)[-12:]
    return f"face:{student_tail}:{attendance_date}:{event_type}:{digest}"[:64]


class AttendanceLogger:
    def __init__(
        self,
        connection_factory: Callable[[], Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
        env_files: list[str | Path] | None = None,
        load_env: bool = True,
    ) -> None:
        if load_env:
            load_environment(env_files)
        self._connection_factory = connection_factory
        self._now_fn = now_fn or datetime.now

    def check_ready(self) -> None:
        conn = self._connect()
        cursor = conn.cursor(dictionary=True)
        try:
            cursor.execute("SELECT 1 AS ok")
            cursor.fetchone()
        finally:
            close_quietly(cursor)
            close_quietly(conn)

    def resolve_student(self, student_id: str | int) -> StudentRecord:
        conn = self._connect()
        cursor = conn.cursor(dictionary=True)
        try:
            student = self._lookup_student(cursor, student_id)
            if not student:
                raise AttendanceLogError("student_not_found", f"student_id={student_id}")
            return student
        except AttendanceLogError:
            raise
        except Exception as exc:
            raise AttendanceLogError("database_query_failed", sanitize_exception(exc)) from exc
        finally:
            close_quietly(cursor)
            close_quietly(conn)

    def preview_toggle(self, student_id: str | int, now: datetime | None = None) -> AttendanceResult:
        now_dt = now or self._now_fn()
        attendance_date = now_dt.date().isoformat()
        conn = self._connect()
        cursor = conn.cursor(dictionary=True)
        try:
            student = self._lookup_student(cursor, student_id)
            if not student:
                raise AttendanceLogError("student_not_found", f"student_id={student_id}")
            latest_event = self._get_latest_event(cursor, student.id, attendance_date, for_update=False)
            event_type = next_presence_event_type(latest_event)
            return AttendanceResult(student=student, event_type=event_type, status="dry_run", dry_run=True)
        except AttendanceLogError:
            raise
        except Exception as exc:
            raise AttendanceLogError("database_query_failed", sanitize_exception(exc)) from exc
        finally:
            close_quietly(cursor)
            close_quietly(conn)

    def mark_toggle(
        self,
        student_id: str | int,
        station_id: str = "main-door",
        actor_id: str | int | None = None,
        cooldown_seconds: int = 20,
        now: datetime | None = None,
    ) -> AttendanceResult:
        now_dt = now or self._now_fn()
        now_sql = format_sql_datetime(now_dt)
        attendance_date = now_dt.date().isoformat()
        conn = self._connect()
        cursor = conn.cursor(dictionary=True)
        lock_acquired = False
        lock_student_id = str(student_id)

        try:
            begin_transaction(conn)
            student = self._lookup_student(cursor, student_id)
            if not student:
                raise AttendanceLogError("student_not_found", f"student_id={student_id}")
            lock_student_id = student.id

            lock_acquired = self._acquire_lock(cursor, student.id, attendance_date)
            if not lock_acquired:
                raise AttendanceLogError("presence_lock_timeout", f"student_id={student.id} date={attendance_date}")

            latest_event = self._get_latest_event(cursor, student.id, attendance_date, for_update=True)
            event_type = next_presence_event_type(latest_event)
            idempotency_key = build_idempotency_key(
                station_id=station_id,
                student_id=student.id,
                attendance_date=attendance_date,
                event_type=event_type,
                now=now_dt,
                bucket_seconds=cooldown_seconds,
            )

            existing = self._get_event_by_idempotency_key(cursor, idempotency_key)
            if existing:
                commit(conn)
                return AttendanceResult(
                    student=student,
                    event=existing,
                    event_type=existing.event_type,
                    status="duplicate",
                    duplicate=True,
                )

            if latest_event and is_within_cooldown(latest_event, now_dt, cooldown_seconds):
                commit(conn)
                return AttendanceResult(
                    student=student,
                    event=latest_event,
                    event_type=event_type,
                    status="cooldown",
                    skipped_reason="event_cooldown",
                )

            cursor.execute(
                """
                INSERT INTO attendance.presence_events
                    (student_id, class_id, event_type, occurred_at, attendance_date, actor_id, source, idempotency_key)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    student.id,
                    student.class_id,
                    event_type,
                    now_sql,
                    attendance_date,
                    normalize_optional_int(actor_id),
                    SOURCE_FACE,
                    idempotency_key,
                ),
            )
            inserted_id = str(getattr(cursor, "lastrowid", "") or "")
            event = self._get_event_by_id(cursor, inserted_id) if inserted_id else None
            if event is None:
                event = PresenceEvent(
                    id=inserted_id,
                    student_id=student.id,
                    class_id=student.class_id,
                    event_type=event_type,
                    occurred_at=now_sql,
                    attendance_date=attendance_date,
                    source=SOURCE_FACE,
                    idempotency_key=idempotency_key,
                )
            commit(conn)
            return AttendanceResult(student=student, event=event, event_type=event_type, status="inserted")
        except Exception as exc:
            rollback(conn)
            if isinstance(exc, AttendanceLogError):
                raise
            raise AttendanceLogError("database_query_failed", sanitize_exception(exc)) from exc
        finally:
            if lock_acquired:
                self._release_lock(cursor, lock_student_id, attendance_date)
            close_quietly(cursor)
            close_quietly(conn)

    def _connect(self) -> Any:
        if self._connection_factory is not None:
            return self._connection_factory()
        try:
            import mysql.connector
        except ImportError as exc:  # pragma: no cover - dependency is declared in requirements.txt
            raise AttendanceLogError("mysql_connector_not_installed", "install mysql-connector-python") from exc

        settings = {
            "host": os.getenv("MDBHOST"),
            "user": os.getenv("DBUSER"),
            "password": os.getenv("DBPASS", ""),
            "database": os.getenv("DBNAMESUSR") or None,
            "charset": "utf8mb4",
            "collation": "utf8mb4_general_ci",
            "autocommit": False,
        }
        missing = [key for key in ("host", "user") if not settings[key]]
        if missing:
            missing_names = {
                "host": "MDBHOST",
                "user": "DBUSER",
            }
            raise AttendanceLogError(
                "database_environment_missing",
                ", ".join(missing_names[key] for key in missing),
            )
        try:
            return mysql.connector.connect(**settings)
        except Exception as exc:
            raise AttendanceLogError("database_connect_failed", sanitize_exception(exc)) from exc

    def _lookup_student(self, cursor: Any, student_id: str | int) -> StudentRecord | None:
        cursor.execute(
            """
            SELECT
                CAST(id AS CHAR) AS id,
                COALESCE(NULLIF(display_name_custom, ''), NULLIF(nickname, ''), NULLIF(msgnickname, ''), name) AS name,
                CAST(kaf AS CHAR) AS class_id
            FROM sso.users
            WHERE id = %s
              AND type = 1
              AND status = 1
            LIMIT 1
            """,
            (normalize_student_id(student_id),),
        )
        row = cursor.fetchone()
        return map_student(row) if row else None

    def _get_latest_event(self, cursor: Any, student_id: str, attendance_date: str, for_update: bool) -> PresenceEvent | None:
        suffix = "FOR UPDATE" if for_update else ""
        cursor.execute(
            f"""
            {presence_event_select_sql()}
            WHERE e.student_id = %s
              AND e.attendance_date = %s
              AND e.cancelled_at IS NULL
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT 1
            {suffix}
            """,
            (student_id, attendance_date),
        )
        row = cursor.fetchone()
        return map_presence_event(row) if row else None

    def _get_event_by_idempotency_key(self, cursor: Any, idempotency_key: str) -> PresenceEvent | None:
        cursor.execute(
            f"""
            {presence_event_select_sql()}
            WHERE e.idempotency_key = %s
            LIMIT 1
            """,
            (idempotency_key,),
        )
        row = cursor.fetchone()
        return map_presence_event(row) if row else None

    def _get_event_by_id(self, cursor: Any, event_id: str) -> PresenceEvent | None:
        cursor.execute(
            f"""
            {presence_event_select_sql()}
            WHERE e.id = %s
            LIMIT 1
            """,
            (event_id,),
        )
        row = cursor.fetchone()
        return map_presence_event(row) if row else None

    def _acquire_lock(self, cursor: Any, student_id: str, attendance_date: str) -> bool:
        cursor.execute("SELECT GET_LOCK(%s, 3) AS locked", (presence_lock_name(student_id, attendance_date),))
        row = cursor.fetchone()
        return int((row or {}).get("locked") or 0) == 1

    def _release_lock(self, cursor: Any, student_id: str, attendance_date: str) -> None:
        try:
            cursor.execute("DO RELEASE_LOCK(%s)", (presence_lock_name(student_id, attendance_date),))
        except Exception:
            pass


def presence_event_select_sql() -> str:
    return """
        SELECT
            CAST(e.id AS CHAR) AS id,
            CAST(e.student_id AS CHAR) AS student_id,
            CAST(e.class_id AS CHAR) AS class_id,
            e.event_type,
            DATE_FORMAT(e.occurred_at, '%%Y-%%m-%%d %%H:%%i:%%s') AS occurred_at,
            DATE_FORMAT(e.attendance_date, '%%Y-%%m-%%d') AS attendance_date,
            e.source,
            e.idempotency_key
        FROM attendance.presence_events e
    """


def map_student(row: dict[str, Any]) -> StudentRecord:
    return StudentRecord(
        id=str(row.get("id") or ""),
        name=str(row.get("name") or row.get("id") or ""),
        class_id=str(row.get("class_id") or row.get("classId") or ""),
    )


def map_presence_event(row: dict[str, Any]) -> PresenceEvent:
    event_type = row.get("event_type") if row.get("event_type") == DEPARTURE else ARRIVAL
    return PresenceEvent(
        id=str(row.get("id") or ""),
        student_id=str(row.get("student_id") or ""),
        class_id=str(row.get("class_id") or ""),
        event_type=event_type,
        occurred_at=format_sql_value(row.get("occurred_at")),
        attendance_date=format_sql_date_value(row.get("attendance_date")),
        source=str(row.get("source") or SOURCE_FACE),
        idempotency_key=str(row.get("idempotency_key") or ""),
    )


def normalize_student_id(value: str | int) -> int:
    try:
        student_id = int(str(value).strip())
    except (TypeError, ValueError) as exc:
        raise AttendanceLogError("invalid_student_id", str(value)) from exc
    if student_id <= 0:
        raise AttendanceLogError("invalid_student_id", str(value))
    return student_id


def normalize_optional_int(value: str | int | None) -> int | None:
    if value in (None, ""):
        return None
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError) as exc:
        raise AttendanceLogError("invalid_actor_id", str(value)) from exc
    return number if number > 0 else None


def presence_lock_name(student_id: str, attendance_date: str) -> str:
    return f"attendance:presence:{student_id}:{attendance_date}"


def is_within_cooldown(event: PresenceEvent, now: datetime, cooldown_seconds: int) -> bool:
    if cooldown_seconds <= 0:
        return False
    occurred_at = parse_sql_datetime(event.occurred_at)
    if occurred_at is None:
        return False
    return 0 <= (now - occurred_at).total_seconds() < cooldown_seconds


def format_sql_datetime(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S")


def format_sql_value(value: Any) -> str:
    if isinstance(value, datetime):
        return format_sql_datetime(value)
    return str(value or "")


def format_sql_date_value(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    return str(value or "")


def parse_sql_datetime(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None


def begin_transaction(conn: Any) -> None:
    if hasattr(conn, "start_transaction"):
        conn.start_transaction()
    elif hasattr(conn, "begin"):
        conn.begin()


def commit(conn: Any) -> None:
    if hasattr(conn, "commit"):
        conn.commit()


def rollback(conn: Any) -> None:
    if hasattr(conn, "rollback"):
        conn.rollback()


def close_quietly(resource: Any) -> None:
    try:
        resource.close()
    except Exception:
        pass


def sanitize_exception(exc: Exception) -> str:
    parts = [exc.__class__.__name__]
    errno = getattr(exc, "errno", None)
    sqlstate = getattr(exc, "sqlstate", None)
    if errno:
        parts.append(f"errno={errno}")
    if sqlstate:
        parts.append(f"sqlstate={sqlstate}")
    message = str(exc).strip()
    if message:
        parts.append(message[:240])
    return " ".join(parts)
