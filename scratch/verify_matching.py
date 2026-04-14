
import asyncio
import json
import uuid
from agentic_code_editor.agent import CodeAgent
from agentic_code_editor.protocol import AgentEvent

async def test_matching():
    agent = CodeAgent()
    # Mock a plan
    plan_id = str(uuid.uuid4())
    plan = {
        "id": plan_id,
        "title": "Test Plan",
        "steps": [
            {"id": "step1", "description": "Update main.py", "files": ["main.py"], "status": "pending"},
            {"id": "step2", "description": "Create tests/test_main.py", "files": ["tests/test_main.py"], "status": "pending"}
        ]
    }
    agent._last_plan = plan
    
    print("Testing match for step 1 (main.py)...")
    events = []
    async for event in agent._update_step_status("write_file", {"path": "main.py"}, "running"):
        events.append(event)
    
    assert len(events) == 1
    assert events[0].payload["step_id"] == "step1"
    assert events[0].payload["status"] == "running"
    print("✓ Match success")

    print("Testing match for step 2 (tests/test_main.py) with leading slash...")
    events = []
    async for event in agent._update_step_status("write_file", {"path": "/tests/test_main.py"}, "completed"):
        events.append(event)
    
    assert len(events) == 1
    assert events[0].payload["step_id"] == "step2"
    assert events[0].payload["status"] == "completed"
    print("✓ Match success (leading slash)")

    print("Testing next step matching (don't match completed step)...")
    # Step 1 is NOT in _completed_steps yet in my mock state unless I add it
    agent._completed_steps.add("step1")
    
    # Try to match main.py again
    events = []
    async for event in agent._update_step_status("write_file", {"path": "main.py"}, "running"):
        events.append(event)
    
    # Should NOT match step1 because it's completed and we are trying to mark 'running'
    # And there are no other steps matching main.py
    assert len(events) == 0
    print("✓ Correctly skipped completed step")

if __name__ == "__main__":
    asyncio.run(test_matching())
