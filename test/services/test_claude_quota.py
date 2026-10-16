from cli_agent_orchestrator.services.claude_quota import normalize_claude_usage


def test_normalizes_session_weekly_and_model_limits():
    rows = normalize_claude_usage(
        {
            "five_hour": {"utilization": 20, "resets_at": "2030-01-01T00:00:00Z"},
            "seven_day": {"utilization": 75, "resets_at": 1893456000},
            "seven_day_sonnet": {"utilization": 40},
            "limits": [
                {
                    "utilization": 10,
                    "scope": {"model": {"display_name": "Opus"}},
                }
            ],
        }
    )
    assert [row["name"] for row in rows] == [
        "Session (5h)",
        "Weekly (7d)",
        "Weekly sonnet (7d)",
        "Weekly Opus (7d)",
    ]
    assert rows[0]["remaining"] == 80
    assert rows[1]["remaining"] == 25


def test_omits_absent_and_unscoped_limits():
    rows = normalize_claude_usage({"limits": [{"utilization": 5, "scope": {}}]})
    assert rows == []
