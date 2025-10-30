#!/usr/bin/env python3
"""
test_mcp_jsonrpc.py
===================

Test script for plantuml-mcp-server via proper MCP JSON-RPC messages (stdio transport).
"""

import subprocess
import json
import time
import select
from pathlib import Path
from datetime import datetime

OUTPUT_FILE = Path("plantuml_mcp_full_exchange.json")

MCP_COMMAND = "npx"
MCP_ARGS = ["-y", "plantuml-mcp-server"]

UML_CODE = """
@startuml
actor User
User -> System : Request
System --> User : Response
@enduml
"""

def send_jsonrpc(proc, message):
    """Send one JSON-RPC message to the MCP process."""
    payload = json.dumps(message) + "\n"
    proc.stdin.write(payload)
    proc.stdin.flush()
    print(f"➡️ Sent: {payload.strip()}")

def read_responses(proc, timeout=5):
    """Read and return available JSON lines from stdout."""
    end_time = time.time() + timeout
    output = ""
    while time.time() < end_time:
        rlist, _, _ = select.select([proc.stdout], [], [], 0.2)
        if rlist:
            line = proc.stdout.readline()
            if not line:
                break
            output += line
            print(f"⬅️ Received: {line.strip()}")
    return output

def main():
    print(f"🚀 Starting MCP server: {MCP_COMMAND} {' '.join(MCP_ARGS)}")

    proc = subprocess.Popen(
        [MCP_COMMAND] + MCP_ARGS,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1
    )

    # Wait for "running on stdio transport"
    while True:
        line = proc.stdout.readline()
        if not line:
            break
        print(line.strip())
        if "running on stdio transport" in line:
            break

    time.sleep(0.5)

    # 1️⃣ initialize
    send_jsonrpc(proc, {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {}
    })

    # 2️⃣ list available tools
    send_jsonrpc(proc, {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    })

    time.sleep(0.5)

    # 3️⃣ call generate_plantuml_diagram
    send_jsonrpc(proc, {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "generate_plantuml_diagram",
            "arguments": {
                "plantuml_code": UML_CODE
            }
        }
    })

    # 4️⃣ collect responses
    stdout_data = read_responses(proc, timeout=5)
    stderr_data = proc.stderr.read()

    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()

    # 5️⃣ Parse all JSON lines
    parsed = []
    for line in stdout_data.splitlines():
        try:
            parsed.append(json.loads(line))
        except json.JSONDecodeError:
            pass

    result = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "uml_input": UML_CODE,
        "stdout_raw": stdout_data,
        "stderr_raw": stderr_data,
        "stdout_parsed": parsed
    }

    OUTPUT_FILE.write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"📦 Output saved to {OUTPUT_FILE.resolve()}")

if __name__ == "__main__":
    main()