from datetime import datetime

import pytest

from face_module.attendance_log import ARRIVAL, DEPARTURE, SOURCE_FACE, AttendanceLogError, AttendanceLogger
from face_module.attendance_log import presence_event_select_sql


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self.rows = []
        self.lastrowid = 0

    def execute(self, sql, params=()):
        self.conn.queries.append((sql, params))
        normalized = " ".join(sql.lower().split())
        self.rows = []
        if "from sso.users" in normalized:
            self.rows = [self.conn.student] if self.conn.student else []
        elif "get_lock" in normalized:
            self.rows = [{"locked": 1}]
        elif "where e.idempotency_key" in normalized:
            self.rows = [self.conn.idempotency_event] if self.conn.idempotency_event else []
        elif normalized.startswith("insert into attendance.presence_events"):
            self.conn.insert_count += 1
            self.conn.insert_params = params
            self.lastrowid = 101
            self.conn.inserted_event = {
                "id": "101",
                "student_id": str(params[0]),
                "class_id": str(params[1]),
                "event_type": params[2],
                "occurred_at": params[3],
                "attendance_date": params[4],
                "source": params[6],
                "idempotency_key": params[7],
            }
        elif "where e.id = %s" in normalized:
            self.rows = [self.conn.inserted_event] if self.conn.inserted_event else []
        elif "from attendance.presence_events e" in normalized and "where e.student_id" in normalized:
            self.rows = [self.conn.latest_event] if self.conn.latest_event else []

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def close(self):
        pass


class FakeConnection:
    def __init__(self):
        self.student = {"id": "48", "name": "Test Student", "class_id": "7"}
        self.latest_event = None
        self.idempotency_event = None
        self.inserted_event = None
        self.insert_params = None
        self.insert_count = 0
        self.queries = []
        self.commits = 0
        self.rollbacks = 0

    def cursor(self, dictionary=False):
        assert dictionary is True
        return FakeCursor(self)

    def start_transaction(self):
        pass

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        pass


def logger_for(fake, now=None):
    return AttendanceLogger(
        connection_factory=lambda: fake,
        now_fn=lambda: now or datetime(2026, 5, 22, 8, 0, 0),
    )


def assert_no_sso_writes(fake):
    for sql, _params in fake.queries:
        normalized = " ".join(sql.lower().split()).strip()
        assert not normalized.startswith("insert into sso.")
        assert not normalized.startswith("update sso.")
        assert not normalized.startswith("delete from sso.")
        assert not normalized.startswith("alter table sso.")


def test_mark_toggle_reads_sso_and_writes_face_source():
    fake = FakeConnection()

    result = logger_for(fake).mark_toggle("48", station_id="main-door", cooldown_seconds=20)

    assert result.status == "inserted"
    assert result.event_type == ARRIVAL
    assert result.student.name == "Test Student"
    assert fake.insert_count == 1
    assert fake.insert_params[6] == SOURCE_FACE
    assert any("FROM sso.users" in sql for sql, _params in fake.queries)
    assert_no_sso_writes(fake)


def test_mark_toggle_departure_after_existing_arrival():
    fake = FakeConnection()
    fake.latest_event = {
        "id": "99",
        "student_id": "48",
        "class_id": "7",
        "event_type": ARRIVAL,
        "occurred_at": "2026-05-22 07:00:00",
        "attendance_date": "2026-05-22",
        "source": SOURCE_FACE,
        "idempotency_key": "old",
    }

    result = logger_for(fake).mark_toggle("48", station_id="main-door", cooldown_seconds=20)

    assert result.status == "inserted"
    assert result.event_type == DEPARTURE
    assert fake.insert_params[2] == DEPARTURE


def test_mark_toggle_blocks_fast_repeat_with_cooldown():
    fake = FakeConnection()
    fake.latest_event = {
        "id": "99",
        "student_id": "48",
        "class_id": "7",
        "event_type": ARRIVAL,
        "occurred_at": "2026-05-22 07:59:50",
        "attendance_date": "2026-05-22",
        "source": SOURCE_FACE,
        "idempotency_key": "old",
    }

    result = logger_for(fake).mark_toggle("48", station_id="main-door", cooldown_seconds=20)

    assert result.status == "cooldown"
    assert result.skipped_reason == "event_cooldown"
    assert result.event_type == DEPARTURE
    assert fake.insert_count == 0


def test_mark_toggle_returns_duplicate_by_idempotency_key():
    fake = FakeConnection()
    fake.idempotency_event = {
        "id": "55",
        "student_id": "48",
        "class_id": "7",
        "event_type": ARRIVAL,
        "occurred_at": "2026-05-22 08:00:00",
        "attendance_date": "2026-05-22",
        "source": SOURCE_FACE,
        "idempotency_key": "existing",
    }

    result = logger_for(fake).mark_toggle("48", station_id="main-door", cooldown_seconds=20)

    assert result.status == "duplicate"
    assert result.duplicate is True
    assert result.event.id == "55"
    assert fake.insert_count == 0


def test_missing_required_db_env_reports_variable_names(monkeypatch):
    monkeypatch.delenv("MDBHOST", raising=False)
    monkeypatch.delenv("DBUSER", raising=False)
    monkeypatch.delenv("DBPASS", raising=False)
    monkeypatch.delenv("DBNAMESUSR", raising=False)

    with pytest.raises(AttendanceLogError) as exc:
        AttendanceLogger(load_env=False)._connect()

    assert exc.value.code == "database_environment_missing"
    assert exc.value.detail == "MDBHOST, DBUSER"


def test_db_password_can_be_empty(monkeypatch):
    import mysql.connector

    captured = {}

    def fake_connect(**settings):
        captured.update(settings)
        return FakeConnection()

    monkeypatch.setenv("MDBHOST", "localhost")
    monkeypatch.setenv("DBUSER", "attendance")
    monkeypatch.delenv("DBPASS", raising=False)
    monkeypatch.delenv("DBNAMESUSR", raising=False)
    monkeypatch.setattr(mysql.connector, "connect", fake_connect)

    AttendanceLogger(load_env=False)._connect()

    assert captured["password"] == ""


def test_presence_select_escapes_percent_for_mysql_connector():
    sql = presence_event_select_sql()

    assert "'%%Y-%%m-%%d %%H:%%i:%%s'" in sql
    assert "'%%Y-%%m-%%d'" in sql
    assert "'%Y-%m-%d" not in sql
