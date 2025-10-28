#!/usr/bin/env python3
"""
Simple end-to-end MCP over SSE test script (no third-party dependencies).

Usage:
    scripts/test_mcp.py --base-url http://localhost:8765 --api-key <KEY>

The script performs the handshake (initialize → initialized), lists tools
and prompts, and prints the JSON responses.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterator, Optional


SESSION_EVENT_PREFIX = "data: "
DEFAULT_PROTOCOL_VERSION = "2024-11-05"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Test PlantUML MCP server over SSE transport.")
    parser.add_argument(
        "--base-url",
        default=os.getenv("MCP_BASE_URL", "http://localhost:8765"),
        help="Base URL for the MCP SSE server (default: %(default)s).",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("MCP_API_KEY"),
        help="API key for MCP authentication (default: read from MCP_API_KEY env var).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="Timeout for HTTP operations in seconds (default: %(default)s).",
    )
    return parser.parse_args()


def read_session_endpoint(base_url: str, api_key: str, timeout: float) -> tuple[str, Any]:
    headers: Dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    stream_url = urllib.parse.urljoin(base_url.rstrip("/") + "/", "sse")
    session_url: Optional[str] = None

    request = urllib.request.Request(stream_url, headers=headers, method="GET")
    response = urllib.request.urlopen(request, timeout=timeout)

    while True:
        raw_line = response.readline()
        if not raw_line:
            break
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        if line.startswith(SESSION_EVENT_PREFIX):
            session_url = line[len(SESSION_EVENT_PREFIX) :].strip()
            break

    if not session_url:
        response.close()
        raise RuntimeError("Did not receive session endpoint from SSE stream.")

    return session_url, response


def wait_for_json_message(response: Any, timeout: float) -> Dict[str, Any]:
    """
    Read the next JSON message from the SSE stream.
    """
    try:
        raw_sock = response.fp.raw  # type: ignore[attr-defined]
        if hasattr(raw_sock, "settimeout"):
            raw_sock.settimeout(timeout)
    except Exception:
        pass

    event_type: Optional[str] = None
    data_lines: list[str] = []

    while True:
        raw_line = response.readline()
        if not raw_line:
            raise RuntimeError("SSE stream closed unexpectedly.")

        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")

        if line.startswith("event:"):
            event_type = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:") :].strip())
        elif line == "":
            if data_lines:
                payload = "\n".join(data_lines)
                data_lines.clear()
                if event_type != "message":
                    event_type = None
                    continue
                if payload:
                    try:
                        return json.loads(payload)
                    except json.JSONDecodeError:
                        return {"raw": payload}
            event_type = None


def post_json(url: str, payload: Dict[str, Any], api_key: Optional[str], timeout: float) -> Dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    request = urllib.request.Request(url, headers=headers, data=data, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            if body:
                text = body.decode("utf-8").strip()
                if text:
                    try:
                        return json.loads(text)
                    except json.JSONDecodeError:
                        return {"raw": text}
            return {}
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} {error.reason}: {details}") from error


def pretty_print(title: str, content: Dict[str, Any]) -> None:
    print(f"\n=== {title} ===")
    print(json.dumps(content, indent=2, ensure_ascii=False))


def main() -> int:
    args = parse_args()
    if not args.api_key:
        print("Error: API key must be provided via --api-key or MCP_API_KEY env var.", file=sys.stderr)
        return 1

    base_url = args.base_url.rstrip("/")
    print(f"Connecting to {base_url} …")
    session_endpoint, sse_response = read_session_endpoint(base_url, args.api_key, args.timeout)
    print(f"Session messages endpoint: {session_endpoint}")

    initialize_payload = {
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": DEFAULT_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "mcp-test-script", "version": "0.1.0"},
        },
    }
    init_response = post_json(session_endpoint, initialize_payload, args.api_key, args.timeout)
    pretty_print("Initialize response (HTTP acknowledgement)", init_response)
    init_result = wait_for_json_message(sse_response, args.timeout)
    pretty_print("Initialize result (SSE)", init_result)

    initialized_payload = {
        "jsonrpc": "2.0",
        "method": "initialized",
        "params": {},
    }
    post_json(session_endpoint, initialized_payload, args.api_key, args.timeout)
    print("Sent initialized notification.")

    tools_payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
    }
    tools_ack = post_json(session_endpoint, tools_payload, args.api_key, args.timeout)
    pretty_print("Tools list (HTTP acknowledgement)", tools_ack)
    tools_response = wait_for_json_message(sse_response, args.timeout)
    pretty_print("Tools list (SSE)", tools_response)

    prompts_payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "prompts/list",
    }
    prompts_ack = post_json(session_endpoint, prompts_payload, args.api_key, args.timeout)
    pretty_print("Prompts list (HTTP acknowledgement)", prompts_ack)
    prompts_response = wait_for_json_message(sse_response, args.timeout)
    pretty_print("Prompts list (SSE)", prompts_response)

    print("\nMCP handshake and queries completed successfully.")
    try:
        sse_response.close()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
