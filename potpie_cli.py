#!/usr/bin/env python3
"""
Potpie CLI — local development command-line interface.
Issue: potpie-ai/potpie #224 (Algora bounty)

Usage:
    potpie start                # Start the potpie server
    potpie stop                 # Stop the potpie server
    potpie parse <repo-path>    # Parse a repository
    potpie chat <project-id>    # Start interactive chat with an agent
"""

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import httpx

DEFAULT_HOST = "http://localhost:8000"
DEFAULT_AGENT = "codebase-qa"


def cmd_start(args):
    """Start the potpie server (gunicorn + celery worker)."""
    print("Starting potpie server...")

    # Start gunicorn
    gunicorn = subprocess.Popen(
        ["gunicorn", "app.main:app", "--workers", "2", "--bind", "0.0.0.0:8000",
         "--timeout", "120", "--graceful-timeout", "30"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )

    # Start celery worker
    celery = subprocess.Popen(
        ["celery", "-A", "app.core.celery_app", "worker", "--loglevel=info", "--concurrency=2"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )

    # Write PID file
    pidfile = Path(".potpie.pid")
    pidfile.write_text(f"{gunicorn.pid}\n{celery.pid}\n")

    print(f"Server started (PID: {gunicorn.pid})")
    print(f"Celery worker started (PID: {celery.pid})")
    print(f"API: {DEFAULT_HOST}")
    print("Run 'potpie stop' to shut down.")


def cmd_stop(args):
    """Stop the potpie server."""
    pidfile = Path(".potpie.pid")
    if not pidfile.exists():
        print("No running potpie instance found (.potpie.pid missing)")
        return

    pids = pidfile.read_text().strip().split("\n")
    for pid_str in pids:
        try:
            pid = int(pid_str)
            os.kill(pid, 15)  # SIGTERM
            print(f"Stopped process {pid}")
        except (ValueError, ProcessLookupError):
            pass

    pidfile.unlink(missing_ok=True)
    print("Potpie stopped.")


def cmd_parse(args):
    """Submit a repository for parsing and wait for completion."""
    repo_path = Path(args.repo_path)
    if not repo_path.exists():
        print(f"Error: repository path not found: {repo_path}", file=sys.stderr)
        sys.exit(1)

    branch = args.branch or _detect_branch(repo_path)
    print(f"Parsing repository: {repo_path} (branch: {branch})")

    client = httpx.Client(base_url=args.host, timeout=httpx.Timeout(600.0))

    # Submit for parsing
    try:
        resp = client.post("/api/v1/parse", json={
            "repo_path": str(repo_path.absolute()),
            "branch": branch,
        })
        resp.raise_for_status()
        project = resp.json()
        project_id = project["id"]
        print(f"Project created: {project_id}")
    except httpx.HTTPError as e:
        print(f"Error submitting project: {e}", file=sys.stderr)
        sys.exit(1)

    # Poll status until complete
    print("Parsing...", end="", flush=True)
    dots = 0
    while True:
        time.sleep(2)
        dots += 1
        if dots % 5 == 0:
            print(".", end="", flush=True)

        try:
            status_resp = client.get(f"/api/v1/projects/{project_id}/status")
            status_resp.raise_for_status()
            status = status_resp.json()
        except httpx.HTTPError:
            continue

        state = status.get("state", "unknown")
        if state == "completed":
            print(" Done!")
            print(f"Project ID: {project_id}")
            break
        elif state == "failed":
            print(" Failed!")
            print(f"Error: {status.get('error', 'Unknown error')}", file=sys.stderr)
            sys.exit(1)

    client.close()


def cmd_chat(args):
    """Start an interactive chat session with a potpie agent."""
    project_id = args.project_id
    agent = args.agent
    branch = args.branch

    client = httpx.Client(base_url=args.host, timeout=httpx.Timeout(120.0))

    # Validate project readiness
    try:
        resp = client.get(f"/api/v1/projects/{project_id}/status")
        resp.raise_for_status()
        status = resp.json()
        if status.get("state") != "completed":
            print(f"Error: project {project_id} is not ready (state: {status.get('state')})", file=sys.stderr)
            print("Run 'potpie parse' first.", file=sys.stderr)
            sys.exit(1)
    except httpx.HTTPError as e:
        print(f"Error checking project status: {e}", file=sys.stderr)
        sys.exit(1)

    # Start conversation
    session_id = None
    try:
        conv_resp = client.post("/api/v1/chat", json={
            "project_id": project_id,
            "agent_name": agent,
            "branch": branch,
        })
        conv_resp.raise_for_status()
        session = conv_resp.json()
        session_id = session.get("session_id")
    except httpx.HTTPError as e:
        print(f"Error starting conversation: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Chat with {agent} (project: {project_id})")
    print("Type /help for commands, /quit to exit.\n")

    while True:
        try:
            user_input = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not user_input:
            continue

        if user_input == "/quit":
            print("Goodbye!")
            break
        elif user_input == "/help":
            print("Commands: /quit (exit), /help (this message), /clear (clear screen)")
            continue
        elif user_input == "/clear":
            os.system("clear" if os.name != "nt" else "cls")
            continue

        # Send to agent
        try:
            chat_resp = client.post("/api/v1/chat/message", json={
                "session_id": session_id,
                "message": user_input,
            })
            chat_resp.raise_for_status()
            reply = chat_resp.json()
            print(f"\n{reply.get('response', '[No response]')}\n")
        except httpx.HTTPError as e:
            print(f"Error: {e}", file=sys.stderr)

    client.close()


def _detect_branch(repo_path: Path) -> str:
    """Detect the current git branch of a repository."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=repo_path, capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return "main"


def main():
    parser = argparse.ArgumentParser(description="Potpie CLI — local development tool")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Potpie API host (default: http://localhost:8000)")

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("start", help="Start the potpie server")
    sub.add_parser("stop", help="Stop the potpie server")

    parse_p = sub.add_parser("parse", help="Parse a repository")
    parse_p.add_argument("repo_path", help="Path to the repository")
    parse_p.add_argument("--branch", "-b", help="Git branch (auto-detected if omitted)")

    chat_p = sub.add_parser("chat", help="Chat with a potpie agent")
    chat_p.add_argument("project_id", help="Project ID from 'potpie parse'")
    chat_p.add_argument("--agent", "-a", default=DEFAULT_AGENT,
                        help=f"Agent name (default: {DEFAULT_AGENT})")
    chat_p.add_argument("--branch", "-b", help="Git branch")

    args = parser.parse_args()

    commands = {
        "start": cmd_start,
        "stop": cmd_stop,
        "parse": cmd_parse,
        "chat": cmd_chat,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
